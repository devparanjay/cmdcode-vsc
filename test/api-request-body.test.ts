import { describe, expect, it, vi } from 'vitest';

import { ProviderApiClient } from '../src/api/client.js';
import { CommandCodeApiChatProvider } from '../src/api-provider.js';
import { MODELS, chatIdFor } from '../src/catalog.js';
import { CONFIG_DEFAULTS, type CmdCodeConfig, type Logger } from '../src/types.js';

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

function textPart(value: string): never {
  return value as never;
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
  it('routes an ordinary model to /responses with an input array', async () => {
    const { url, body } = await send('deepseek/deepseek-v4-pro', [textPart('hi')], []);
    expect(url).toBe('https://api.commandcode.ai/provider/v1/responses');
    expect(Array.isArray(body['input'])).toBe(true);
    expect(body['instructions']).toBeTypeOf('string');
    expect(body['stream']).toBe(true);
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