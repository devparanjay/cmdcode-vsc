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

/**
 * Whether a frame ends the turn in the given dialect.
 *
 * Per the docs every stream ends with a usage frame: Responses on
 * `response.completed`, Anthropic on `message_delta`/`message_stop`, and
 * Chat Completions on a final chunk carrying usage with no choices. Checking the
 * terminal event rather than the socket closing is what lets a truncated stream
 * be reported instead of silently treated as a complete answer.
 */
function isTerminal(frame: Frame, dialect: 'chat-completions' | 'responses' | 'anthropic'): boolean {
  const type = frame['type'];
  if (type === 'response.completed' || type === 'message_stop' || type === 'message_delta') {
    return true;
  }
  if (dialect === 'chat-completions') {
    const choices = frame['choices'];
    return Array.isArray(choices) && choices.length === 0 && frame['usage'] !== undefined;
  }
  return false;
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
  let completed = false;

  const handle = (data: string): void => {
    const frame = parseFrame(data);
    if (frame === null) {
      return;
    }
    sawAnyFrame = true;
    readUsage(frame, handlers);

    const decoded =
      dialect === 'responses'
        ? decodeResponses(frame, handlers)
        : dialect === 'anthropic'
          ? decodeAnthropic(frame, handlers)
          : decodeChatCompletions(frame, handlers);
    if (decoded) {
      sawAnyFrame = true;
    }

    if (isTerminal(frame, dialect)) {
      completed = true;
    }
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

  if (!completed && !sawAnyFrame) {
    throw new StreamIncompleteError(false);
  }
  if (!completed) {
    throw new StreamIncompleteError(true);
  }
}
