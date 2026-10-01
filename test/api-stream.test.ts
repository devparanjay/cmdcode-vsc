import { describe, expect, it } from 'vitest';

import { StreamIncompleteError, readStream } from '../src/api/stream.js';

// The three endpoints speak three SSE dialects. The tool-call assertions are the
// load-bearing ones: the provider emits a LanguageModelToolCallPart from these
// and Copilot executes it, so a missed frame means a silently dead tool.

function sse(...events: string[]): Response {
  return new Response(events.join('\n\n') + '\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function collector() {
  const text: string[] = [];
  const tools: { callId: string; name: string; input: unknown }[] = [];
  const usage: { input?: number; output?: number }[] = [];
  return {
    text,
    tools,
    usage,
    handlers: {
      onText: (d: string) => text.push(d),
      onToolCall: (c: { callId: string; name: string; input: unknown }) => tools.push(c),
      onUsage: (u: { input?: number; output?: number }) => usage.push(u),
    },
  };
}

/**
 * A Chat Completions frame carrying one tool-call delta, built with
 * JSON.stringify rather than a hand-escaped literal.
 *
 * The argument fragments are nested JSON inside a JSON string, so hand-writing
 * them costs two levels of escaping and a mistyped comma silently produces an
 * unparsable payload that the reader discards — which looks exactly like a
 * decoder bug. Building the frame means the fragments cannot be mistyped.
 */
function ccToolDelta(args: {
  index?: number;
  id?: string;
  name?: string;
  args?: string;
  finishReason?: string | null;
}): string {
  const toolCalls = [
    {
      ...(args.index === undefined ? {} : { index: args.index }),
      ...(args.id === undefined ? {} : { id: args.id }),
      type: 'function',
      function: {
        ...(args.name === undefined ? {} : { name: args.name }),
        arguments: args.args ?? '',
      },
    },
  ];
  return `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: { tool_calls: toolCalls },
        ...(args.finishReason === undefined ? {} : { finish_reason: args.finishReason }),
      },
    ],
  })}`;
}

describe('readStream — Responses dialect', () => {
  it('streams text deltas in arrival order', async () => {
    const c = collector();
    await readStream(
      sse(
        'data: {"type":"response.output_text.delta","delta":"Hel"}',
        'data: {"type":"response.output_text.delta","delta":"lo"}',
        'data: {"type":"response.completed","usage":{"input_tokens":10,"output_tokens":2}}',
      ),
      'responses',
      c.handlers,
    );
    expect(c.text).toEqual(['Hel', 'lo']);
    expect(c.usage).toEqual([{ input: 10, output: 2 }]);
  });

  it('emits a tool call from a completed function_call item', async () => {
    const c = collector();
    await readStream(
      sse(
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}',
        'data: {"type":"response.completed"}',
      ),
      'responses',
      c.handlers,
    );
    expect(c.tools).toHaveLength(1);
    expect(c.tools[0].name).toBe('read_file');
    expect(c.tools[0].callId).toBe('call_1');
    // Arguments arrive as a JSON string and must be parsed, not passed through.
    expect(c.tools[0].input).toEqual({ path: 'a.ts' });
  });

  it('keeps an unparsable argument string as raw rather than throwing', async () => {
    const c = collector();
    await readStream(
      sse(
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c","name":"n","arguments":"{broken"}}',
        'data: {"type":"response.completed"}',
      ),
      'responses',
      c.handlers,
    );
    expect(c.tools[0].input).toEqual({ raw: '{broken' });
  });

  it('ignores heartbeat and [DONE] frames', async () => {
    const c = collector();
    await readStream(
      sse(': keep-alive', 'data: [DONE]', 'data: {"type":"response.completed"}'),
      'responses',
      c.handlers,
    );
    expect(c.text).toEqual([]);
  });
});

describe('readStream — Chat Completions dialect', () => {
  it('reads choices[].delta.content', async () => {
    const c = collector();
    await readStream(
      sse(
        'data: {"choices":[{"delta":{"content":"a"}}]}',
        'data: {"choices":[{"delta":{"content":"b"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
      ),
      'chat-completions',
      c.handlers,
    );
    expect(c.text).toEqual(['a', 'b']);
    expect(c.usage).toEqual([{ input: 3, output: 1 }]);
  });

  it('reads a streamed tool call with index-split arguments', async () => {
    const c = collector();
    await readStream(
      sse(
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"ls","arguments":"{\\"p\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"1}"}}]}}]}',
        'data: {"choices":[],"usage":{}}',
      ),
      'chat-completions',
      c.handlers,
    );
    expect(c.tools).toHaveLength(1);
    expect(c.tools[0].name).toBe('ls');
    // The arguments arrive AFTER the name, in fragments. Asserting only the
    // name is what let a decoder that threw every argument away pass: the
    // assertion has to cover the reassembled payload.
    expect(c.tools[0].input).toEqual({ p: 1 });
  });

  it('reassembles arguments fragmented across many deltas, and emits one call', async () => {
    // How OpenAI actually streams: id + name on the first delta, arguments
    // dribbling out afterwards. Emitting on the name-bearing delta delivers
    // empty input and the model calls the tool blind.
    const fragments = ['{"page', 'Id":"3"', ',"url":"http://x"', '}'];
    const c = collector();
    await readStream(
      sse(
        ccToolDelta({ index: 0, id: 'call_abc', name: 'playwright_browser_navigate' }),
        ...fragments.map((f) => ccToolDelta({ index: 0, args: f, finishReason: null })),
        ccToolDelta({ index: 0, args: '', finishReason: 'tool_calls' }),
        'data: [DONE]',
      ),
      'chat-completions',
      c.handlers,
    );
    // One call, not one per argument fragment.
    expect(c.tools).toHaveLength(1);
    expect(c.tools[0].callId).toBe('call_abc');
    expect(c.tools[0].name).toBe('playwright_browser_navigate');
    expect(c.tools[0].input).toEqual({ pageId: '3', url: 'http://x' });
  });

  it('keeps parallel tool calls separate by index', async () => {
    // Two calls interleaved in one delta array: buffering by name instead of by
    // `index` merges their arguments into one unusable blob.
    const pair = (i: number, id: string, name: string, args: string): string =>
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: i, id, type: 'function', function: { name, arguments: args } }],
            },
          },
        ],
      })}`;
    const c = collector();
    await readStream(
      sse(
        pair(0, 'c1', 'read_file', '{"p":'),
        pair(1, 'c2', 'grep', '{"q":'),
        pair(0, 'c1', 'read_file', '"a.ts"}'),
        pair(1, 'c1', 'grep', '"foo"}'),
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      ),
      'chat-completions',
      c.handlers,
    );
    expect(c.tools).toHaveLength(2);
    expect(c.tools[0].input).toEqual({ p: 'a.ts' });
    expect(c.tools[1].input).toEqual({ q: 'foo' });
  });

  it('still emits a call the server never flagged with finish_reason', async () => {
    // The stream ending is a complete turn; a call it finished describing is
    // the model's real intent and must not be dropped in the flush.
    const c = collector();
    await readStream(
      sse(ccToolDelta({ index: 0, id: 'c1', name: 'ls', args: '{"p":"src"}' })),
      'chat-completions',
      c.handlers,
    );
    expect(c.tools).toHaveLength(1);
    expect(c.tools[0].input).toEqual({ p: 'src' });
  });
});

describe('readStream — Anthropic dialect', () => {
  it('reads content_block_delta text', async () => {
    const c = collector();
    await readStream(
      sse(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        'data: {"type":"message_delta","usage":{"input_tokens":8,"output_tokens":4}}',
      ),
      'anthropic',
      c.handlers,
    );
    expect(c.text).toEqual(['hi']);
    expect(c.usage).toEqual([{ input: 8, output: 4 }]);
  });

  it('emits a tool_use block as a tool call', async () => {
    // Anthropic also allows the whole input on the start frame, with no
    // fragments following. That path still has to work.
    const c = collector();
    await readStream(
      sse(
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"grep","input":{"q":"x"}}}',
        'data: {"type":"message_stop"}',
      ),
      'anthropic',
      c.handlers,
    );
    expect(c.tools).toEqual([{ callId: 'tu_1', name: 'grep', input: { q: 'x' } }]);
  });

  it('accumulates input_json_delta fragments into the tool input', async () => {
    // The real Claude shape: the start frame carries input:{} and the arguments
    // stream afterwards. Emitting at the start frame delivers an empty object,
    // so the model calls the tool with nothing in it.
    const fragments = ['{"page', 'Id":"3"', '}'];
    const c = collector();
    await readStream(
      sse(
        `data: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_page', input: {} },
        })}`,
        ...fragments.map((f) =>
          `data: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: f },
          })}`,
        ),
        `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
        'data: {"type":"message_delta","usage":{"output_tokens":5}}',
        'data: {"type":"message_stop"}',
      ),
      'anthropic',
      c.handlers,
    );
    expect(c.tools).toEqual([{ callId: 'toolu_1', name: 'get_page', input: { pageId: '3' } }]);
  });

  it('still emits an Anthropic call when message_stop arrives without a block stop', async () => {
    const c = collector();
    await readStream(
      sse(
        `data: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_2', name: 'ls', input: {} },
        })}`,
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"p":"src"}' },
        })}`,
        'data: {"type":"message_stop"}',
      ),
      'anthropic',
      c.handlers,
    );
    expect(c.tools).toEqual([{ callId: 'toolu_2', name: 'ls', input: { p: 'src' } }]);
  });

  it('prefers streamed fragments over a non-streaming input placeholder', async () => {
    // A server that sends `input: {}` on the start frame and the real arguments
    // afterwards must not be overridden by that empty placeholder.
    const c = collector();
    await readStream(
      sse(
        `data: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_3', name: 'ls', input: {} },
        })}`,
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"p":"src"}' },
        })}`,
        `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      ),
      'anthropic',
      c.handlers,
    );
    expect(c.tools[0].input).toEqual({ p: 'src' });
  });
});

describe('readStream — framing and failure', () => {
  it('reassembles a frame split across chunks', async () => {
    // A frame arriving in two TCP reads must still be delivered exactly once.
    const body = 'data: {"type":"response.output_text.delta","delta":"split"}\n\ndata: {"type":"response.completed"}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        controller.enqueue(bytes.slice(0, 30));
        controller.enqueue(bytes.slice(30));
        controller.close();
      },
    });
    const c = collector();
    await readStream(new Response(stream), 'responses', c.handlers);
    expect(c.text).toEqual(['split']);
  });

  it('flushes a final frame the server left unterminated', async () => {
    // No trailing blank line: the last frame must still be delivered rather
    // than left sitting in the buffer. A completion frame is included, because
    // a stream that never sends one is correctly reported as truncated.
    const c = collector();
    const stream = new Response(
      'data: {"type":"response.output_text.delta","delta":"tail"}\n\ndata: {"type":"response.completed"}',
    );
    await readStream(stream, 'responses', c.handlers);
    expect(c.text).toEqual(['tail']);
  });

  it('treats a stream that simply ends as a complete turn', async () => {
    // The 0.3.4 failure. The stream ended with no frame matching the terminal
    // pattern guessed from documentation, and the reader threw — discarding an
    // answer the model had already delivered, token by token, to the chat.
    // Completion is the stream ending; requiring an event invented a failure.
    const c = collector();
    await expect(
      readStream(
        sse(
          'data: {"choices":[{"delta":{"content":"Hello"}}]}',
          'data: {"choices":[{"delta":{"content":" there"}}]}',
          // No finish_reason, no usage chunk, no [DONE] — just the socket closing.
        ),
        'chat-completions',
        c.handlers,
      ),
    ).resolves.toBeUndefined();
    // The tokens were still delivered.
    expect(c.text).toEqual(['Hello', ' there']);
  });

  it('accepts a stream with no usage frame at all', async () => {
    const c = collector();
    await expect(
      readStream(
        sse('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}'),
        'chat-completions',
        c.handlers,
      ),
    ).resolves.toBeUndefined();
    expect(c.text).toEqual(['hi']);
  });

  it('throws only when nothing arrived at all', async () => {
    // The one failure worth reporting: the server produced no frames, so there
    // is no answer to show. A truncated stream surfaces as "no content", which
    // is truthful, rather than a fabricated protocol error.
    const c = collector();
    const error = await readStream(sse(': nothing'), 'responses', c.handlers).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamIncompleteError);
    expect((error as StreamIncompleteError).sawAnyFrame).toBe(false);
  });

  it('throws on a response with no body', async () => {
    const c = collector();
    await expect(readStream(new Response(null), 'responses', c.handlers)).rejects.toBeInstanceOf(
      StreamIncompleteError,
    );
  });
});
