import { CliError, type Frame } from '../types.js';

/** Byte cap on buffered-but-unterminated data before we declare a malformed stream. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Incremental NDJSON frame reader.
 *
 * The CLI emits one JSON object per line, newline-terminated (`writeLine:
 * e => c?.(e + "\n")`), and Node hands us those bytes in chunks that align
 * with the pipe, never with our line boundaries. So framing is a
 * buffer-and-split loop, and everything about the protocol we do not
 * recognise is dropped rather than raised: a vendor-side shape change must
 * degrade to a visible `no-response` error, never to a silently wrong answer.
 *
 * The one thing that IS an error is output we cannot parse at all, which is
 * `malformed-stream` — and once that happens the reader is terminal, because a
 * stream that has already lied about its framing cannot be trusted to resume.
 */
export class NdjsonReader {
  private buffer = '';
  private ended = false;
  private failed = false;
  private frames = 0;
  private sawResult = false;

  constructor(private readonly onFrame: (f: Frame) => void) {}

  /**
   * Feed one stdout chunk.
   *
   * @returns null on success, or a CliError('malformed-stream') on a protocol
   *          violation. The reader is TERMINAL on error: once it returns an
   *          error it ignores all further input and never calls onFrame again.
   */
  push(chunk: string): CliError | null {
    if (this.failed) {
      return this.protocolError();
    }
    if (this.ended) {
      return this.protocolError();
    }
    if (chunk.length === 0) {
      return null;
    }

    this.buffer += chunk;

    // Step 1: the size guard runs BEFORE any consumption, so a single
    // unterminated giant line is caught here and only here. A per-line check
    // would never see it, because the line is never completed.
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES) {
      this.failed = true;
      return this.protocolError();
    }

    // Step 2: drain every complete line the chunk made available.
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) {
        break;
      }
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      // Step 3, per line. A bad line stops the drain; anything the chunk
      // carried after it is dropped along with the rest of the stream.
      const error = this.consumeLine(line);
      if (error !== null) {
        this.failed = true;
        return error;
      }
    }
    return null;
  }

  /**
   * Flush the trailing line the child left unterminated.
   *
   * The CLI always newline-terminates every line, so this path is defensive —
   * but a truncated pipe produces exactly this case, so it must work. `end()` is
   * idempotent; a second call is a no-op.
   */
  end(): CliError | null {
    if (this.ended) {
      return null;
    }
    this.ended = true;
    if (this.failed) {
      return null;
    }
    // Step 4: a non-blank remainder is one final line under the same rules.
    const tail = this.buffer;
    this.buffer = '';
    if (tail.trim() === '') {
      return null;
    }
    const error = this.consumeLine(tail);
    if (error !== null) {
      this.failed = true;
    }
    return error;
  }

  /**
   * True iff a frame with type === 'result' has been delivered to onFrame.
   *
   * THIS is the predicate §D3, §5.2 and classify()'s `sawResultFrame` parameter
   * are all defined against. It is deliberately not "any frame arrived".
   */
  sawResultFrame(): boolean {
    return this.sawResult;
  }

  /**
   * True iff any frame at all (event or result) was delivered.
   * DIAGNOSTICS AND LOGGING ONLY. Never feed this to classify().
   */
  sawAnyFrame(): boolean {
    return this.frames > 0;
  }

  /** Frames delivered so far. Logging only. */
  frameCount(): number {
    return this.frames;
  }

  /**
   * Parse one line and dispatch it if — and only if — it is a frame we know.
   *
   * @returns null when the line is fine (delivered, skipped, or ignored), or
   *          the CliError to return to the caller.
   */
  private consumeLine(line: string): CliError | null {
    if (line.trim() === '') {
      return null; // blank and whitespace-only lines are not frames
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return this.protocolError();
    }

    // Anything that is not a plain object is not a frame: arrays, scalars and
    // null all parse, and all are silently ignored.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const value = parsed as { type?: unknown; event?: unknown };

    if (value.type === 'result') {
      this.onFrame(parsed as Frame);
      this.frames++;
      this.sawResult = true;
      return null;
    }

    if (value.type === 'event' && this.isEventPayload(value.event)) {
      this.onFrame(parsed as Frame);
      this.frames++;
      return null;
    }

    // Unknown `type`, or an event whose payload is not an object with a string
    // `type`. Forward compatibility: the vendor states unknown event types must
    // be ignored, and a stream we cannot read degrades to `no-response` (D3).
    return null;
  }

  private isEventPayload(event: unknown): boolean {
    return (
      typeof event === 'object' &&
      event !== null &&
      typeof (event as { type?: unknown }).type === 'string'
    );
  }

  /**
   * The single malformed-stream error this module produces. The message is
   * internal: §4.2 maps the CODE to the user-facing copy, and stderr is where
   * stream detail belongs.
   */
  private protocolError(): CliError {
    return new CliError('malformed-stream', 'stdout was not parseable NDJSON');
  }
}
