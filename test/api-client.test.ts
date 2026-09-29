import { describe, expect, it } from 'vitest';

import {
  ProviderApiClient,
  ProviderApiError,
  endpointFor,
  MODELS_URL,
  PROVIDER_BASE_URL,
} from '../src/api/client.js';

// The base URL is `api.commandcode.ai/provider` — NOT the host root. The root
// serves the CLI's own private `/alpha/*` backend, which is a different
// surface, so probing `/v1/chat/completions` without the `/provider` segment
// 404s and says nothing about this API. These tests pin the segment.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(response: Response, seen: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return response;
  }) as unknown as typeof fetch;
}

describe('ProviderApiClient', () => {
  it('targets the /provider base, never the host root', () => {
    expect(PROVIDER_BASE_URL).toBe('https://api.commandcode.ai/provider');
    expect(MODELS_URL).toBe('https://api.commandcode.ai/provider/v1/models');
  });

  it('sends a bearer token and requests a stream', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = new ProviderApiClient({
      apiKey: 'secret-key',
      fetchImpl: stubFetch(new Response('data: {}\n\n', { status: 200 }), seen),
    });
    await client.post('/v1/responses', { model: 'x' }, 'text/event-stream');

    expect(seen.url).toBe('https://api.commandcode.ai/provider/v1/responses');
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    expect(headers.Accept).toBe('text/event-stream');
    expect(headers['x-cmd-zdr']).toBeUndefined();
  });

  it('adds x-cmd-zdr only when zero data retention is on', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = new ProviderApiClient({
      apiKey: 'k',
      zeroDataRetention: true,
      fetchImpl: stubFetch(new Response('data: {}\n\n', { status: 200 }), seen),
    });
    await client.post('/v1/responses', {});
    expect((seen.init?.headers as Record<string, string>)['x-cmd-zdr']).toBe('1');
  });

  it('surfaces the 403 plan gate verbatim', async () => {
    // Go is the only plan without API access, and this response is the only
    // reliable way to learn a user's plan — the vendor's docs are explicit that
    // it cannot be read headlessly.
    const client = new ProviderApiClient({
      apiKey: 'k',
      fetchImpl: stubFetch(
        jsonResponse(403, {
          error: {
            type: 'permission_error',
            code: 'upgrade_required',
            message: "You're on the Go plan, the only plan without API access. Upgrade to GOAT or higher.",
          },
        }),
      ),
    });

    const error = await client.post('/v1/responses', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderApiError);
    const api = error as ProviderApiError;
    expect(api.status).toBe(403);
    expect(api.code).toBe('upgrade_required');
    expect(api.isPlanGate).toBe(true);
    // Passed through verbatim: the user needs the vendor's own words.
    expect(api.message).toContain('Go plan');
    expect(api.message).toContain('GOAT or higher');
  });

  it('reads the Anthropic error envelope too, which carries no code field', async () => {
    const client = new ProviderApiClient({
      apiKey: 'k',
      fetchImpl: stubFetch(
        jsonResponse(401, {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      ),
    });
    const error = (await client.post('/v1/messages', {}).catch((e: unknown) => e)) as ProviderApiError;
    expect(error.status).toBe(401);
    expect(error.code).toBe('authentication_error');
    expect(error.isPlanGate).toBe(false);
  });

  it('reports a non-JSON error body without inventing a message', async () => {
    const client = new ProviderApiClient({
      apiKey: 'k',
      fetchImpl: stubFetch(new Response('<html>bad gateway</html>', { status: 502 })),
    });
    const error = (await client.post('/v1/responses', {}).catch((e: unknown) => e)) as ProviderApiError;
    expect(error.status).toBe(502);
    expect(error.code).toBe('http_502');
    expect(error.message).toContain('502');
  });

  it('degrades a model-list fetch to null rather than throwing', async () => {
    // A network failure must not empty the picker; the shipped catalog is the
    // fallback and endpoint routing has a documented rule without the list.
    const client = new ProviderApiClient({
      apiKey: 'k',
      fetchImpl: stubFetch(new Response('nope', { status: 500 })),
    });
    await expect(client.getJson('/v1/models')).resolves.toBeNull();
  });
});

describe('endpointFor', () => {
  it('routes Claude to the Messages endpoint, from the server declaration', () => {
    expect(
      endpointFor({ id: 'claude-sonnet-5', supported_endpoints: ['/v1/messages'] }),
    ).toBe('messages');
  });

  it('routes everything else to Responses', () => {
    expect(
      endpointFor({ id: 'deepseek/deepseek-v4-pro', supported_endpoints: ['/v1/responses'] }),
    ).toBe('responses');
  });

  it('falls back to the documented rule when the list is unavailable', () => {
    // A model that serves both is routed by what it declares; one that
    // declares nothing falls back to Claude ⇒ messages, per the docs.
    expect(endpointFor(undefined)).toBe('responses');
    expect(endpointFor({ id: 'claude-sonnet-5' })).toBe('messages');
    expect(endpointFor({ id: 'gpt-6-astra', supported_endpoints: [] })).toBe('responses');
  });
});
