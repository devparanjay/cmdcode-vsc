import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  CliTransportImpl,
  KILL_GRACE_MS,
  type ChildLike,
  type SpawnFn,
  type SpawnOptions,
} from '../src/cli/process.js';
import type { ResolvedCli } from '../src/cli/resolve.js';
import { createLogger, ExitCode, type CliError, type Logger, type RunHandlers, type RunRequest, type RunSummary } from '../src/types.js';

// The concurrency half of the transport (PR #1 review). Split from
// transport-pipeline.test.ts so the four regressions below are read against the
// same scaffolding the lifecycle tests use, with nothing shared between the
// files and nothing to keep in sync.
//
// The `FakePipe` / `FakeChild` / `SpawnRecord` / `Harness` block is a verbatim
// copy of transport-pipeline.test.ts lines 27-134 — file ownership, not
// preference, is why it is duplicated rather than extracted.
//
// Four of the six tests are DISCRIMINATING: against the pre-fix
// `CliTransportImpl` (one shared `child`, one shared escalation timer, one
// shared `cancelled` latch) AC-04/AC-05/AC-07 hang to the 5000 ms test timeout
// and AC-06 fails an assertion. The other two pin behaviour that was never
// broken and must pass in both states.

const RESOLVED: ResolvedCli = { command: 'cmd', args: [], source: 'path' };
const MODEL = 'stealth/space-bunny-alpha';

// ─────────────────────────────────────────────────────────────────────────────
// The fake child: an EventEmitter with the two pipes and a kill record.

/** A pipe that buffers what the transport wrote into `setEncoding`. */
class FakePipe extends EventEmitter {
  private encoding: BufferEncoding = 'utf8';

  setEncoding(encoding: BufferEncoding): void {
    this.encoding = encoding;
  }

  /** Deliver bytes to the transport, as a real pipe would. */
  feed(text: string): void {
    this.emit('data', this.encoding === 'utf8' ? text : Buffer.from(text, this.encoding));
  }
}

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new FakePipe();
  readonly stderr = new FakePipe();
  /** Every signal the transport sent, in order. */
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  killed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

interface Harness {
  readonly transport: CliTransportImpl;
  readonly children: FakeChild[];
  readonly spawns: SpawnRecord[];
  readonly log: string[];
  /** The child from the most recent spawn, for driving. */
  latest(): FakeChild;
}

function harness(resolve: () => Promise<ResolvedCli | null> = async () => RESOLVED): Harness {
  const children: FakeChild[] = [];
  const spawns: SpawnRecord[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    spawns.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const lines: string[] = [];
  const channel = {
    appendLine: (value: string) => lines.push(value),
    show: () => undefined,
    dispose: () => undefined,
  };
  const log: Logger = createLogger(channel, 'verbose');
  return {
    transport: new CliTransportImpl(resolve, log, spawnFn),
    children,
    spawns,
    log: lines,
    latest: () => children[children.length - 1],
  };
}

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    prompt: 'reply with exactly: PONG',
    model: MODEL,
    maxTurns: 2,
    resumeSessionId: null,
    cwd: '/tmp/workspace',
    readImages: false,
    timeoutMs: 0,
    ...over,
  };
}

/** Records every handler call so the terminal state is assertable. */
function recorder(): RunHandlers & {
  readonly deltas: string[];
  readonly sessionIds: string[];
  readonly errors: CliError[];
  readonly summaries: RunSummary[];
} {
  const deltas: string[] = [];
  const sessionIds: string[] = [];
  const errors: CliError[] = [];
  const summaries: RunSummary[] = [];
  return {
    deltas,
    sessionIds,
    errors,
    summaries,
    onTextDelta: (delta) => deltas.push(delta),
    onSessionId: (id) => sessionIds.push(id),
    onError: (error) => errors.push(error),
    onDone: (summary) => summaries.push(summary),
  };
}

/** Let queued microtasks and immediates drain. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('transport: concurrency (PR #1 review)', () => {
  it('cancel() signals every live run when two runs overlap', async () => {
    const h = harness();
    const runA = h.transport.run(request(), recorder());
    await flush();
    const childA = h.latest();
    const runB = h.transport.run(request(), recorder());
    await flush();
    const childB = h.latest();

    await h.transport.cancel();

    expect(childA.signals).toEqual(['SIGTERM']); // pre-fix: []
    expect(childB.signals).toEqual(['SIGTERM']); // pre-fix: ['SIGTERM']
    // Both children are closed here or the test leaks two pending promises
    // into the next one.
    childA.emit('close', ExitCode.Interrupted);
    childB.emit('close', ExitCode.Interrupted);
    await Promise.all([runA, runB]);
  });

  it('cancel() resolves without waiting for any child to close', async () => {
    const h = harness();
    const runA = h.transport.run(request(), recorder());
    await flush();
    const childA = h.latest();
    const runB = h.transport.run(request(), recorder());
    await flush();
    const childB = h.latest();

    childA.emit('close', ExitCode.Success);
    await runA; // A settles while B still streams

    let settled = false;
    void h.transport.cancel().then(() => {
      settled = true;
    });
    await flush();
    // The ORDER is the assertion: no `close` has been emitted on B above this
    // line, so a cancel that resolved here cannot have waited for it. Pre-fix
    // `settled` is still false, because cancel() awaits the live run.
    expect(settled).toBe(true);
    expect(childB.signals).toEqual(['SIGTERM']);
    // Close B only now, the way a real host's SIGKILL escalation eventually
    // would, so runB settles instead of leaking.
    childB.emit('close', ExitCode.Interrupted);
    await runB;
  });

  it("settling one run does not clear another run's SIGKILL escalation", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const runA = h.transport.run(request(), recorder());
      await vi.advanceTimersByTimeAsync(0);
      const childA = h.latest();
      const runB = h.transport.run(request(), recorder());
      await vi.advanceTimersByTimeAsync(0);
      const childB = h.latest();

      void h.transport.cancel(); // arms the 2000 ms escalation on BOTH A and B
      childA.emit('close', ExitCode.Interrupted);
      await runA; // A's settle must not touch B's timer

      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(childB.signals).toEqual(['SIGTERM', 'SIGKILL']); // pre-fix: ['SIGTERM']
      childB.emit('close', ExitCode.Interrupted);
      await runB;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancel during a live run does not latch against the next run', async () => {
    try {
      const h = harness();
      const runA = h.transport.run(request(), recorder());
      await flush();
      const childA = h.latest();
      await h.transport.cancel(); // A is live: signals A, must NOT latch
      childA.emit('close', ExitCode.Interrupted);
      await runA;

      const handlersB = recorder();
      const runB = h.transport.run(request(), handlersB);
      await flush();
      // B must emit a real result frame. Closing it at exit 0 with no frame
      // makes `classify` correctly report `no-response`, so `errors` would be
      // non-empty for a reason that has nothing to do with the latch.
      h.latest().stdout.feed(
        `{"type":"event","event":{"type":"run_start","sessionId":"s9"}}\n` +
          `{"type":"result","subtype":"success","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0},"durationMs":5,"finalText":"PONG"}`,
      );
      h.latest().emit('close', ExitCode.Success);
      await runB;

      expect(handlersB.errors).toEqual([]); // no 'interrupted'
      expect(handlersB.summaries).toHaveLength(1);
    } finally {
      // Harmless here — no fake timers are used — but it keeps a later edit
      // that adds one from leaking into the next file.
      vi.useRealTimers();
    }
  });

  it("concurrent runs deliver each run's deltas to its own handlers", async () => {
    const h = harness();
    const handlersA = recorder();
    const runA = h.transport.run(request(), handlersA);
    await flush();
    const childA = h.latest();
    const handlersB = recorder();
    const runB = h.transport.run(request(), handlersB);
    await flush();
    const childB = h.latest();

    childA.stdout.feed(`{"type":"event","event":{"type":"text_delta","delta":"SECRET-A"}}\n`);
    childB.stdout.feed(`{"type":"event","event":{"type":"text_delta","delta":"SECRET-B"}}\n`);
    expect(handlersA.deltas).toEqual(['SECRET-A']);
    expect(handlersB.deltas).toEqual(['SECRET-B']);

    childA.emit('close', ExitCode.Success);
    childB.emit('close', ExitCode.Success);
    await Promise.all([runA, runB]);
  });

  it('an empty cwd inherits the parent directory rather than failing the spawn', async () => {
    // Review claim #2 asserted cwd: '' fails ENOENT and asked for process.cwd().
    // DISPROVEN on this tree: '' is falsy, so it falls through Node's own
    // `if (options.cwd)` normalization and the child inherits the parent cwd.
    // This test uses the REAL spawn, not the injected SpawnFn, and exists only
    // to pin that, so the claim cannot be re-found.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: '',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errorFired = false;
    child.on('error', () => {
      errorFired = true;
    });

    const [code] = (await once(child, 'close')) as [number | null];
    expect(code).toBe(0); // NOT ENOENT
    expect(errorFired).toBe(false);
  });
});
