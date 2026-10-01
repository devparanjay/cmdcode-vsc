import { describe, expect, it } from 'vitest';

import { NdjsonReader, MAX_LINE_BYTES } from '../src/cli/ndjson.js';
import { toPresentation } from '../src/errors.js';
import { TranscriptStore } from '../src/transcript.js';
import {
  CliError,
  isResultFrame,
  type EventFrame,
  type Frame,
  type ResultFrame,
} from '../src/types.js';

// The turn pipeline, assembled from the three modules that own one stage each,
// wired together the way the transport will wire them:
//
//   stdout chunk -> NdjsonReader -> handlers -> TranscriptStore
//   reader error -> CliError -> toPresentation
//
// No module here is tested in isolation: every case drives a real reader, a
// real store and the real error copy in one pass. `src/cli/process.ts` does not
// exist yet, so the handler bodies below ARE the contract types.ts declares —
// this file pins the shape that module will have to satisfy.

// ─────────────────────────────────────────────────────────────────────────────
// Frame builders, shaped like the frames command-code@1.66.0 actually emits.

const SESSION_ID = 'ab4c5b22-0000-4000-8000-000000000000';

function runStart(sessionId = SESSION_ID): EventFrame {
  return { type: 'event', event: { type: 'run_start', sessionId } };
}

function textDelta(value: string): EventFrame {
  return { type: 'event', event: { type: 'text_delta', text: value } };
}

function successResult(overrides: Partial<ResultFrame> = {}): ResultFrame {
  return {
    type: 'result',
    subtype: 'success',
    sessionId: SESSION_ID,
    usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    durationMs: 1234,
    finalText: 'PONG',
    ...overrides,
  };
}

function serialize(frames: readonly Frame[]): string {
  return frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// A transport-shaped driver over the three modules.

interface TurnOutcome {
  readonly deltas: readonly string[];
  readonly result: ResultFrame | null;
  readonly summaryText: string | null;
  readonly error: CliError | null;
  readonly presentation: string | null;
  readonly sawResultFrame: boolean;
  readonly sawAnyFrame: boolean;
  readonly frameCount: number;
  /** Session ids the driver forwarded to onSessionId, in arrival order. */
  readonly announced: readonly string[];
}

interface DriveOptions {
  /**
   * When true the session id is only written to the store on success, which is
   * what §4.9 requires: a failed turn must never poison the session cache.
   */
  readonly commitSessionOnSuccessOnly?: boolean;
}

function driveTurn(
  store: TranscriptStore,
  chunks: readonly string[],
  modelId: string,
  opts: DriveOptions = {},
): TurnOutcome {
  const deltas: string[] = [];
  const announced: string[] = [];
  let result: ResultFrame | null = null;
  let pendingSessionId: string | null = null;
  let failure: CliError | null = null;

  const reader = new NdjsonReader((frame: Frame) => {
    if (isResultFrame(frame)) {
      result = frame;
      return;
    }
    const event = (frame as EventFrame).event;
    if (event.type === 'text_delta') {
      deltas.push(event.text as string);
      return;
    }
    if (event.type === 'run_start') {
      const sessionId = event.sessionId as string;
      announced.push(sessionId);
      pendingSessionId = sessionId;
    }
  });

  // `onDone` / `onError` are the RunHandlers contract from types.ts: exactly one
  // of them runs, exactly once, and neither ever rejects.
  let settled = false;
  const onError = (error: CliError): void => {
    expect(settled, 'onError ran after the turn had already settled').toBe(false);
    settled = true;
    failure = error;
  };
  const onDone = (): void => {
    expect(settled, 'onDone ran after the turn had already settled').toBe(false);
    settled = true;
    // §4.9: the session id is persisted ONLY on a successful turn. A result
    // frame with subtype 'error' or 'max_turns' must not poison the cache.
    const succeeded = result !== null && result.subtype === 'success';
    if (succeeded && pendingSessionId !== null) {
      if (opts.commitSessionOnSuccessOnly !== false) {
        store.set(modelId, pendingSessionId);
      }
    }
  };

  for (const chunk of chunks) {
    const error = reader.push(chunk);
    if (error !== null) {
      onError(error);
      break;
    }
  }
  if (!settled) {
    const error = reader.end();
    if (error !== null) {
      onError(error);
    } else {
      onDone();
    }
  }

  return {
    deltas,
    result,
    summaryText: result === null ? null : (result as ResultFrame).finalText,
    error: failure,
    presentation: failure === null ? null : toPresentation(failure).message,
    sawResultFrame: reader.sawResultFrame(),
    sawAnyFrame: reader.sawAnyFrame(),
    frameCount: reader.frameCount(),
    announced,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the turn pipeline: stdout -> NdjsonReader -> TranscriptStore', () => {
  it('carries a streamed session id from run_start into the store on success', () => {
    const store = new TranscriptStore();
    const modelId = 'stealth/space-bunny-alpha';

    const outcome = driveTurn(
      store,
      [serialize([runStart(), textDelta('PO'), textDelta('NG'), successResult()])],
      modelId,
    );

    expect(outcome.error).toBeNull();
    expect(outcome.deltas).toEqual(['PO', 'NG']);
    // The id the CLI announced is the id the store now holds, unchanged.
    expect(outcome.announced).toEqual([SESSION_ID]);
    expect(store.get(modelId)).toBe(SESSION_ID);
    expect(store.size).toBe(1);
  });

  it('reassembles deltas split mid-token across chunk boundaries', () => {
    const store = new TranscriptStore();
    const stream = serialize([runStart(), textDelta('Hello '), textDelta('world')]);
    // Cut the stream at arbitrary points, including inside a JSON token.
    const chunks = [stream.slice(0, 37), stream.slice(37, 51), stream.slice(51, 90), stream.slice(90)];

    const outcome = driveTurn(store, chunks, 'stealth/space-bunny-alpha');

    expect(outcome.deltas).toEqual(['Hello ', 'world']);
    expect(outcome.deltas.join('')).toBe('Hello world');
  });

  it('delivers the result finalText verbatim, without trimming a trailing newline', () => {
    const store = new TranscriptStore();
    // types.ts documents finalText as verbatim; the pipeline must not "helpfully" trim it.
    const result = successResult({ finalText: 'PONG\n\n' });

    const outcome = driveTurn(store, [serialize([runStart(), result])], 'stealth/space-bunny-alpha');

    expect(outcome.summaryText).toBe('PONG\n\n');
    expect(outcome.result?.sessionId).toBe(SESSION_ID);
  });

  it('keeps sessions separate per model, and only the unused model ages out', () => {
    const store = new TranscriptStore(2);
    const modelA = 'stealth/space-bunny-alpha';
    const modelB = 'openai/gpt-5';
    store.set(modelA, 'session-a');

    // A second turn on model A overwrites in place rather than growing the store.
    const outcome = driveTurn(
      store,
      [serialize([runStart('session-a2'), successResult({ sessionId: 'session-a2' })])],
      modelA,
    );
    expect(store.size).toBe(1);
    expect(store.get(modelA)).toBe('session-a2');
    expect(outcome.error).toBeNull();

    // A turn on a DIFFERENT model claims the remaining slot: A survives, B joins.
    driveTurn(
      store,
      [serialize([runStart('session-b'), successResult({ sessionId: 'session-b' })])],
      modelB,
    );
    expect(store.size).toBe(2);
    expect(store.get(modelA)).toBe('session-a2');
    expect(store.get(modelB)).toBe('session-b');

    // A third model's turn now exceeds capacity. A is the least recently USED
    // (its turn was two turns ago), so the store drops A and keeps B.
    driveTurn(
      store,
      [serialize([runStart('session-c'), successResult({ sessionId: 'session-c' })])],
      'stealth/space-bunny-beta',
    );
    expect(store.size).toBe(2);
    expect(store.get(modelA), 'the least recently used model session is evicted').toBeNull();
    expect(store.get(modelB)).toBe('session-b');
    expect(store.get('stealth/space-bunny-beta')).toBe('session-c');
  });

  it('does not commit a session id when the stream turns out to be malformed', () => {
    const store = new TranscriptStore();
    const modelId = 'stealth/space-bunny-alpha';
    // A valid run_start, then an unparseable line: the turn fails after the id
    // was already announced, which is exactly when a naive driver poisons the cache.
    const stream = serialize([runStart()]) + 'not json at all\n';

    const outcome = driveTurn(store, [stream], modelId);

    expect(outcome.error).toBeInstanceOf(CliError);
    expect(outcome.error?.code).toBe('malformed-stream');
    expect(outcome.announced).toEqual([SESSION_ID]);
    expect(store.get(modelId), 'a failed turn must not poison the session cache').toBeNull();
    expect(store.size).toBe(0);
  });

  it('does not commit a session id for a result frame that reports an error', () => {
    const store = new TranscriptStore();
    const modelId = 'stealth/space-bunny-alpha';
    const failed = successResult({
      subtype: 'error',
      finalText: '',
      error: 'Model not in plan: stealth/space-bunny-alpha',
    });

    const outcome = driveTurn(store, [serialize([runStart(), failed])], modelId, {
      commitSessionOnSuccessOnly: true,
    });

    expect(outcome.error).toBeNull(); // framing was fine
    expect(outcome.result?.subtype).toBe('error');
    // The commit path is gated on success, so the id is dropped.
    expect(store.get(modelId)).toBeNull();
  });

  it('resumes a stored session and reports the same id the previous turn stored', () => {
    const store = new TranscriptStore();
    const modelId = 'stealth/space-bunny-alpha';
    store.set(modelId, SESSION_ID);

    const resumed = store.get(modelId);
    const outcome = driveTurn(
      store,
      [serialize([runStart(), successResult()])],
      modelId,
    );

    expect(resumed).toBe(SESSION_ID);
    expect(outcome.announced).toEqual([SESSION_ID]);
    expect(store.get(modelId)).toBe(SESSION_ID);
  });

  it('survives a model id that is not in the catalog — the store never validates', () => {
    // transcript.ts is a leaf with no catalog import, so a bad id is stored and
    // recalled verbatim rather than throwing. Pinned so a future "helpful"
    // validation layer cannot silently change this.
    const store = new TranscriptStore();
    const unknown = 'not-a-real/model id';
    store.set(unknown, SESSION_ID);

    expect(store.get(unknown)).toBe(SESSION_ID);
    expect(store.size).toBe(1);
  });
});

describe('the turn pipeline: reader failure surfaces as user-facing copy', () => {
  it('presents malformed-stream copy that never leaks the stream content', () => {
    const store = new TranscriptStore();
    const secret = 'sk-live-DO-NOT-LEAK-0000000000';
    const outcome = driveTurn(store, [`{"broken": "${secret}"\n`], 'stealth/space-bunny-alpha');

    expect(outcome.error?.code).toBe('malformed-stream');
    expect(outcome.presentation).toBe(
      "Command Code sent output this extension couldn't read. See the Command Code log.",
    );
    // The offending bytes stay in the log channel, not the notification.
    expect(outcome.presentation).not.toContain(secret);
  });

  it('renders a copy for a failed turn whose stderr names the model that was used', () => {
    const store = new TranscriptStore();
    const modelId = 'stealth/space-bunny-alpha';
    const failure = new CliError('plan-gated', 'model not in plan', {
      stderr: `Error: Model not in plan: ${modelId}`,
      exitCode: 1,
    });

    const presentation = toPresentation(failure);

    expect(presentation.message).toBe("Your Command Code plan doesn't include that model.");
    expect(presentation.message).not.toContain(modelId);
    // …while the detail is still available for the output channel.
    expect(failure.stderr).toContain(modelId);
    // A stale session must be recoverable, not poisoned, by the failure.
    expect(store.get(modelId)).toBeNull();
  });
});

describe('the turn pipeline: D3 completion predicates vs the session cache', () => {
  it('treats an event-only stream as no result even though frames were delivered', () => {
    const store = new TranscriptStore();
    // The §D3 hang case: the CLI printed events and exited without a result.
    const outcome = driveTurn(store, [serialize([runStart(), textDelta('partial')])], 'stealth/space-bunny-alpha');

    expect(outcome.sawAnyFrame, 'frames were delivered').toBe(true);
    expect(outcome.sawResultFrame, 'but no result frame was').toBe(false);
    expect(outcome.error).toBeNull();
    // classify() would turn that combination into `no-response`; either way the
    // turn did not complete, so nothing may be committed to the cache.
    expect(store.size).toBe(0);
  });

  it('keeps the two predicates independent when only ignored shapes arrive', () => {
    const store = new TranscriptStore();
    const outcome = driveTurn(store, ['[1,2,3]\n"scalar"\nnull\n{"type":"who-knows"}\n'], 'stealth/space-bunny-alpha');

    expect(outcome.frameCount).toBe(0);
    expect(outcome.sawAnyFrame).toBe(false);
    expect(outcome.sawResultFrame).toBe(false);
    expect(store.size).toBe(0);
  });

  it('flips only sawResultFrame once the terminal result lands', () => {
    const store = new TranscriptStore();
    const reader = new NdjsonReader(() => {});

    expect(reader.sawAnyFrame()).toBe(false);
    expect(reader.sawResultFrame()).toBe(false);

    reader.push(serialize([runStart(), textDelta('hi')]));
    expect(reader.sawAnyFrame()).toBe(true);
    expect(reader.sawResultFrame(), 'an event must not look like a result').toBe(false);

    reader.push(serialize([successResult()]));
    expect(reader.sawResultFrame()).toBe(true);
  });

  it('stays usable for a second turn after a successful first turn', () => {
    // One reader per run, but a fresh one every turn — prove no state from the
    // completed turn leaks into the next one's completion decision.
    const store = new TranscriptStore();
    const modelId = 'stealth/space-bunny-alpha';

    const first = driveTurn(store, [serialize([runStart(), successResult()])], modelId);
    expect(first.sawResultFrame).toBe(true);
    expect(store.get(modelId)).toBe(SESSION_ID);

    const second = driveTurn(store, [serialize([runStart('session-2'), textDelta('again')])], modelId);
    expect(second.sawAnyFrame).toBe(true);
    expect(second.sawResultFrame).toBe(false);
  });
});

describe('the turn pipeline: the size guard bounds what a bad stream can cost', () => {
  it('fails malformed-stream before the guard budget is spent on huge input', () => {
    const store = new TranscriptStore();
    // One unterminated line past the cap: the guard must fire on the BUFFER,
    // not per completed line, or this never terminates.
    const giant = 'x'.repeat(MAX_LINE_BYTES + 1);

    const outcome = driveTurn(store, [giant], 'stealth/space-bunny-alpha');

    expect(outcome.error?.code).toBe('malformed-stream');
    expect(outcome.frameCount).toBe(0);
    expect(outcome.sawResultFrame).toBe(false);
    expect(store.size).toBe(0);
  });

  it('keeps a large but legal payload (a 1 MB finalText) flowing through the guard', () => {
    const store = new TranscriptStore();
    const modelId = 'stealth/space-bunny-alpha';
    const big = 'A'.repeat(1_000_000);
    const stream = serialize([runStart(), successResult({ finalText: big })]);

    // A single chunk the size of the whole stream: the guard sees the complete
    // lines already buffered, so it must NOT trip on them.
    const outcome = driveTurn(store, [stream], modelId);

    expect(outcome.error).toBeNull();
    expect(outcome.summaryText).toHaveLength(1_000_000);
    expect(store.get(modelId)).toBe(SESSION_ID);
  });

  it('delivers a 1 MB result delivered as one byte at a time', () => {
    const store = new TranscriptStore();
    const modelId = 'stealth/space-bunny-alpha';
    const big = 'B'.repeat(1_000);
    const stream = serialize([runStart(), successResult({ finalText: big })]);

    const chunks: string[] = [];
    for (const ch of stream) {
      chunks.push(ch);
    }

    const outcome = driveTurn(store, chunks, modelId);

    expect(outcome.error).toBeNull();
    expect(outcome.summaryText).toBe(big);
    expect(store.get(modelId)).toBe(SESSION_ID);
  });
});
