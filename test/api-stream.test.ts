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
    const c = collector();
    await readStream(
      sse(
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tu_1","name":"grep","input":{"q":"x"}}}',
        'data: {"type":"message_stop"}',
      ),
      'anthropic',
      c.handlers,
    );
    expect(c.tools).toEqual([{ callId: 'tu_1', name: 'grep', input: { q: 'x' } }]);
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
