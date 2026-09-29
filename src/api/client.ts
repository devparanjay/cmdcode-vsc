/**
 * HTTP client for the Command Code Provider API.
 *
 * Base is `https://api.commandcode.ai/provider` — note the `/provider` segment.
 * The host root serves the CLI's own private backend (`/alpha/*`), which is a
 * different surface entirely; probing `api.commandcode.ai/v1/chat/completions`
 * returns 404 and means nothing about this API.
 *
 * Auth is `Authorization: Bearer <key>`, and per the docs "the same key
 * authenticates the CLI and the API". It is created in Studio
 * (https://commandcode.ai/studio#api-keys) and stored in VS Code SecretStorage,
 * never in settings.json.
 */

export const PROVIDER_BASE_URL = 'https://api.commandcode.ai/provider';
export const MODELS_URL = `${PROVIDER_BASE_URL}/v1/models`;

/** Go is the one plan with no API access; the server reports it as this code. */
export const UPGRADE_REQUIRED = 'upgrade_required';

export interface ApiErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: string;
  };
}

/** One error from the API, normalised across the OpenAI and Anthropic envelopes. */
export class ProviderApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderApiError';
  }

  /**
   * True when the failure is the plan gate: the user is on Go, which is the
   * only plan without API access. Surfaced verbatim rather than guessed at,
   * because the vendor's docs are explicit that a plan cannot be read
   * headlessly — this response IS the oracle.
   */
  get isPlanGate(): boolean {
    return this.status === 403 && this.code === UPGRADE_REQUIRED;
  }
}

export interface ApiClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to the global AbortSignal. */
  readonly timeoutMs?: number;
  /** Send `x-cmd-zdr: 1`. Narrows the accepted tool set — see api/tools.ts. */
  readonly zeroDataRetention?: boolean;
}

/**
 * Parse an error body from either envelope. The OpenAI shape puts the code on
 * `error.code`; the Anthropic shape has only a `type`, so a missing code falls
 * back to the type rather than being invented.
 */
async function readError(response: Response): Promise<ProviderApiError> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // A non-JSON error body (a proxy 502, say) is still a real error; report the
    // status rather than inventing a code.
  }
  const code = body.error?.code ?? body.error?.type ?? `http_${response.status}`;
  const message =
    body.error?.message ?? `Command Code API returned ${response.status} with no message.`;
  return new ProviderApiError(response.status, code, message);
}

export class ProviderApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.baseUrl ?? PROVIDER_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Headers every request carries. `Accept: text/event-stream` is set per call. */
  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
      Accept: accept,
    };
    if (this.options.zeroDataRetention === true) {
      // Enforces no prompt training and ZDR-only routing. A model with no
      // ZDR-capable upstream fails with 422 rather than silently downgrading.
      headers['x-cmd-zdr'] = '1';
    }
    return headers;
  }

  /**
   * POST JSON and return the raw response for streaming callers.
   *
   * @throws ProviderApiError on any non-2xx
   */
  async post(path: string, body: unknown, accept = 'application/json'): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 600_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(accept),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw await readError(response);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET JSON, or null when the request fails — used for the optional model list. */
  async getJson<T>(path: string): Promise<T | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers('application/json'),
      });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as T;
    } catch {
      // A network failure must not empty the picker; the shipped catalog is the
      // fallback and the caller degrades to it.
      return null;
    }
  }
}

/** One entry from `GET /provider/v1/models`. */
export interface ApiModel {
  readonly id: string;
  /** Routes that serve this model, e.g. ["/v1/messages"]. Read, never guessed. */
  readonly supported_endpoints?: readonly string[];
}

/**
 * The route to call for a model id.
 *
 * Delegates to the generated table in `./endpoints.ts`, which is transcribed
 * from `GET /provider/v1/models` — a public, unauthenticated endpoint. That
 * matters: routing on "Claude ⇒ /messages, else /responses" looks right and is
 * wrong twice over. It sends the 9 chat-completions-only models to a route that
 * refuses them ("Model … is not available on this endpoint"), and it misreads
 * newer Claude models. The server says which route serves what, so we read it.
 *
 * Kept as a re-export so callers have one import for the surface, and so this
 * function is the single place a route is chosen.
 */
export { routeFor as endpointFor } from './endpoints.js';
