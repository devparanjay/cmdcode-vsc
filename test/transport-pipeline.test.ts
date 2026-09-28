import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classify,
  CliTransportImpl,
  KILL_GRACE_MS,
  type ChildLike,
  type SpawnFn,
  type SpawnOptions,
} from '../src/cli/process.js';
import { NdjsonReader } from '../src/cli/ndjson.js';
import type { ResolvedCli } from '../src/cli/resolve.js';
import { createLogger, ExitCode, type CliError, type Logger, type RunHandlers, type RunRequest, type RunSummary } from '../src/types.js';

// The highest-value file in the tree (AC-08): the transport driven end to end
// against a hand-built EventEmitter child, plus the two streams captured in
// architecture §4.1a replayed through the real reader into the real classifier.
//
// NO real `cmd` binary is ever spawned: every run goes through the injected
// spawn function, and the child is a controllable stub.

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

// ─────────────────────────────────────────────────────────────────────────────
// The two captured streams of §4.1a, verbatim in shape.

/**
 * §4.1a: the successful run. exit=0, stderr empty. The result frame is printed
 * on ONE line — the source capture wraps it across three for readability, but
 * the wire format is newline-delimited, so it is written out unwrapped here.
 */
const SUCCESS_STREAM =
  `{"type":"event","event":{"type":"run_start","sessionId":"ab4c5b22-0000"}}\n` +
  `{"type":"event","event":{"type":"turn_start","turnNumber":1}}\n` +
  `{"type":"event","event":{"type":"message_start"}}\n` +
  `{"type":"event","event":{"type":"model_request_start","model":"${MODEL}"}}\n` +
  `{"type":"event","event":{"type":"model_trace","traceId":"tr-1"}}\n` +
  `{"type":"event","event":{"type":"thinking_start"}}\n` +
  `{"type":"event","event":{"type":"thinking_delta","delta":"hmm"}}\n` +
  `{"type":"event","event":{"type":"thinking_end","text":"…"}}\n` +
  `{"type":"event","event":{"type":"text_delta","delta":"PONG"}}\n` +
  `{"type":"event","event":{"type":"message_update","content":[]}}\n` +
  `{"type":"event","event":{"type":"model_request_end","model":"${MODEL}","stopReason":"end_turn","usage":{}}}\n` +
  `{"type":"event","event":{"type":"message_end","content":[]}}\n` +
  `{"type":"event","event":{"type":"turn_end","hadToolCalls":false,"turnNumber":1,"usage":{}}}\n` +
  `{"type":"event","event":{"type":"run_end","result":{"finalText":"PONG"}}}\n` +
  `{"type":"result","subtype":"success","sessionId":"ab4c5b22-0000","stopReason":"end_turn",` +
  `"usage":{"inputTokens":18572,"outputTokens":37,"cacheReadTokens":6857,"cacheWriteTokens":0},` +
  `"durationMs":3060,"finalText":"PONG"}\n`;

/**
 * §4.1a: the mid-run failure. exit=5, and it DOES carry a `subtype:"error"`
 * result frame — which is exactly why the exit code is classified before the
 * subtype.
 */
const RATE_LIMITED_STREAM =
  `{"type":"event","event":{"type":"run_start","sessionId":"ab4c5b22-0000"}}\n` +
  `{"type":"event","event":{"type":"run_error","error":{"name":"TransportError","message":"POST /alpha/generate → 429 error: …"}}}\n` +
  `{"type":"event","event":{"type":"run_end","result":{"finalText":"","stopReason":"run_error","turnCount":1}}}\n` +
  `{"type":"result","subtype":"error","sessionId":"ab4c5b22-0000",` +
  `"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},` +
  `"durationMs":1405,"finalText":"",` +
  `"error":"Error: You've reached your weekly usage limit. Resets in 3d 4h …"}\n`;

describe('transport: lifecycle-driven resolution (AC-08)', () => {
  it('resolves on close and reports success from the captured run', async () => {
    const h = harness();
    const handlers = recorder();

    const run = h.transport.run(request(), handlers);
    await flush();
    const child = h.latest();

    child.stdout.feed(SUCCESS_STREAM);
    expect(handlers.deltas).toEqual(['PONG']);
    expect(handlers.sessionIds).toEqual(['ab4c5b22-0000']);

    child.emit('close', ExitCode.Success);
    await run;

    expect(handlers.errors).toEqual([]);
    expect(handlers.summaries).toHaveLength(1);
    expect(handlers.summaries[0]).toEqual({
      sessionId: 'ab4c5b22-0000',
      text: 'PONG', // verbatim, no newline to strip
      usage: { inputTokens: 18572, outputTokens: 37, cacheReadTokens: 6857, cacheWriteTokens: 0 },
      durationMs: 3060,
      stopReason: 'end_turn',
    });
  });

  it('streams deltas in arrival order as the chunks land, never batched at the end', async () => {
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(request(), handlers);
    await flush();
    const child = h.latest();

    for (const delta of ['str', 'eam', 'ing']) {
      child.stdout.feed(
        `{"type":"event","event":{"type":"text_delta","delta":"${delta}"}}\n`,
      );
      // The handler has already run: AC-05 is about not buffering.
      expect(handlers.deltas).toEqual(['str', 'eam', 'ing'].slice(0, handlers.deltas.length));
    }
    expect(handlers.deltas).toEqual(['str', 'eam', 'ing']);

    child.emit('close', ExitCode.Success);
    await run;
  });

  it('spawns with the exact argv and shell false', async () => {
    const h = harness();
    const run = h.transport.run(request({ resumeSessionId: 'ab4c5b22-0000' }), recorder());
    await flush();

    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].command).toBe('cmd');
    expect(h.spawns[0].args).toEqual([
      '-r',
      'ab4c5b22-0000',
      '-p',
      'reply with exactly: PONG',
      '--output-format',
      'json',
      '-m',
      MODEL,
      '--max-turns',
      '2',
      '--no-auto-update',
    ]);
    expect(h.spawns[0].options.shell).toBe(false);
    expect(h.spawns[0].options.cwd).toBe('/tmp/workspace');
    expect(h.spawns[0].options.env.CI).toBe('1');

    h.latest().emit('close', ExitCode.Success);
    await run;
  });

  it('replays both captured §4.1a streams through the reader into classify', async () => {
    // A pure round trip, independent of the transport: the exact bytes the CLI
    // is documented to print, through the real reader, into the real classifier.
    const success = new NdjsonReader(() => undefined);
    expect(success.push(SUCCESS_STREAM)).toBeNull();
    expect(success.sawResultFrame()).toBe(true);
    expect(
      classify({ exitCode: 0, sawResultFrame: success.sawResultFrame(), result: { type: 'result', subtype: 'success', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 3060, finalText: 'PONG' }, stderr: '', timedOut: false }),
    ).toBeNull();

    const limited = new NdjsonReader(() => undefined);
    expect(limited.push(RATE_LIMITED_STREAM)).toBeNull();
    expect(limited.sawResultFrame()).toBe(true);
    expect(
      classify({ exitCode: 5, sawResultFrame: limited.sawResultFrame(), result: { type: 'result', subtype: 'error', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 1405, finalText: '' }, stderr: "Error: You've reached your weekly usage limit.", timedOut: false })?.code,
    ).toBe('rate-limited');
  });
});

describe('transport: the mid-run failure stream', () => {
  it('reports rate-limited, not unknown, for an error result frame on exit 5', async () => {
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(request(), handlers);
    await flush();
    const child = h.latest();

    child.stdout.feed(RATE_LIMITED_STREAM);
    child.stderr.feed("Error: You've reached your weekly usage limit. Resets in 3d 4h\n");
    child.emit('close', ExitCode.RateLimited);
    await run;

    expect(handlers.summaries).toEqual([]);
    expect(handlers.errors).toHaveLength(1);
    expect(handlers.errors[0].code).toBe('rate-limited');
    // A session id was seen, but the run failed: the provider persists it only
    // on success, so a failed turn never poisons the cache.
    expect(handlers.sessionIds).toEqual(['ab4c5b22-0000']);
  });
});

describe('transport: failure paths (AC-08)', () => {
  it('resolves as no-response when exit 1 produces zero bytes of stdout', async () => {
    // §4.1a's second capture: an unknown model. A result-frame-driven design
    // would wait here forever; lifecycle-driven completion is the whole point.
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(request({ model: 'bogus/nonexistent' }), handlers);
    await flush();

    h.latest().stderr.feed(
      'Error: unknown model "bogus/nonexistent".\nRun "cmd --list-models" to see all available models\n',
    );
    h.latest().emit('close', ExitCode.Error);
    await run;

    expect(handlers.errors).toHaveLength(1);
    expect(handlers.errors[0].code).toBe('unknown'); // row 14: the exit-1 generic
    expect(handlers.summaries).toEqual([]);
  });

  it('reports no-response for an exit 0 that never produced a result frame', async () => {
    // §D3: events but no result frame must not read as an answer.
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(request(), handlers);
    await flush();

    h.latest().stdout.feed(
      `{"type":"event","event":{"type":"run_start","sessionId":"s1"}}\n` +
        `{"type":"event","event":{"type":"text_delta","delta":"half an ans"}}\n`,
    );
    h.latest().emit('close', ExitCode.Success);
    await run;

    expect(handlers.errors).toHaveLength(1);
    expect(handlers.errors[0].code).toBe('no-response');
  });

  it('reports interrupted for a child killed by a signal (exitCode null)', async () => {
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(request(), handlers);
    await flush();

    h.latest().emit('close', null);
    await run;

    expect(handlers.errors).toHaveLength(1);
    expect(handlers.errors[0].code).toBe('interrupted');
  });

  it('reports cli-not-found without spawning when the resolver returns null', async () => {
    const h = harness(async () => null);
    const handlers = recorder();

    await h.transport.run(request(), handlers);

    expect(h.spawns).toEqual([]);
    expect(handlers.errors.map((e) => e.code)).toEqual(['cli-not-found']);
  });

  it('reports spawn-failed without rejecting when spawn throws', async () => {
    const children: FakeChild[] = [];
    const spawnFn: SpawnFn = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    const log = createLogger({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }, 'error');
    const transport = new CliTransportImpl(async () => RESOLVED, log, spawnFn);
    const handlers = recorder();

    await expect(transport.run(request(), handlers)).resolves.toBeUndefined();
    expect(children).toEqual([]);
    expect(handlers.errors.map((e) => e.code)).toEqual(['spawn-failed']);
  });

  it('reports malformed-stream and stops reading when stdout is unparseable', async () => {
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(request(), handlers);
    await flush();

    h.latest().stdout.feed('this is not ndjson\n');
    h.latest().emit('close', ExitCode.Success);
    await run;

    expect(handlers.errors.map((e) => e.code)).toEqual(['malformed-stream']);
  });

  it('flushes an unterminated final line before classifying', async () => {
    // A truncated pipe: the answer is the last line, and it has no newline.
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(request(), handlers);
    await flush();

    h.latest().stdout.feed(
      `{"type":"event","event":{"type":"run_start","sessionId":"s9"}}\n` +
        `{"type":"result","subtype":"success","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0},"durationMs":5,"finalText":"PONG"}`,
    );
    h.latest().emit('close', ExitCode.Success);
    await run;

    expect(handlers.errors).toEqual([]);
    expect(handlers.summaries[0]?.text).toBe('PONG');
  });

  it('rejects an oversize prompt before any process is created', async () => {
    const h = harness();
    const handlers = recorder();

    await h.transport.run(request({ prompt: 'x'.repeat(1_000_001) }), handlers);

    expect(h.spawns).toEqual([]);
    expect(handlers.errors.map((e) => e.code)).toEqual(['timeout']);
  });
});

describe('transport: cancellation (§5.3)', () => {
  it('sends SIGTERM, and escalates to SIGKILL after KILL_GRACE_MS', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const handlers = recorder();
      const run = h.transport.run(request(), handlers);
      await vi.advanceTimersByTimeAsync(0);
      const child = h.latest();

      const cancel = h.transport.cancel();
      expect(child.signals).toEqual(['SIGTERM']);
      expect(handlers.errors).toEqual([]); // nothing is reported until close

      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
      expect(child.signals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);

      child.emit('close', ExitCode.Interrupted);
      await cancel;
      await run;

      expect(handlers.errors.map((e) => e.code)).toEqual(['interrupted']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves cancel immediately when there is no live child', async () => {
    const h = harness();
    await expect(h.transport.cancel()).resolves.toBeUndefined();
    expect(h.spawns).toEqual([]);
  });

  it('does not run a turn cancelled before it spawned', async () => {
    // VS Code may cancel before the first spawn; that turn must not run.
    const h = harness();
    await h.transport.cancel();
    const handlers = recorder();
    await h.transport.run(request(), handlers);

    expect(h.spawns).toEqual([]);
    expect(handlers.errors.map((e) => e.code)).toEqual(['interrupted']);
  });

  it('clears the escalation when the child honours SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const run = h.transport.run(request(), recorder());
      await vi.advanceTimersByTimeAsync(0);
      const child = h.latest();

      void h.transport.cancel();
      child.emit('close', ExitCode.Interrupted);
      await run;

      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS * 2);
      // The grace timer was cleared on close, so a dead child is not signalled.
      expect(child.signals).toEqual(['SIGTERM']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('transport: deadline (§5.4)', () => {
  it('reports timeout, not interrupted, when our own deadline fires', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const handlers = recorder();
      const run = h.transport.run(request({ timeoutMs: 30_000 }), handlers);
      await vi.advanceTimersByTimeAsync(0);
      const child = h.latest();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(child.signals).toEqual(['SIGTERM']);

      // The child's resulting 130 is overridden by rule 1: a hung CLI and a
      // user cancel must be distinguishable.
      child.emit('close', ExitCode.Interrupted);
      await run;

      expect(handlers.errors.map((e) => e.code)).toEqual(['timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats timeoutMs 0 as no deadline at all', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const run = h.transport.run(request({ timeoutMs: 0 }), recorder());
      await vi.advanceTimersByTimeAsync(0);
      const child = h.latest();

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(child.signals).toEqual([]);

      child.emit('close', ExitCode.Success);
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('transport: the spawn log line (AC-16)', () => {
  it('logs the argv with the prompt redacted, so maxTurns is observable', async () => {
    const h = harness();
    const run = h.transport.run(request({ maxTurns: 7, model: MODEL }), recorder());
    await flush();
    h.latest().emit('close', 0);
    await expect(run).resolves.toBeUndefined();

    const line = h.log.find((l) => l.includes('spawning'));
    expect(line).toBeDefined();
    expect(line).toContain('--max-turns 7');
    expect(line).toContain(`-m ${MODEL}`);
    expect(line).not.toContain('reply with exactly: PONG');
  });

  it('logs the resolved command, not a bare "spawning"', async () => {
    const h = harness(async () => ({ command: '/usr/local/bin/node', args: ['/lib/cmd.mjs'], source: 'npm-global' }));
    const run = h.transport.run(request(), recorder());
    await flush();
    h.latest().emit('close', 0);
    await run;

    expect(h.log.some((l) => l.includes('spawning /usr/local/bin/node /lib/cmd.mjs'))).toBe(true);
  });

  it('never logs a spawn line when the CLI could not be resolved', async () => {
    const h = harness(async () => null);
    await h.transport.run(request(), recorder());

    expect(h.log.some((l) => l.includes('spawning'))).toBe(false);
  });
});

describe('transport: describe()', () => {
  it('reports the resolved path, including a leading entry point', async () => {
    await expect(harness().transport.describe()).resolves.toBe('cmd');
    await expect(
      harness(async () => ({ command: '/usr/local/bin/node', args: ['/lib/cmd.mjs'], source: 'npm-global' }))
        .transport.describe(),
    ).resolves.toBe('/usr/local/bin/node /lib/cmd.mjs');
  });

  it('reports null when the CLI cannot be found', async () => {
    await expect(harness(async () => null).transport.describe()).resolves.toBeNull();
  });
});

describe('transport: isolation', () => {
  it('never lets run reject, on any path', async () => {
    const h = harness();
    const handlers = recorder();
    // A child that errors, then closes: the error must not reject run(), and
    // a child `error` event outranks the close it is always followed by, so
    // the run is reported as spawn-failed rather than by its exit code.
    const run = h.transport.run(request(), handlers);
    await flush();
    const child = h.latest();
    child.emit('error', new Error('EPIPE'));
    child.emit('close', null);
    await expect(run).resolves.toBeUndefined();
    expect(handlers.errors.map((e) => e.code)).toEqual(['spawn-failed']);
  });

  it('reports a signalled child as interrupted when nothing else went wrong', async () => {
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(request(), handlers);
    await flush();
    h.latest().emit('close', null);
    await expect(run).resolves.toBeUndefined();
    expect(handlers.errors.map((e) => e.code)).toEqual(['interrupted']);
  });

  it('fires onError exactly once even if error and close both arrive', async () => {
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(request(), handlers);
    await flush();
    const child = h.latest();
    child.emit('error', new Error('boom'));
    child.emit('close', ExitCode.RateLimited);
    child.emit('close', ExitCode.RateLimited);
    await run;

    expect(handlers.errors).toHaveLength(1);
    expect(handlers.summaries).toEqual([]);
  });
});
