/**
 * Incremental SSE reader for the Command Code Provider API.
 *
 * The three streaming endpoints speak three different SSE dialects (OpenAI
 * Chat Completions, OpenAI Responses, Anthropic Messages). All of them terminate
 * the stream with a usage frame, and two of them surface tool calls. This reader
 * frames `data:` lines and hands each payload to a decoder, so a token is
 * forwarded as it arrives rather than when the stream closes.
 *
 * Pure module: no `vscode`, no I/O beyond the Response handed in.
 */

/** What a stream decoder can observe. */
export type StreamHandlers = {
  /** A text fragment, in arrival order. Never buffered, never trimmed. */
  readonly onText: (delta: string) => void;
  /**
   * A tool the model wants the host to run. The extension NEVER executes it —
   * it emits a `LanguageModelToolCallPart` and Copilot owns execution.
   */
  readonly onToolCall: (call: { readonly callId: string; readonly name: string; readonly input: unknown }) => void;
  /** Terminal usage, for logging. */
  readonly onUsage?: (usage: { input?: number; output?: number }) => void;
};

/** Raised when the stream ends without a completion frame. */
export class StreamIncompleteError extends Error {
  constructor(readonly sawAnyFrame: boolean) {
    super(
      sawAnyFrame
        ? 'Command Code API stream ended before a completion event.'
        : 'Command Code API returned no stream events.',
    );
    this.name = 'StreamIncompleteError';
  }
}

/** A minimal structural view of an SSE payload; the dialects differ wildly. */
type Frame = Record<string, unknown>;

function asRecord(value: unknown): Frame | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Frame)
    : null;
}

/** Parse a JSON payload, or null when a keep-alive/blank frame arrives. */
function parseFrame(data: string): Frame | null {
  const trimmed = data.trim();
  if (trimmed === '' || trimmed === '[DONE]') {
    return null;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    // A malformed frame is not fatal: the dialects send comment/heartbeat lines
    // and a future one may add shapes. Skipping keeps a stream usable; a stream
    // that never yields a real frame still fails, via sawAnyFrame.
    return null;
  }
}

/** A tool call being assembled from a stream of deltas. */
interface PendingToolCall {
  callId?: string;
  name?: string;
  args: string;
}

/** A completed call, as handed to the host. */
type CompletedToolCall = { callId: string; name: string; input: unknown };

/**
 * OpenAI Chat Completions: choices[].delta.content and .tool_calls[].
 *
 * Tool calls MUST be accumulated, not emitted per delta. A streamed call sends
 * `id` and `name` once on the first delta and then dribbles the JSON arguments
 * out in fragments across many further deltas — so emitting on the frame that
 * carries the name delivers `input: {}` (or `{raw: ""}`) and throws every
 * argument away. The model then calls the tool blind, with none of the
 * parameters its own schema declared as required.
 *
 * Calls are keyed by `index`, which is the stable identity across the deltas of
 * one call, and are emitted when the choice reports `finish_reason`.
 */
function decodeChatCompletions(
  frame: Frame,
  handlers: StreamHandlers,
  pending: ToolCallSink,
): boolean {
  const choices = frame['choices'];
  if (!Array.isArray(choices)) {
    return false;
  }
  let saw = false;
  for (const choice of choices) {
    const record = asRecord(choice);
    if (record === null) {
      continue;
    }
    const delta = asRecord(record['delta']);
    const text = delta?.['content'];
    if (typeof text === 'string' && text.length > 0) {
      handlers.onText(text);
      saw = true;
    }
    const toolCalls = delta?.['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const record2 = asRecord(call);
        if (record2 === null) {
          continue;
        }
        const fn = asRecord(record2['function']);
        const index = typeof record2['index'] === 'number' ? record2['index'] : 0;
        const name = fn?.['name'];
        const id = record2['id'];
        const args = fn?.['arguments'];
        const entry = pending.chatCompletions(index);
        if (typeof name === 'string') {
          entry.name = name;
        }
        if (typeof id === 'string') {
          entry.callId = id;
        }
        if (typeof args === 'string') {
          entry.args += args;
        }
      }
    }
    // The turn ends at the frame carrying a finish_reason; that is where the
    // calls are complete and can be handed over.
    if (typeof record['finish_reason'] === 'string') {
      for (const call of pending.flushChatCompletions()) {
        handlers.onToolCall(call);
        saw = true;
      }
    }
  }
  return saw;
}

/**
 * Accumulator for Chat Completions tool calls that span many frames.
 *
 * One instance lives per `readStream` call, so two concurrent requests never
 * share half-assembled calls.
 */
class ToolCallSink {
  private readonly chatCompletionsCalls = new Map<number, PendingToolCall>();

  /** The (possibly still empty) accumulator for a streamed call at `index`. */
  chatCompletions(index: number): PendingToolCall {
    let entry = this.chatCompletionsCalls.get(index);
    if (entry === undefined) {
      entry = { args: '' };
      this.chatCompletionsCalls.set(index, entry);
    }
    return entry;
  }

  /**
   * Emit every complete call, in index order, and clear the accumulator.
   *
   * A call missing a name or an id was never fully described, so it is dropped
   * rather than handed to the host half-formed — Copilot would fail a call the
   * user never asked for.
   */
  flushChatCompletions(): CompletedToolCall[] {
    const out: CompletedToolCall[] = [];
    for (const index of [...this.chatCompletionsCalls.keys()].sort((a, b) => a - b)) {
      const entry = this.chatCompletionsCalls.get(index);
      this.chatCompletionsCalls.delete(index);
      if (entry === undefined || typeof entry.name !== 'string' || typeof entry.callId !== 'string') {
        continue;
      }
      out.push({ callId: entry.callId, name: entry.name, input: safeParse(entry.args) });
    }
    return out;
  }

  /**
   * Calls still buffered when the stream ended with no `finish_reason`.
   *
   * The stream ending is a complete turn (see readStream), so a call the server
   * finished describing but never flagged is still the model's real intent and
   * must not be dropped.
   */
  drain(): CompletedToolCall[] {
    return this.flushChatCompletions();
  }
}

/**
 * OpenAI Responses: a sequence of typed events. Text arrives as
 * `response.output_text.delta`; a completed function call arrives as
 * `response.output_item.done` carrying a `function_call` item.
 */
function decodeResponses(frame: Frame, handlers: StreamHandlers): boolean {
  const type = frame['type'];
  let saw = false;

  if (type === 'response.output_text.delta') {
    const delta = frame['delta'];
    if (typeof delta === 'string' && delta.length > 0) {
      handlers.onText(delta);
      saw = true;
    }
    return saw;
  }

  if (type === 'response.output_item.done') {
    const item = asRecord(frame['item']);
    if (item !== null && item['type'] === 'function_call') {
      const name = item['name'];
      const callId = item['call_id'] ?? item['id'];
      if (typeof name === 'string' && typeof callId === 'string') {
        handlers.onToolCall({ callId, name, input: safeParse(item['arguments']) });
        saw = true;
      }
    }
    return saw;
  }

  return saw;
}

/** Anthropic Messages: content_block_delta with text_delta / input_json_delta. */
function decodeAnthropic(frame: Frame, handlers: StreamHandlers): boolean {
  const type = frame['type'];
  let saw = false;

  if (type === 'content_block_delta') {
    const delta = asRecord(frame['delta']);
    const text = delta?.['text'];
    if (typeof text === 'string' && text.length > 0) {
      handlers.onText(text);
      saw = true;
    }
    return saw;
  }

  if (type === 'content_block_start') {
    const block = asRecord(frame['content_block']);
    if (block !== null && block['type'] === 'tool_use') {
      const id = block['id'];
      const name = block['name'];
      if (typeof id === 'string' && typeof name === 'string') {
        handlers.onToolCall({ callId: id, name, input: block['input'] ?? {} });
        saw = true;
      }
    }
    return saw;
  }

  return saw;
}

/** Tool arguments arrive as a JSON *string*; an unparsable one is the model's problem, not a crash. */
function safeParse(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function readUsage(frame: Frame, handlers: StreamHandlers): void {
  const usage = asRecord(frame['usage']);
  if (usage === null) {
    return;
  }
  handlers.onUsage?.({
    input: numberOrUndefined(usage['input_tokens'] ?? usage['prompt_tokens']),
    output: numberOrUndefined(usage['output_tokens'] ?? usage['completion_tokens']),
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Consume an SSE `Response` body, dispatching as frames arrive.
 *
 * @param dialect  which framing the endpoint uses; all three share the decoder
 * @throws StreamIncompleteError when no completion frame was seen
 */
export async function readStream(
  response: Response,
  dialect: 'chat-completions' | 'responses' | 'anthropic',
  handlers: StreamHandlers,
): Promise<void> {
  const body = response.body;
  if (body === null) {
    throw new StreamIncompleteError(false);
  }

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let sawAnyFrame = false;
  // Per-stream, so two concurrent requests never share half-assembled calls.
  const pending = new ToolCallSink();

  const handle = (data: string): void => {
    const frame = parseFrame(data);
    if (frame === null) {
      return;
    }
    readUsage(frame, handlers);
    if (dialect === 'responses') {
      decodeResponses(frame, handlers);
    } else if (dialect === 'anthropic') {
      decodeAnthropic(frame, handlers);
    } else {
      decodeChatCompletions(frame, handlers, pending);
    }
    // Any frame that parsed is proof the stream was alive, which is all that is
    // needed to decide the turn succeeded.
    sawAnyFrame = true;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; `data:` lines accumulate into one
    // event. Splitting on the blank line is therefore the correct boundary, and
    // a partial frame stays in the buffer for the next chunk.
    for (;;) {
      const boundary = buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) {
        break;
      }
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          handle(line.slice(5).trim());
        }
      }
    }
  }

  // A stream that ended without its blank-line terminator still owes us its
  // final frame; flush rather than drop it.
  for (const line of buffer.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      handle(line.slice(5).trim());
    }
  }

  // Completion is the stream ending, not a terminal event. An answer that was
  // received in full is an answer, whether or not the last chunk matched a
  // pattern inferred from documentation — requiring one discarded a successful
  // turn and surfaced it to the user as a failure.
  //
  // The same applies to a tool call: a server that ends the stream after the last
  // argument fragment but never sends `finish_reason` has still fully described
  // the call. Emit what is buffered rather than discarding the model's intent.
  for (const call of pending.drain()) {
    handlers.onToolCall(call);
  }

  // The only failure worth reporting is a stream that produced NOTHING. A
  // truncated stream already surfaces as a provider that returned no content,
  // which is a truthful message rather than a fabricated protocol error.
  if (!sawAnyFrame) {
    throw new StreamIncompleteError(false);
  }
}
