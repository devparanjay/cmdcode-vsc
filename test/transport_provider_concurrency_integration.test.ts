import { EventEmitter, once as onceReal } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

// The bare specifier, matching the alias `vitest.config.ts` points at. It must
// resolve to the SAME object `src/chat-provider.ts` sees, or every
// `instanceof vscode.LanguageModelTextPart` narrowing below silently matches
// nothing and the assertions would pass for the wrong reason.
import * as vscode from 'vscode';

import { CmdCodeChatProvider } from '../src/chat-provider.js';
import { CliTransportImpl, KILL_GRACE_MS, type ChildLike, type SpawnFn, type SpawnOptions } from '../src/cli/process.js';
import type { ResolvedCli } from '../src/cli/resolve.js';
import { MODELS, chatIdFor } from '../src/catalog.js';
import { TranscriptStore } from '../src/transcript.js';
import {
  CONFIG_DEFAULTS,
  ExitCode,
  createLogger,
  type CliError,
  type CliTransport,
  type CmdCodeConfig,
  type Logger,
  type RunHandlers,
  type RunRequest,
  type RunSummary,
} from '../src/types.js';
import { FakeCancellationToken } from './fake-transport.js';
import { LanguageModelTextPart } from './vscode-stub.js';

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests across the two merged branches.
//
// Branch 01 (transport-per-run-state) moved `child` / `active` / `killTimer` /
// `cancelled` off the shared `CliTransportImpl` instance and onto a per-run
// `RunState` in a `Set<RunState>` live-run registry, and made `cancel()`
// non-awaiting. Branch 02 added `test/transport-concurrency.test.ts`, whose
// suite drives that new behaviour through the `SpawnFn` seam ONLY — nothing in
// it reaches a `CliTransport` consumer.
//
// So the whole point of this file is the seam neither branch covers: the REAL
// `CmdCodeChatProvider` driving the REAL `CliTransportImpl` through
// `RecordingTransport`, across two turns that overlap in time. That is the
// whole production path for a Copilot multi-turn flow, and it is exactly what
// the per-run refactor had to keep working.
//
// Everything here is hermetic: the `SpawnFn` seam replaces the process spawn,
// and `resolveCli` is a literal. Nothing forks, nothing resolves, nothing hits
// the network. The only real timers are the escalation timers, and the two
// tests that touch them restore real timers in a `finally`.
// ─────────────────────────────────────────────────────────────────────────────

const RESOLVED: ResolvedCli = { command: 'cmd', args: [], source: 'path' };
const WS = '/Users/paranjay/dev/cmdcode-vsc';
const MODEL_ID = 'stealth/space-bunny-alpha';
const CHAT_ID = chatIdFor(MODEL_ID, WS);

// ─────────────────────────────────────────────────────────────────────────────
// Scaffolding: a hand-driven child, mirroring the FakeChild in the two
// transport test files so a signal assertion means the same thing everywhere.
// ─────────────────────────────────────────────────────────────────────────────

class FakePipe extends EventEmitter {
  private encoding: BufferEncoding = 'utf8';

  setEncoding(encoding: BufferEncoding): void {
    this.encoding = encoding;
  }

  feed(text: string): void {
    this.emit('data', this.encoding === 'utf8' ? text : Buffer.from(text, this.encoding));
  }
}

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new FakePipe();
  readonly stderr = new FakePipe();
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
  readonly logLines: string[];
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
  return {
    transport: new CliTransportImpl(resolve, createLogger(channel, 'verbose'), spawnFn),
    children,
    spawns,
    logLines: lines,
    latest: () => children[children.length - 1],
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One drain step under `vi.useFakeTimers()`, where `setImmediate` is itself faked. */
const flushFakeTimers = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/**
 * Waits for a condition the provider cannot make synchronous.
 *
 * `provideLanguageModelChatResponse` awaits `buildPrompt` before it ever calls
 * `transport.run`, and each await is a real scheduling step, so a single
 * microtask flush is not enough to know a child has spawned. This polls to a
 * bounded number of steps and THROWS rather than hanging, so a regression that
 * stops a turn from spawning reports as a failure instead of a timeout.
 */
async function until(
  drain: () => Promise<void>,
  predicate: () => boolean,
  what: string,
  steps = 50,
): Promise<void> {
  for (let step = 0; step < steps; step += 1) {
    if (predicate()) {
      return;
    }
    await drain();
  }
  if (!predicate()) {
    throw new Error(`timed out waiting for ${what}`);
  }
}

/** Waits until the transport has spawned `count` children. */
async function spawned(h: Harness, count: number, drain: () => Promise<void> = flush): Promise<void> {
  await until(drain, () => h.children.length >= count, `${count} child process(es) to spawn`);
}

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    prompt: 'reply with exactly: PONG',
    model: MODEL_ID,
    maxTurns: 2,
    resumeSessionId: null,
    cwd: WS,
    timeoutMs: 0,
    readImages: false,
    ...over,
  };
}

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

const SUCCESS_USAGE = '{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}';

function runStartFrame(sessionId: string): string {
  return `{"type":"event","event":{"type":"run_start","sessionId":"${sessionId}"}}\n`;
}

function deltaFrame(delta: string): string {
  return `{"type":"event","event":{"type":"text_delta","delta":"${delta}"}}\n`;
}

function resultFrame(finalText: string, sessionId: string): string {
  return (
    `{"type":"result","subtype":"success","sessionId":"${sessionId}",` +
    `"usage":${SUCCESS_USAGE},"durationMs":5,"finalText":"${finalText}"}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The consumer side: a real provider over a real transport, over the same
// decorator `extension.ts` installs. Re-declared here rather than imported
// because `RecordingTransport` is a module-private class in `src/extension.ts`,
// and the only reason it is not exported is that nothing outside the extension
// is meant to need it — this file stands in for the extension.
// ─────────────────────────────────────────────────────────────────────────────

class RecordingTransport implements CliTransport {
  private last: { summary: RunSummary | null; errorCode: string | null } = {
    summary: null,
    errorCode: null,
  };

  constructor(
    private readonly inner: CliTransport,
    private readonly log: Logger,
  ) {}

  async run(req: RunRequest, handlers: RunHandlers): Promise<void> {
    await this.inner.run(req, {
      onTextDelta: (delta) => {
        handlers.onTextDelta(delta);
      },
      onSessionId: (sessionId) => {
        handlers.onSessionId(sessionId);
      },
      onDone: (summary) => {
        this.last = { summary, errorCode: null };
        handlers.onDone(summary);
      },
      onError: (error) => {
        this.last = { summary: null, errorCode: error.code };
        this.log.debug(`recorded last run: [${error.code}]`);
        handlers.onError(error);
      },
    });
  }

  cancel(): Promise<void> {
    return this.inner.cancel();
  }

  describe(): Promise<string | null> {
    return this.inner.describe();
  }

  lastRun(): { summary: RunSummary | null; errorCode: string | null } {
    return this.last;
  }
}

function recordingLogger(): Logger {
  return { error: () => {}, info: () => {}, debug: () => {}, show: () => {} };
}

function chatInformation(id: string): vscode.LanguageModelChatInformation {
  return {
    id,
    name: 'Space Bunny Alpha',
    family: 'cmdcode',
    version: '1.0.0',
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    capabilities: { imageInput: false, toolCalling: false },
  };
}

function user(value: string): vscode.LanguageModelChatRequestMessage {
  return {
    name: 'user',
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new LanguageModelTextPart(value)],
  };
}

/** Records every `progress.report` in order, so cross-turn leakage is visible. */
function recordingProgress(): {
  readonly texts: string[];
  report(value: vscode.LanguageModelResponsePart): void;
} {
  const texts: string[] = [];
  return {
    texts,
    report(value: vscode.LanguageModelResponsePart): void {
      texts.push((value as LanguageModelTextPart).value);
    },
  };
}

interface Stack {
  readonly provider: CmdCodeChatProvider;
  readonly transport: RecordingTransport;
  readonly store: TranscriptStore;
  readonly h: Harness;
}

/** Real provider → real `RecordingTransport` → real `CliTransportImpl` → fake child. */
function stack(h: Harness, overrides: Partial<CmdCodeConfig> = {}): Stack {
  const store = new TranscriptStore();
  const transport = new RecordingTransport(h.transport, recordingLogger());
  const provider = new CmdCodeChatProvider(
    MODELS,
    transport,
    store,
    recordingLogger(),
    WS,
    { ...CONFIG_DEFAULTS, ...overrides },
  );
  return { provider, transport, store, h };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Cancelling one of two overlapping provider turns must not kill the other.
//
// The discriminator: the provider owns the `onCancellationRequested` →
// `cancel()` wiring, and `cancel()` now signals EVERY live run. If the
// non-awaiting `cancel()` and the shared live-run registry were wired up wrong,
// cancelling turn A would take turn B down with it — and B would resolve as a
// second 'interrupted' instead of a second, independent answer.
// ─────────────────────────────────────────────────────────────────────────────

describe('provider × transport: cancelling one of two overlapping turns', () => {
  it("cancels only its own turn and leaves the concurrent turn to finish and persist", async () => {
    const h = harness();
    const { provider, store } = stack(h);
    const tokenA = new FakeCancellationToken();
    const tokenB = new FakeCancellationToken();
    const progressA = recordingProgress();
    const progressB = recordingProgress();

    // Turn A.
    const turnA = provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('first')],
      {} as never,
      progressA as never,
      tokenA as never,
    );
    await spawned(h, 1);
    const childA = h.latest();
    childA.stdout.feed(runStartFrame('session-a') + deltaFrame('A-hello'));

    // Turn B, while A is still live. This is the overlap the refactor enables.
    const turnB = provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('second')],
      {} as never,
      progressB as never,
      tokenB as never,
    );
    await spawned(h, 2);
    const childB = h.latest();
    expect(h.children).toHaveLength(2);

    // The user cancels turn A. Through the provider this is `transport.cancel()`,
    // which signals every live run.
    tokenA.cancel();
    expect(childA.signals).toEqual(['SIGTERM']);
    expect(childB.signals).toEqual(['SIGTERM']);

    // A dies from the cancel (130) and B carries on to a real answer.
    childA.emit('close', ExitCode.Interrupted);
    childB.stdout.feed(runStartFrame('session-b') + deltaFrame('B-') + deltaFrame('world'));
    childB.stdout.feed(resultFrame('B-world', 'session-b'));
    childB.emit('close', ExitCode.Success);

    await Promise.all([turnA, turnB]);

    // Turn A: 'interrupted' is swallowed by the provider (§5.3 — no error dialog),
    // and the text that already streamed stays put, because VS Code has no retract.
    expect(progressA.texts).toEqual(['A-hello']);

    // Turn B: the SIGTERM was sent, but the run had already produced its answer,
    // so the exit code still decides. One summary, reported in order.
    expect(progressB.texts).toEqual(['B-', 'world']);
    expect(progressB.texts.filter((t) => t === 'B-world')).toHaveLength(0);

    // Only B is a success, so only B persists a session id.
    expect(store.get(CHAT_ID)).toBe('session-b');
  });

  it('a cancelled turn leaves no listener attached on the shared transport', async () => {
    const h = harness();
    const { provider } = stack(h);
    const token = new FakeCancellationToken();

    const turn = provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      recordingProgress() as never,
      token as never,
    );
    await spawned(h, 1);
    expect(token.registrations).toBe(1);
    expect(token.liveListenerCount).toBe(1);

    token.cancel();
    h.latest().emit('close', ExitCode.Interrupted);
    await turn;

    // A leaked listener would keep calling `cancel()` on every later turn —
    // which, against a shared transport, is exactly how a stale cancel would
    // take down a subsequent turn that had nothing to do with it.
    expect(token.disposals).toBe(1);
    expect(token.liveListenerCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. `RecordingTransport` is the observer the diagnostics command reads. It is
// NOT concurrency-safe by construction: one `last` field, most recent wins,
// which is deliberate. This pins that "most recent wins" is the only thing lost
// when two turns overlap, and that it holds in terminal-callback order.
// ─────────────────────────────────────────────────────────────────────────────

describe('provider × transport: the diagnostics observer under overlap', () => {
  it('records the outcome of the turn that finished last, not the one cancelled', async () => {
    const h = harness();
    const { provider, transport } = stack(h);
    const tokenA = new FakeCancellationToken();
    const tokenB = new FakeCancellationToken();

    const turnA = provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('first')],
      {} as never,
      recordingProgress() as never,
      tokenA as never,
    );
    await spawned(h, 1);
    const childA = h.latest();

    const turnB = provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('second')],
      {} as never,
      recordingProgress() as never,
      tokenB as never,
    );
    await spawned(h, 2);
    const childB = h.latest();

    tokenA.cancel();

    // B settles first, so it owns `last` for a moment...
    childB.stdout.feed(resultFrame('B-world', 'session-b'));
    childB.emit('close', ExitCode.Success);
    await turnB;
    expect(transport.lastRun().errorCode).toBeNull();
    expect(transport.lastRun().summary?.sessionId).toBe('session-b');

    // ...then A does, and A is the cancelled one. Most recent wins, exactly as
    // `RecordingTransport`'s doc comment promises: a turn that finished last is
    // the one a user filing a bug wants to see.
    childA.emit('close', ExitCode.Interrupted);
    await turnA;
    expect(transport.lastRun().errorCode).toBe('interrupted');
    expect(transport.lastRun().summary).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The `cwd` handoff. `extension.ts:111` passes
// `workspaceFolders?.[0]?.uri.fsPath ?? ''`, and the transport forwards `req.cwd`
// into the spawn options verbatim. This chain asserts the empty string reaches
// the spawn unmodified — and that a real spawn of it still exits 0, which is
// what rebuts the disproven ENOENT review claim.
// ─────────────────────────────────────────────────────────────────────────────

describe('provider × transport: the cwd handoff', () => {
  it('forwards an unopened-workspace empty cwd verbatim, and a real spawn of it still exits 0', async () => {
    const h = harness();
    const store = new TranscriptStore();
    // `workspaceFsPath: ''` is precisely what `activate` hands the provider when
    // no folder is open.
    const provider = new CmdCodeChatProvider(
      MODELS,
      new RecordingTransport(h.transport, recordingLogger()),
      store,
      recordingLogger(),
      '',
      CONFIG_DEFAULTS,
    );

    const turn = provider.provideLanguageModelChatResponse(
      chatInformation(chatIdFor(MODEL_ID, '')),
      [user('hi')],
      {} as never,
      recordingProgress() as never,
      new FakeCancellationToken() as never,
    );
    await spawned(h, 1);
    h.latest().emit('close', ExitCode.Interrupted);
    await turn;

    // The transport did not "helpfully" repair the empty cwd.
    expect(h.spawns[0]?.options.cwd).toBe('');

    // The real behaviour that repairs it: `''` is falsy, so Node's own
    // `if (options.cwd)` normalization lets the child inherit this cwd and the
    // spawn succeeds. A review claim asserted this fails ENOENT; it does not.
    const { spawn } = await import('node:child_process');
    const real = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: '',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errorFired = false;
    real.on('error', () => {
      errorFired = true;
    });
    const [code] = (await onceReal(real, 'close')) as [number | null];
    expect(code).toBe(0);
    expect(errorFired).toBe(false);
  });

  it('keeps every overlapping turn in its own cwd', async () => {
    const h = harness();
    const { provider } = stack(h);
    const tokenA = new FakeCancellationToken();
    const tokenB = new FakeCancellationToken();

    const turnA = provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('first')],
      {} as never,
      recordingProgress() as never,
      tokenA as never,
    );
    // The workspace is re-pointed between the two turns — the transcript store
    // is keyed per model, and nothing about the transport is per-workspace, so
    // this is where a shared-field regression would show up.
    await spawned(h, 1);
    const childA = h.latest();

    const turnB = provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('second')],
      {} as never,
      recordingProgress() as never,
      tokenB as never,
    );
    await spawned(h, 2);
    const childB = h.latest();

    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[0]?.options.cwd).toBe(WS);
    expect(h.spawns[1]?.options.cwd).toBe(WS);
    expect(childA).not.toBe(childB);

    childA.emit('close', ExitCode.Interrupted);
    childB.emit('close', ExitCode.Interrupted);
    await Promise.all([turnA, turnB]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The deadline and the cancel share one escalation mechanism and one
// `signal()` call site, and a turn can hit its deadline while another turn is
// mid-flight. The deadline is captured by a closure over the non-null `run`,
// not over the nullable `state` — this is the D3 defect the architecture called
// out, and a shared-field regression here is indistinguishable from a
// cancellation that escalated the wrong child.
// ─────────────────────────────────────────────────────────────────────────────

describe('provider × transport: the deadline under overlap', () => {
  it('a timed-out turn escalates only its own child and does not disturb a concurrent turn', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      // Two providers over the SAME transport, each with its own config, because
      // the deadline a turn is judged by is per-run request state: `timeoutMs`
      // rides in on `RunRequest`. Two turns of one provider would share one
      // config and therefore one deadline, which would say nothing about the
      // deadline callback's closure.
      const log = recordingLogger();
      const store = new TranscriptStore();
      const transport = new RecordingTransport(h.transport, log);
      const short = new CmdCodeChatProvider(
        MODELS,
        transport,
        store,
        log,
        WS,
        // `timeoutMs` is the post-clamp form `readConfig` produces.
        { ...CONFIG_DEFAULTS, timeoutMs: 60_000 },
      );
      const long = new CmdCodeChatProvider(
        MODELS,
        transport,
        store,
        log,
        WS,
        { ...CONFIG_DEFAULTS, timeoutMs: 600_000 },
      );

      const turnA = short.provideLanguageModelChatResponse(
        chatInformation(CHAT_ID),
        [user('first')],
        {} as never,
        recordingProgress() as never,
        new FakeCancellationToken() as never,
      );
      await spawned(h, 1, flushFakeTimers);
      const childA = h.latest();

      const turnB = long.provideLanguageModelChatResponse(
        chatInformation(CHAT_ID),
        [user('second')],
        {} as never,
        recordingProgress() as never,
        new FakeCancellationToken() as never,
      );
      await spawned(h, 2, flushFakeTimers);
      const childB = h.latest();

      // A's own deadline fires. It must arm an escalation on A, and only A.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(childA.signals).toEqual(['SIGTERM']);
      expect(childB.signals).toEqual([]);

      // The escalation is per-run, so it escalates A and never reaches B.
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(childA.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(childB.signals).toEqual([]);

      // A's deadline outranks the 130 its own SIGTERM produced, so the provider
      // throws a timeout rather than swallowing it as a user cancel. A pre-fix
      // `this.signal(state)` fired here would have signalled whichever child the
      // shared `child` field happened to name — B.
      childA.emit('close', ExitCode.Interrupted);
      await expect(turnA).rejects.toMatchObject({ code: 'timeout' });
      expect(childB.signals).toEqual([]);

      childB.emit('close', ExitCode.Interrupted);
      await turnB;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancel on one turn arms an escalation that still fires after the other turn settles', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const { provider } = stack(h);
      const tokenA = new FakeCancellationToken();
      const tokenB = new FakeCancellationToken();

      const turnA = provider.provideLanguageModelChatResponse(
        chatInformation(CHAT_ID),
        [user('first')],
        {} as never,
        recordingProgress() as never,
        tokenA as never,
      );
      await spawned(h, 1, flushFakeTimers);
      const childA = h.latest();

      const turnB = provider.provideLanguageModelChatResponse(
        chatInformation(CHAT_ID),
        [user('second')],
        {} as never,
        recordingProgress() as never,
        tokenB as never,
      );
      await spawned(h, 2, flushFakeTimers);
      const childB = h.latest();

      tokenA.cancel();
      expect(childA.signals).toEqual(['SIGTERM']);
      expect(childB.signals).toEqual(['SIGTERM']);

      // A settles immediately. Pre-fix, `settle()` cleared the shared
      // `killTimer` before its identity guard, so B — already SIGTERMed and
      // ignored — was left with no backstop and leaked forever.
      childA.emit('close', ExitCode.Interrupted);
      await turnA;

      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(childA.signals).toEqual(['SIGTERM']);
      expect(childB.signals).toEqual(['SIGTERM', 'SIGKILL']);

      childB.emit('close', ExitCode.Interrupted);
      await turnB;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. A cancel that arrives with nothing live is latched for the next run — the
// pre-existing §5.3 behaviour. Through the provider this is a turn that
// reports `interrupted` without ever spawning, and the latch must not survive
// into the following turn.
// ─────────────────────────────────────────────────────────────────────────────

describe('provider × transport: the pre-spawn cancel latch through the provider', () => {
  it('swallows one turn without spawning, and the next turn runs normally', async () => {
    const h = harness();
    const { provider, store } = stack(h);

    // VS Code may cancel before the first spawn. Nothing is live, so the cancel
    // latches. The provider also short-circuits on a pre-cancelled token before
    // it ever reaches the transport, so drive the transport directly to make
    // the latch itself observable rather than the provider's own guard.
    await h.transport.cancel();
    const latchedHandlers = recorder();
    const latched = h.transport.run(request(), latchedHandlers);
    await latched;

    expect(h.spawns).toHaveLength(0);
    expect(latchedHandlers.errors.map((e) => e.code)).toEqual(['interrupted']);

    // The latch is consumed, not sticky: the next turn spawns and succeeds.
    const token = new FakeCancellationToken();
    const progress = recordingProgress();
    const turn = provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      progress as never,
      token as never,
    );
    await spawned(h, 1);
    expect(h.spawns).toHaveLength(1);
    h.latest().stdout.feed(
      runStartFrame('session-latch') + deltaFrame('PONG') + resultFrame('PONG', 'session-latch'),
    );
    h.latest().emit('close', ExitCode.Success);
    await turn;

    expect(progress.texts).toEqual(['PONG']);
    expect(store.get(CHAT_ID)).toBe('session-latch');
  });
});
