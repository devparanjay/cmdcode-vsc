import { describe, expect, it, vi } from 'vitest';

import { ProviderApiClient } from '../src/api/client.js';
import { CommandCodeApiChatProvider } from '../src/api-provider.js';
import { MODELS, chatIdFor } from '../src/catalog.js';
import { CONFIG_DEFAULTS, type Logger } from '../src/types.js';

// What the provider REPORTS to Copilot, not what it sends.
//
// The reported parts become response *content*. VS Code concatenates them into
// the answer with no retract, and the next request sends that answer back to the
// model as its own prior turn. So a diagnostic string injected into the content
// stream is not a log line the user can ignore — it is a sentence the model
// reads as something it said, and reacts to.
//
// That is what made a working tool call come back as:
//
//   Command Code returned no content. See the Command Code log.
//
// which the model answered by retrying the same call, forever.

const WS = '/tmp/ws';

function silentLogger(): Logger {
  return { error: vi.fn(), info: vi.fn(), debug: vi.fn(), show: vi.fn() };
}

/** Drive one turn against a canned SSE body and return every reported part. */
async function partsFor(sseBody: string, modelId = 'stealth/pixel-canary'): Promise<unknown[]> {
  const fetchImpl = (async () =>
    new Response(sseBody, { status: 200 })) as unknown as typeof fetch;

  const provider = new CommandCodeApiChatProvider(
    MODELS,
    new ProviderApiClient({ apiKey: 'k', fetchImpl }),
    silentLogger(),
    WS,
    CONFIG_DEFAULTS,
    'cmdcode-api',
  );

  const parts: unknown[] = [];
  await provider.provideLanguageModelChatResponse(
    {
      id: chatIdFor(modelId, WS),
      name: modelId,
      family: 'cmdcode',
      version: '1.0.0',
      maxInputTokens: 1_000,
      maxOutputTokens: 32_000,
      capabilities: { imageInput: false, toolCalling: true },
    } as never,
    [{ role: 1, name: 'user', content: [] }] as never,
    { tools: [], toolMode: 1 } as never,
    { report: (p: unknown) => parts.push(p) } as never,
    {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    } as never,
  );
  return parts;
}

function sse(...events: string[]): string {
  return events.join('\n\n') + '\n\n';
}

/** A Chat Completions tool-call frame, built so the JSON cannot be mistyped. */
function ccToolDelta(args: { id?: string; name?: string; args?: string }): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(args.id === undefined ? {} : { id: args.id }),
              type: 'function',
              function: {
                ...(args.name === undefined ? {} : { name: args.name }),
                arguments: args.args ?? '',
              },
            },
          ],
        },
      },
    ],
  })}`;
}

describe('a tool call is content enough on its own', () => {
  it('reports no "returned no content" after a tool-only turn', async () => {
    const parts = await partsFor(
      sse(
        ccToolDelta({ id: 'c1', name: 'browser_navigate', args: '{"url":"http://x"}' }),
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ),
    );
    const texts = parts
      .filter((p): p is { value: string } => typeof (p as { value?: unknown }).value === 'string')
      .map((p) => p.value);
    expect(texts).toEqual([]);
  });

  it('carries the reassembled arguments onto the reported tool call', async () => {
    const parts = await partsFor(
      sse(
        ccToolDelta({ id: 'c1', name: 'browser_navigate' }),
        ccToolDelta({ args: '{"url":' }),
        ccToolDelta({ args: '"http://x"}' }),
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ),
    );
    const call = parts[0] as { callId: string; name: string; input: Record<string, unknown> };
    expect(call.name).toBe('browser_navigate');
    expect(call.input).toEqual({ url: 'http://x' });
  });

  it('still reports "no content" when the turn produced nothing at all', async () => {
    // The guard has to survive the fix: a genuinely empty turn would otherwise
    // render as a hang with nothing in the chat to explain why.
    const parts = await partsFor(sse('data: {"choices":[{"delta":{}}]}', 'data: [DONE]'));
    const texts = parts
      .filter((p): p is { value: string } => typeof (p as { value?: unknown }).value === 'string')
      .map((p) => p.value);
    expect(texts.join('')).toContain('returned no content');
  });
});
