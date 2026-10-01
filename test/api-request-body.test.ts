import { describe, expect, it, vi } from 'vitest';

import { ProviderApiClient } from '../src/api/client.js';
import { CommandCodeApiChatProvider } from '../src/api-provider.js';
import { MODELS, chatIdFor } from '../src/catalog.js';
import { CONFIG_DEFAULTS, type CmdCodeConfig, type Logger } from '../src/types.js';
import {
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from './vscode-stub.js';

// The request BODIES, not the plumbing.
//
// 0.3.1 shipped tool definitions FLAT — `{ type, name, parameters }` — and every
// message failed with:
//
//   Invalid input: expected object, received undefined
//
// The schema wants `{ type: "function", function: { name, parameters } }`. The
// nested form is what a streamed tool CALL comes back in, so a definition and its
// call now share a shape. These tests assert the wire form for all three routes,
// so it cannot drift back.

const WS = '/tmp/ws';

function silentLogger(): Logger {
  return { error: vi.fn(), info: vi.fn(), debug: vi.fn(), show: vi.fn() };
}

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/**
 * A real `LanguageModelTextPart`, because the provider narrows content with
 * `instanceof` — a bare string would be dropped rather than rendered, and the
 * test would pass for the wrong reason (an empty content array).
 */
function textPart(value: string): never {
  return new LanguageModelTextPart(value) as never;
}

/**
 * Drive one turn through the provider with a stubbed fetch and return the exact
 * JSON that went on the wire.
 *
 * The `model` argument is a real catalog id, because the provider reverse-maps
 * the chat id with `findModelByChatId` before it can route anything.
 */
async function send(
  modelId: string,
  content: readonly unknown[],
  tools: readonly unknown[] | undefined,
  configOverrides: Partial<CmdCodeConfig> = {},
): Promise<Sent> {
  let sent: Sent = { url: '', body: {} };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent = {
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    // The dialect differs by route, but a terminal frame satisfies all three
    // decoders, and the body is captured before the stream is read.
    return new Response(
      'data: {"type":"response.completed"}\n\n' +
        'data: {"type":"message_stop"}\n\n' +
        'data: {"choices":[],"usage":{}}\n\n',
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const provider = new CommandCodeApiChatProvider(
    MODELS,
    new ProviderApiClient({ apiKey: 'k', fetchImpl }),
    silentLogger(),
    WS,
    { ...CONFIG_DEFAULTS, ...configOverrides },
    'cmdcode-api',
  );

  const parts: unknown[] = [];
  const progress = { report: (p: unknown) => parts.push(p) };

  await provider.provideLanguageModelChatResponse(
    modelInfo(modelId),
    [{ role: 1, name: 'user', content } as never],
    { tools, toolMode: 1 } as never,
    progress as never,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
  );

  return sent;
}

/** A `LanguageModelChatInformation` the provider will accept for a real model. */
function modelInfo(modelId: string): never {
  return {
    id: chatIdFor(modelId, WS),
    name: modelId,
    family: 'cmdcode',
    version: '1.0.0',
    maxInputTokens: 1_000,
    maxOutputTokens: 32_000,
    capabilities: { imageInput: false, toolCalling: true },
  } as never;
}

const TEXT_TOOL = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

describe('tool definitions are nested on every route', () => {
  // The 0.3.1 failure, in one assertion. A flat definition serialises with no
  // `function` key at all, which the schema reads as undefined.
  it('never sends a flat tool definition', async () => {
    for (const model of [
      'deepseek/deepseek-v4-pro',
      'stealth/space-bunny-alpha',
      'claude-sonnet-5',
    ]) {
      const { body } = await send(model, [textPart('hi')], [TEXT_TOOL]);
      const tools = body['tools'] as Record<string, unknown>[] | undefined;
      expect(tools, model).toBeDefined();
      for (const tool of tools ?? []) {
        if (model === 'claude-sonnet-5') {
          // Anthropic's own flat shape, with input_schema — not the OpenAI one.
          expect(typeof tool['name'], `${model} name`).toBe('string');
          expect(tool['input_schema'], `${model} input_schema`).toBeDefined();
          expect(tool['function'], `${model} must not use the OpenAI nesting`).toBeUndefined();
        } else {
          expect(tool['function'], `${model} function`).toBeDefined();
          expect(typeof (tool['function'] as { name?: unknown }).name).toBe('string');
        }
      }
    }
  });

  it('omits tools entirely when there are none', async () => {
    // Every documented example carries no `tools` key, and an empty array is the
    // likeliest trigger for a schema that expects at least one entry.
    for (const model of [
      'deepseek/deepseek-v4-pro',
      'stealth/space-bunny-alpha',
      'claude-sonnet-5',
    ]) {
      const { body } = await send(model, [textPart('hi')], []);
      expect(body['tools'], model).toBeUndefined();
      expect(Object.keys(body)).toContain('model');
    }
  });

  it('omits tools when VS Code supplies none at all', async () => {
    const { body } = await send('deepseek/deepseek-v4-pro', [textPart('hi')], undefined);
    expect(body['tools']).toBeUndefined();
  });
});

describe('each route gets its own URL and body dialect', () => {
  it('routes an ordinary model to /chat/completions with messages', async () => {
    // /chat/completions is the default for every model that declares it. The
    // two schema defects in 0.3.2 and 0.3.3 were both in the hand-written
    // /responses dialect, and a working reference provider for this same API
    // does not use that route at all.
    const { url, body } = await send('deepseek/deepseek-v4-pro', [textPart('hi')], []);
    expect(url).toBe('https://api.commandcode.ai/provider/v1/chat/completions');
    expect(Array.isArray(body['messages'])).toBe(true);
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
  });

  it('sends a text-only message as a plain string, not an empty array', async () => {
    // The reference provider's shape. An empty `content` array is rejected.
    const { body } = await send('deepseek/deepseek-v4-pro', [textPart('hi')], []);
    const messages = body['messages'] as { content: unknown }[];
    expect(messages[0]!.content).toBe('hi');
  });

  it('uses /chat/completions for every model except Claude', async () => {
    for (const model of [
      'deepseek/deepseek-v4-pro',
      'gpt-6-astra',
      'stealth/space-bunny-alpha',
      'google/gemini-3.7-flash',
      'poolside/laguna-s-2.1-free',
    ]) {
      const { url } = await send(model, [textPart('hi')], []);
      expect(url, model).toBe('https://api.commandcode.ai/provider/v1/chat/completions');
    }
  });

  it('routes a chat-completions-only model to /chat/completions with messages', async () => {
    const { url, body } = await send('stealth/space-bunny-alpha', [textPart('hi')], []);
    expect(url).toBe('https://api.commandcode.ai/provider/v1/chat/completions');
    expect(Array.isArray(body['messages'])).toBe(true);
    expect(body['input']).toBeUndefined();
    expect(body['stream_options']).toEqual({ include_usage: true });
  });

  it('routes Claude to /messages with a flat tool shape and max_tokens', async () => {
    const { url, body } = await send('claude-sonnet-5', [textPart('hi')], [TEXT_TOOL]);
    expect(url).toBe('https://api.commandcode.ai/provider/v1/messages');
    expect(body['max_tokens']).toBe(32_000);
    expect(body['system']).toBeTypeOf('string');
    expect(Array.isArray(body['messages'])).toBe(true);
    const tools = body['tools'] as Record<string, unknown>[];
    expect(tools[0]!['input_schema']).toEqual(TEXT_TOOL.inputSchema);
  });

  it('never sends an undefined value that a schema would read as a missing object', async () => {
    // The literal failure mode: a field present as undefined. JSON.stringify
    // drops undefined-valued keys, so assert on the SERIALISED body.
    for (const model of [
      'deepseek/deepseek-v4-pro',
      'stealth/space-bunny-alpha',
      'claude-sonnet-5',
    ]) {
      const sent = await send(model, [textPart('hi')], [TEXT_TOOL]);
      expect(sent.body).not.toHaveProperty('undefined');
      for (const value of Object.values(sent.body)) {
        expect(value, `${model} has an undefined field`).not.toBeUndefined();
      }
    }
  });
});

describe('the text block type is per-dialect', () => {
  // The 0.3.2 failure. Responses names its text block `input_text`; the other two
  // routes use `text`. Sending `text` to /responses left the required string
  // unreadable, so the server answered "expected string, received undefined" on
  // EVERY message — no image, no tool, just plain chat.
  //
  // `/responses` is no longer the default route, so this is now a property of the
  // fallback renderer rather than of the common path.
  it('sends text on the two default routes', async () => {
    // Chat Completions sends the joined text as the message's `content` STRING.
    const chat = await send('deepseek/deepseek-v4-pro', [textPart('hello')], []);
    const messages = chat.body['messages'] as { content: unknown }[];
    expect(messages[0]!.content).toBe('hello');

    // Anthropic uses explicit blocks.
    const claude = await send('claude-sonnet-5', [textPart('hello')], []);
    const anthropic = claude.body['messages'] as { content: { type: string }[] }[];
    expect(anthropic[0]!.content[0]!.type).toBe('text');
  });

  it('sends input_text to /responses, and never a bare text block there', () => {
    // /responses is now a fallback, so this asserts the renderer's own contract
    // directly rather than waiting for a model to route there.
    const provider = new CommandCodeApiChatProvider(
      MODELS,
      new ProviderApiClient({ apiKey: 'k' }),
      silentLogger(),
      WS,
      CONFIG_DEFAULTS,
      'cmdcode-api',
    );
    const render = (
      provider as unknown as {
        renderContentBlocks: (
          m: unknown,
          d: 'anthropic' | 'openai',
          i: boolean,
        ) => { type: string }[];
      }
    ).renderContentBlocks.bind(provider);

    const message = { role: 1, name: 'user', content: [new LanguageModelTextPart('hello')] };
    const openai = render(message, 'openai', true);
    expect(openai[0]!.type).toBe('input_text');
    // Never the Chat Completions / Anthropic spelling on this route.
    expect(openai.map((b) => b.type)).not.toContain('text');

    // The other dialect uses `text`, which is the whole point of the split.
    expect(render(message, 'anthropic', true)[0]!.type).toBe('text');
  });

  it('carries the prompt text on every route', async () => {
    for (const model of [
      'deepseek/deepseek-v4-pro',
      'stealth/space-bunny-alpha',
      'claude-sonnet-5',
    ]) {
      const { body } = await send(model, [textPart('hello')], []);
      expect(JSON.stringify(body), model).toContain('hello');
    }
  });

  it('names tool blocks per dialect', async () => {
    // Chat Completions: the result is its own role:"tool" message, and the call
    // rides as tool_calls on the message that carries it.
    const chat = await send(
      'deepseek/deepseek-v4-pro',
      [
        textPart('call it'),
        new LanguageModelToolCallPart('call_1', 'read_file', { path: 'a.ts' }) as never,
        new LanguageModelToolResultPart('call_1', [textPart('contents')]) as never,
      ],
      [TEXT_TOOL],
    );
    const messages = chat.body['messages'] as {
      role: string;
      tool_call_id?: string;
      tool_calls?: { function: { name: string } }[];
    }[];
    expect(messages.find((m) => m.role === 'tool')?.tool_call_id).toBe('call_1');
    // The call and its result are never merged into one content block.
    const withCall = messages.find((m) => m.tool_calls !== undefined);
    expect(withCall?.tool_calls?.[0]?.function.name).toBe('read_file');

    // Anthropic: tool_use / tool_result inside the message content.
    const claude = await send(
      'claude-sonnet-5',
      [
        textPart('call it'),
        new LanguageModelToolCallPart('call_1', 'read_file', { path: 'a.ts' }) as never,
        new LanguageModelToolResultPart('call_1', [textPart('contents')]) as never,
      ],
      [TEXT_TOOL],
    );
    const anthropic = claude.body['messages'] as { content: { type: string }[] }[];
    const types = anthropic[0]!.content.map((c) => c.type);
    expect(types).toContain('tool_use');
    expect(types).toContain('tool_result');
    expect(types).not.toContain('function_call_output');
  });
});

describe('image blocks are shaped per dialect', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  function imagePart(): never {
    return new LanguageModelDataPart(PNG, 'image/png') as never;
  }

  it('sends image_url as an object on /chat/completions', async () => {
    // The default route, and the only one that takes `{ url }`. Sending a bare
    // string here — the /responses shape — is what produced "expected string,
    // received undefined".
    for (const model of ['deepseek/deepseek-v4-pro', 'stealth/space-bunny-alpha']) {
      const { body } = await send(model, [imagePart()], []);
      const messages = body['messages'] as { content: Record<string, unknown>[] }[];
      const image = messages[0]!.content.find((c) => c['type'] === 'image_url');
      expect(image, model).toBeDefined();
      const url = image!['image_url'] as { url?: unknown };
      expect(typeof url.url).toBe('string');
      expect(url.url).toMatch(/^data:image\/png;base64,/);
    }
  });

  it('sends a text-and-image message as a parts array', async () => {
    // Text and an image together cannot be a plain string, so the message
    // carries an array — with the text first, as the reference provider does.
    const { body } = await send('deepseek/deepseek-v4-pro', [textPart('look'), imagePart()], []);
    const messages = body['messages'] as { content: { type: string }[] }[];
    const types = messages[0]!.content.map((c) => c.type);
    expect(types).toEqual(['text', 'image_url']);
  });

  it('sends raw base64 bytes on /messages', async () => {
    const { body } = await send('claude-sonnet-5', [imagePart()], []);
    const messages = body['messages'] as { content: Record<string, unknown>[] }[];
    const image = messages[0]!.content.find((c) => c['type'] === 'image');
    expect(image).toBeDefined();
    const source = image!['source'] as { type?: string; media_type?: string };
    expect(source.type).toBe('base64');
    expect(source.media_type).toBe('image/png');
  });
});

describe('an API error is surfaced verbatim', () => {
  it('passes the plan gate message through unchanged', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: {
            type: 'permission_error',
            code: 'upgrade_required',
            message: "You're on the Go plan, the only plan without API access.",
          },
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const provider = new CommandCodeApiChatProvider(
      MODELS,
      new ProviderApiClient({ apiKey: 'k', fetchImpl }),
      silentLogger(),
      WS,
      CONFIG_DEFAULTS,
      'cmdcode-api',
    );

    await expect(
      provider.provideLanguageModelChatResponse(
        modelInfo('claude-sonnet-5'),
        [{ role: 1, name: 'user', content: [textPart('hi')] } as never],
        { tools: [], toolMode: 1 } as never,
        { report: () => undefined } as never,
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as never,
      ),
    ).rejects.toThrow(/Go plan/);
  });
});