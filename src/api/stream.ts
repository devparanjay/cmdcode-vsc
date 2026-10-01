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

/** OpenAI Chat Completions: choices[].delta.content and .tool_calls[]. */
function decodeChatCompletions(frame: Frame, handlers: StreamHandlers): boolean {
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
        const fn = asRecord(record2?.['function']);
        const name = fn?.['name'];
        const id = record2?.['id'];
        if (typeof name === 'string' && typeof id === 'string') {
          const rawArgs = fn?.['arguments'];
          handlers.onToolCall({
            callId: id,
            name,
            input: safeParse(rawArgs),
          });
          saw = true;
        }
      }
    }
  }
  return saw;
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
      decodeChatCompletions(frame, handlers);
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
  // The only failure worth reporting is a stream that produced NOTHING. A
  // truncated stream already surfaces as a provider that returned no content,
  // which is a truthful message rather than a fabricated protocol error.
  if (!sawAnyFrame) {
    throw new StreamIncompleteError(false);
  }
}
