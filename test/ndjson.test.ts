import { describe, expect, it } from 'vitest';

import { MAX_LINE_BYTES, NdjsonReader } from '../src/cli/ndjson.js';
import { CliError, ZERO_USAGE, type EventFrame, type Frame, type ResultFrame } from '../src/types.js';

// No `vscode` import and no stub in this file: ndjson.ts is a leaf, so the
// reader half of AC-08 is provable under a plain vitest run (§3.1).

/** Collects everything the reader delivers, in arrival order. */
function collector(): { frames: Frame[]; sink: (f: Frame) => void } {
  const frames: Frame[] = [];
  return { frames, sink: (f) => frames.push(f) };
}

const RUN_START: EventFrame = {
  type: 'event',
  event: { type: 'run_start', sessionId: 'ab4c5b22-0000' },
};
const TEXT_DELTA: EventFrame = { type: 'event', event: { type: 'text_delta', delta: 'PONG' } };

const SUCCESS: ResultFrame = {
  type: 'result',
  subtype: 'success',
  sessionId: 'ab4c5b22-0000',
  stopReason: 'end_turn',
  usage: ZERO_USAGE,
  durationMs: 3060,
  finalText: 'PONG',
};

const line = (f: unknown): string => `${JSON.stringify(f)}\n`;

describe('NdjsonReader framing', () => {
  it('delivers a single line from a single chunk', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    expect(reader.push(line(TEXT_DELTA))).toBeNull();
    expect(frames).toEqual([TEXT_DELTA]);
  });

  it('delivers every line when one chunk carries several', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    const chunk = line(RUN_START) + line(TEXT_DELTA) + line(SUCCESS);
    expect(reader.push(chunk)).toBeNull();
    expect(frames).toEqual([RUN_START, TEXT_DELTA, SUCCESS]);
  });

  it('reassembles one JSON line split across three chunks', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);
    const encoded = line(TEXT_DELTA);

    // Split inside the JSON, mid-token, three ways.
    const cut1 = encoded.indexOf('"PONG"');
    const cut2 = cut1 + 3;
    expect(cut1).toBeGreaterThan(0);
    expect(cut2).toBeGreaterThan(cut1);

    expect(reader.push(encoded.slice(0, cut1))).toBeNull();
    expect(frames).toEqual([]); // nothing complete yet — no partial dispatch
    expect(reader.push(encoded.slice(cut1, cut2))).toBeNull();
    expect(frames).toEqual([]);
    expect(reader.push(encoded.slice(cut2))).toBeNull();
    expect(frames).toEqual([TEXT_DELTA]);
  });

  it('preserves arrival order across ragged chunk boundaries', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);
    const stream = line(RUN_START) + line(TEXT_DELTA) + line(SUCCESS);

    // One byte at a time: the worst case for a line framer.
    for (const char of stream) {
      expect(reader.push(char)).toBeNull();
    }
    expect(frames).toEqual([RUN_START, TEXT_DELTA, SUCCESS]);
    expect(reader.frameCount()).toBe(3);
  });

  it('handles a chunk boundary falling exactly on the newline', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);
    const encoded = line(TEXT_DELTA);

    expect(reader.push(encoded.slice(0, encoded.length - 1))).toBeNull();
    expect(frames).toEqual([]);
    expect(reader.push('\n')).toBeNull();
    expect(frames).toEqual([TEXT_DELTA]);
  });

  it('ignores an empty chunk', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    expect(reader.push('')).toBeNull();
    expect(reader.push(line(TEXT_DELTA))).toBeNull();
    expect(frames).toEqual([TEXT_DELTA]);
  });
});

describe('NdjsonReader ignored shapes', () => {
  it('skips blank and whitespace-only lines', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    const chunk = '\n' + '   \n' + '\t\n' + line(TEXT_DELTA) + '\r\n';
    expect(reader.push(chunk)).toBeNull();
    expect(frames).toEqual([TEXT_DELTA]);
    expect(reader.frameCount()).toBe(1);
  });

  it('ignores arrays, scalars and null, and still delivers the frames around them', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    const chunk =
      '[1,2,3]\n' +
      '"just a string"\n' +
      '42\n' +
      'true\n' +
      'null\n' +
      line(TEXT_DELTA) +
      line(SUCCESS);

    expect(reader.push(chunk)).toBeNull();
    expect(frames).toEqual([TEXT_DELTA, SUCCESS]);
  });

  it('ignores an unknown top-level type', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    const chunk =
      line({ type: 'telemetry', payload: { ms: 12 } }) +
      line({ subtype: 'success' }) +
      line(SUCCESS);

    expect(reader.push(chunk)).toBeNull();
    expect(frames).toEqual([SUCCESS]);
    // A discarded line is not a frame.
    expect(reader.frameCount()).toBe(1);
  });

  it('passes an unrecognised event.type through rather than rejecting it', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    // §4.4 step 3 dispatches every `event` frame whose payload carries a
    // string `event.type`, and the shapes in types.ts are deliberately open:
    // "we consume exactly two event types and ignore the rest" is the rule for
    // the CONSUMERS. A vendor-side event we have never seen must reach them
    // untouched rather than raise — a protocol we do not understand has to
    // degrade to a visible `no-response`, never to a wrong answer.
    const chunk =
      line({ type: 'event', event: { type: 'some_future_event', detail: 1 } }) +
      line(TEXT_DELTA) +
      line({ type: 'event', event: { type: 'thinking_delta', delta: 'hmm' } });

    expect(reader.push(chunk)).toBeNull();
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({ type: 'event', event: { type: 'some_future_event', detail: 1 } });
    expect(frames[1]).toEqual(TEXT_DELTA);
    expect(reader.sawResultFrame()).toBe(false);
    expect(reader.frameCount()).toBe(3);
  });

  it('ignores an event frame with a missing or non-string event.type', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    const chunk =
      line({ type: 'event' }) +
      line({ type: 'event', event: null }) +
      line({ type: 'event', event: { type: 7 } }) +
      line({ type: 'event', event: 'text_delta' }) +
      line(TEXT_DELTA);

    expect(reader.push(chunk)).toBeNull();
    expect(frames).toEqual([TEXT_DELTA]);
  });
});

describe('NdjsonReader malformed lines', () => {
  it('returns a malformed-stream CliError for an unparseable line', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    const error = reader.push('{"type":"event"\n');
    expect(error).toBeInstanceOf(CliError);
    expect(error?.code).toBe('malformed-stream');
    expect(frames).toEqual([]);
  });

  it('stops delivering frames after the malformed line in the same chunk', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    const error = reader.push('not json at all\n' + line(SUCCESS));
    expect(error?.code).toBe('malformed-stream');
    expect(frames).toEqual([]); // the valid line after the bad one is dropped
  });

  it('is terminal: pushes after an error deliver nothing and keep failing', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    expect(reader.push('{"broken"\n')?.code).toBe('malformed-stream');
    expect(reader.frameCount()).toBe(0);
    expect(reader.sawAnyFrame()).toBe(false);
    expect(reader.sawResultFrame()).toBe(false);

    // Nothing may change state, whatever arrives afterwards.
    expect(reader.push(line(SUCCESS))?.code).toBe('malformed-stream');
    expect(reader.push(line(SUCCESS) + line(TEXT_DELTA))?.code).toBe('malformed-stream');
    expect(reader.push('')).toBeInstanceOf(CliError);
    expect(frames).toEqual([]);
    expect(reader.frameCount()).toBe(0);
    expect(reader.sawResultFrame()).toBe(false);
  });

  it('does not re-dispatch a frame delivered before the error', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    reader.push(line(TEXT_DELTA) + 'garbage\n');
    expect(reader.frameCount()).toBe(1);
    reader.push(line(SUCCESS));
    expect(frames).toEqual([TEXT_DELTA]);
    expect(reader.frameCount()).toBe(1);
  });
});

describe('NdjsonReader end()', () => {
  it('flushes a trailing unterminated line rather than discarding it', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    // A truncated pipe: the child died before writing the final newline.
    expect(reader.push(line(RUN_START) + JSON.stringify(SUCCESS))).toBeNull();
    expect(frames).toEqual([RUN_START]);
    expect(reader.sawResultFrame()).toBe(false);

    expect(reader.end()).toBeNull();
    expect(frames).toEqual([RUN_START, SUCCESS]);
    expect(reader.sawResultFrame()).toBe(true);
  });

  it('is idempotent: a second end() is a no-op', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    reader.push(JSON.stringify(SUCCESS));
    expect(reader.end()).toBeNull();
    expect(reader.end()).toBeNull();
    expect(reader.end()).toBeNull();
    expect(frames).toEqual([SUCCESS]);
    expect(reader.frameCount()).toBe(1);
  });

  it('does not re-flush the tail when end() follows end()', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    reader.push(JSON.stringify(TEXT_DELTA));
    reader.end();
    reader.end();
    expect(frames).toEqual([TEXT_DELTA]);
  });

  it('ends cleanly on an empty buffer', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    expect(reader.end()).toBeNull();
    expect(frames).toEqual([]);
    expect(reader.sawAnyFrame()).toBe(false);
  });

  it('ends cleanly when only whitespace is buffered', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    reader.push('\n  \n\t');
    expect(reader.end()).toBeNull();
    expect(frames).toEqual([]);
  });

  it('returns malformed-stream for an unparseable trailing line', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    reader.push('{"type":"result"');
    const error = reader.end();
    expect(error?.code).toBe('malformed-stream');
    expect(frames).toEqual([]);
  });

  it('ignores pushes after end()', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    reader.push(line(TEXT_DELTA));
    expect(reader.end()).toBeNull();
    expect(reader.push(line(SUCCESS))?.code).toBe('malformed-stream');
    expect(frames).toEqual([TEXT_DELTA]);
  });
});

describe('NdjsonReader size guard', () => {
  it('rejects an unterminated buffer over MAX_LINE_BYTES', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    // No newline anywhere: a per-line check would never see this.
    const giant = 'x'.repeat(MAX_LINE_BYTES + 1);
    const error = reader.push(giant);
    expect(error?.code).toBe('malformed-stream');
    expect(frames).toEqual([]);
  });

  it('rejects when the buffer crosses the cap only after a split push', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    const half = 'y'.repeat(Math.floor(MAX_LINE_BYTES / 2) + 1);
    expect(reader.push(half)).toBeNull();
    expect(reader.push(half)).toBeInstanceOf(CliError);
    expect(frames).toEqual([]);
  });

  it('does not consume the buffer when the guard fires', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    const oversized = line(SUCCESS).padEnd(MAX_LINE_BYTES + 1, ' ');
    expect(reader.push(oversized)?.code).toBe('malformed-stream');
    // Terminal: the line in that buffer is not delivered on any later call,
    // which is what "without consuming" means for a reader that stops.
    expect(reader.push(line(SUCCESS))).toBeInstanceOf(CliError);
    expect(reader.end()).toBeNull();
    expect(frames).toEqual([]);
  });

  it('accepts a buffer of exactly MAX_LINE_BYTES and rejects one byte more', () => {
    // §4.4 step 1 bounds the BUFFER, not the line, so the boundary is stated
    // over the buffered bytes the guard actually measures. `>` not `>=`: a
    // buffer sitting exactly on the cap is legal. The filler is derived from
    // the envelope rather than hardcoded, so the assertion cannot drift.
    const envelope = line({ type: 'event', event: { type: 'text_delta', delta: '' } });
    const overhead = envelope.length;
    const atCap = line({
      type: 'event',
      event: { type: 'text_delta', delta: 'z'.repeat(MAX_LINE_BYTES - overhead) },
    });
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(MAX_LINE_BYTES);

    const kept = collector();
    const onCap = new NdjsonReader(kept.sink);
    expect(onCap.push(atCap)).toBeNull();
    expect(kept.frames).toHaveLength(1);

    const overCap = collector();
    const reader = new NdjsonReader(overCap.sink);
    const over = line({
      type: 'event',
      event: { type: 'text_delta', delta: 'z'.repeat(MAX_LINE_BYTES - overhead + 1) },
    });
    expect(Buffer.byteLength(over, 'utf8')).toBe(MAX_LINE_BYTES + 1);
    expect(reader.push(over)).toBeInstanceOf(CliError);
    expect(overCap.frames).toEqual([]);
  });
});

describe('NdjsonReader predicates (D3)', () => {
  it('leaves sawResultFrame false for a stream of only events', () => {
    const { frames, sink } = collector();
    const reader = new NdjsonReader(sink);

    reader.push(line(RUN_START) + line(TEXT_DELTA));
    expect(frames).toHaveLength(2);
    expect(reader.sawAnyFrame()).toBe(true);
    expect(reader.sawResultFrame()).toBe(false); // §D3: this is the hang case
    expect(reader.frameCount()).toBe(2);
  });

  it('leaves both predicates false for a stream of only ignored shapes', () => {
    const { sink } = collector();
    const reader = new NdjsonReader(sink);

    reader.push('[1,2]\nnull\n"x"\n{"type":"unknown"}\n');
    expect(reader.sawAnyFrame()).toBe(false);
    expect(reader.sawResultFrame()).toBe(false);
    expect(reader.frameCount()).toBe(0);
  });

  it('flips sawResultFrame when the result frame arrives', () => {
    const { sink } = collector();
    const reader = new NdjsonReader(sink);

    reader.push(line(RUN_START) + line(TEXT_DELTA));
    expect(reader.sawResultFrame()).toBe(false);

    reader.push(line(SUCCESS));
    expect(reader.sawResultFrame()).toBe(true);
    expect(reader.sawAnyFrame()).toBe(true);
    expect(reader.frameCount()).toBe(3);
  });

  it('reports false for both predicates before anything is pushed', () => {
    const { sink } = collector();
    const reader = new NdjsonReader(sink);

    expect(reader.sawResultFrame()).toBe(false);
    expect(reader.sawAnyFrame()).toBe(false);
    expect(reader.frameCount()).toBe(0);
  });
});
