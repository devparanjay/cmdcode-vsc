import * as vscode from 'vscode';

import { findModelByChatId } from './catalog.js';
import { toChatInformation, type TransportCapabilities } from './catalog-to-chat.js';
import { ProviderApiClient, ProviderApiError, endpointFor, type ApiModel } from './api/client.js';
import { readStream, StreamIncompleteError } from './api/stream.js';
import { convertTools, type ApiFunctionTool, type VsCodeTool } from './api/tools.js';
import type { ApiRoute } from './api/endpoints.js';
import { buildImagePromptPart } from './images.js';
import {
  CliError,
  type CatalogModel,
  type CmdCodeConfig,
  type Logger,
} from './types.js';

/**
 * Verified averages: 18570/3, 18577/60, 18601/3 input/output. Exact tokenization
 * would need a round trip per request, which is a poor trade for a number VS
 * Code only uses for a prompt-fit check. The estimate is documented as such.
 */
const CHARS_PER_TOKEN = 4;

/**
 * A `LanguageModelDataPart`, matched structurally.
 *
 * VS Code hands these to providers but they are not in the stable typings yet,
 * so `instanceof` is unavailable. Requiring both a string `mimeType` and a
 * `Uint8Array` `data` is narrow enough not to swallow a text or tool part.
 */
function isDataPart(part: unknown): part is { mimeType: string; data: Uint8Array } {
  if (part === null || typeof part !== 'object') {
    return false;
  }
  const record = part as { mimeType?: unknown; data?: unknown };
  return (
    typeof record.mimeType === 'string' && record.data instanceof Uint8Array
  );
}

/**
 * Choose a route from a server-declared set.
 *
 * Same preference as the generated table: `/responses` when offered (the
 * dialect the tool loop targets), then `/chat/completions`, then `/messages`.
 * Sent here rather than duplicated so a live model list and the baked-in table
 * can never disagree about which is preferred.
 */
function pickRoute(declared: readonly ApiRoute[]): ApiRoute {
  if (declared.includes('/responses')) {
    return '/responses';
  }
  if (declared.includes('/chat/completions')) {
    return '/chat/completions';
  }
  if (declared.includes('/messages')) {
    return '/messages';
  }
  return '/responses';
}

/**
 * The direct-API provider.
 *
 * This is the transport that can actually host VS Code's tool loop. The CLI runs
 * its own tools in-process and never yields, so the CLI provider cannot; here the
 * Provider API passes tool arrays through and the *client* executes them, which
 * is exactly the contract Copilot drives.
 *
 * Stateless per turn, like the CLI provider: one request, streamed back.
 */
export class CommandCodeApiChatProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation?: vscode.Event<void> =
    this.onDidChangeEmitter.event;

  /** What this transport can deliver. The only path with real tool calling. */
  static readonly CAPABILITIES: TransportCapabilities = Object.freeze({
    toolCalling: true,
    imagesAvailable: true,
  });

  constructor(
    private readonly catalog: readonly CatalogModel[],
    private readonly client: ProviderApiClient,
    private readonly log: Logger,
    private readonly workspaceFsPath: string,
    private readonly config: CmdCodeConfig,
    private readonly vendor: string,
    /** Server-declared routes per model; empty when the list could not be fetched. */
    private readonly apiModels: readonly ApiModel[] = [],
  ) {}

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
    // Synchronous and I/O-free: the shipped catalog is returned unconditionally.
    // `apiModels` only refines endpoint routing at request time, so a network
    // failure never empties the picker.
  ): vscode.LanguageModelChatInformation[] {
    return toChatInformation(
      this.catalog,
      this.workspaceFsPath,
      CommandCodeApiChatProvider.CAPABILITIES,
      this.vendor,
    );
  }

  refreshModelInformation(): void {
    this.onDidChangeEmitter.fire();
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }
    const catalogModel = findModelByChatId(model.id, this.workspaceFsPath);
    if (catalogModel === undefined) {
      throw new Error(`Unknown model: ${model.id}`);
    }

    // Route from the model's id against the generated table, which is
    // transcribed from the server's own `supported_endpoints`. A live
    // `apiModels` entry, when we have one, takes precedence so a server-side
    // change lands without a new release.
    const live = this.apiModels.find((m) => m.id === catalogModel.id);
    const endpoint: ApiRoute =
      live !== undefined && live.supported_endpoints !== undefined && live.supported_endpoints.length > 0
        ? pickRoute(live.supported_endpoints as readonly ApiRoute[])
        : endpointFor(catalogModel.id);

    // Tools. `mcp` entries are rewritten to `function` and, under ZDR, anything
    // outside the safe set is removed — the API fails the whole request
    // otherwise, so this is a correctness step and not a nicety.
    const { tools, dropped } = convertTools(
      (options.tools ?? []) as readonly VsCodeTool[],
      this.config.zeroDataRetention,
    );
    for (const d of dropped) {
      this.log.info(`tool "${d.name}" (${d.type}) not sent: ${d.reason}`);
    }
    if (dropped.length > 0) {
      void vscode.window.showWarningMessage(
        `${dropped.length} tool(s) were not sent to Command Code: ${dropped.map((d) => d.name).join(', ')}.`,
      );
    }

    const body = this.buildRequest(
      catalogModel,
      messages,
      tools,
      endpoint,
      this.config.imageSupport,
    );
    // Logged before the call, so a wrong route is diagnosable from the log alone
    // rather than only from the server's error.
    this.log.info(
      `api: POST /provider/v1${endpoint} model=${catalogModel?.id} tools=${tools.length} zdr=${this.config.zeroDataRetention}`,
    );

    let response: Response;
    try {
      response = await this.client.post(`/v1${endpoint}`, body, 'text/event-stream');
    } catch (error) {
      throw this.toUserFacingError(error);
    }

    const subscription = token.onCancellationRequested(() => {
      this.log.info('cancellation requested; aborting API request');
      void response.body?.cancel().catch(() => undefined);
    });

    let sawText = false;
    try {
      await readStream(
        response,
        // Each route speaks its own SSE dialect. Picking the wrong decoder would
        // silently yield no text, so this follows the route exactly.
        endpoint === '/messages'
          ? 'anthropic'
          : endpoint === '/chat/completions'
            ? 'chat-completions'
            : 'responses',
        {
          onText: (delta) => {
            sawText = true;
            progress.report(new vscode.LanguageModelTextPart(delta));
          },
          onToolCall: ({ callId, name, input }) => {
            // Hand the call to Copilot. This provider never executes a tool —
            // that inversion is the whole point of the API path.
            progress.report(
              new vscode.LanguageModelToolCallPart(
                callId,
                name,
                (input ?? {}) as Record<string, unknown>,
              ),
            );
          },
          onUsage: (usage) => {
            if (usage.input !== undefined || usage.output !== undefined) {
              this.log.debug(
                `api usage: in=${usage.input ?? '?'} out=${usage.output ?? '?'}`,
              );
            }
          },
        },
      );
    } catch (error) {
      if (token.isCancellationRequested) {
        return;
      }
      throw this.toUserFacingError(error);
    } finally {
      subscription.dispose();
    }

    if (!sawText) {
      // A turn that produced no text and no tool call would render as a hang.
      progress.report(
        new vscode.LanguageModelTextPart(
          'Command Code returned no content. See the Command Code log.',
        ),
      );
    }
  }

  /** Assemble the request body in the dialect the chosen endpoint expects. */
  private buildRequest(
    model: CatalogModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    tools: readonly ApiFunctionTool[],
    endpoint: ApiRoute,
    imageSupport: boolean,
  ): Record<string, unknown> {
    if (endpoint === '/messages') {
      // Anthropic Messages: system is a top-level param, images are typed
      // blocks, and tools are FLAT with `input_schema` — not the nested
      // `{ type, function: { … } }` shape the OpenAI routes use.
      return {
        model: model.id,
        max_tokens: 32_000,
        system: this.renderSystem(),
        messages: messages.map((m) => ({
          role: m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
          content: this.renderContentBlocks(m, 'anthropic', imageSupport),
        })),
        // Omitted when empty: every documented example carries no `tools` key,
        // and an empty array is the likeliest trigger for a schema that expects
        // at least one entry to produce "expected object, received undefined".
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                input_schema: t.function.parameters,
              })),
            }
          : {}),
        stream: true,
      };
    }

    if (endpoint === '/chat/completions') {
      // Nine models serve only this route, so it is not a rare path. It has no
      // `input_image` block: images are `image_url` parts with a data URL, and
      // tool results are a separate `role: "tool"` message keyed by tool_call_id.
      return {
        model: model.id,
        messages: this.renderChatCompletionsMessages(messages, imageSupport),
        ...(tools.length > 0 ? { tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
      };
    }

    // OpenAI Responses.
    return {
      model: model.id,
      instructions: this.renderSystem(),
      input: messages.map((m) => ({
        role: m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
        content: this.renderContentBlocks(m, 'openai', imageSupport),
      })),
      ...(tools.length > 0 ? { tools } : {}),
      stream: true,
    };
  }

  /**
   * Flatten the request into Chat Completions messages.
   *
   * The one structural difference that matters: a tool result is its own
   * message with `role: "tool"` and a `tool_call_id`, not a content block
   * inside the next user turn. Getting this wrong means the model never sees
   * the result of a call Copilot ran for it.
   */
  private renderChatCompletionsMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    imageSupport: boolean,
  ): unknown[] {
    const out: unknown[] = [];
    for (const message of messages) {
      const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
      const content: unknown[] = [];
      const toolCalls: unknown[] = [];

      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          content.push({ type: 'text', text: part.value });
          continue;
        }
        if (isDataPart(part) && imageSupport) {
          const dataUrl = buildImagePromptPart(part);
          if (dataUrl !== null) {
            // `image_url`, not Responses' `input_image`.
            content.push({ type: 'image_url', image_url: { url: dataUrl } });
          }
          continue;
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          });
          continue;
        }
        if (part instanceof vscode.LanguageModelToolResultPart) {
          // Its own message, keyed to the call it answers.
          out.push({
            role: 'tool',
            tool_call_id: part.callId,
            content: part.content
              .map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : ''))
              .join(''),
          });
        }
      }

      if (content.length > 0 || toolCalls.length > 0) {
        const entry: Record<string, unknown> = {
          role: isAssistant ? 'assistant' : 'user',
          content: content.length > 0 ? content : '',
        };
        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls;
        }
        out.push(entry);
      }
    }
    return out;
  }

  /** Project instructions as a system directive, preserving the CLI's cwd. */
  private renderSystem(): string {
    return `You are Command Code, running inside VS Code via the Command Code Provider extension. The workspace root is ${this.workspaceFsPath || '(none)'}.`;
  }

  /**
   * Render one message's parts into the endpoint's content shape.
   *
   * Images become inline data URLs when the model supports them, because the API
   * accepts image content blocks natively. When `imageSupport` is off, or the
   * model is text-only, the part is dropped and counted — a text-only model
   * would otherwise fail the whole request.
   */
  private renderContentBlocks(
    message: vscode.LanguageModelChatRequestMessage,
    dialect: 'anthropic' | 'openai',
    imageSupport: boolean,
  ): unknown[] {
    const parts: unknown[] = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        parts.push({ type: 'text', text: part.value });
        continue;
      }
      // `LanguageModelDataPart` is delivered to providers by VS Code but is not
      // yet in the stable typings, so it is matched structurally. A part that
      // is neither text nor image-shaped is dropped rather than guessed at.
      if (isDataPart(part)) {
        if (imageSupport) {
          const dataUrl = buildImagePromptPart(part);
          if (dataUrl !== null) {
            parts.push(
              dialect === 'anthropic'
                ? { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }
                : { type: 'input_image', image_url: dataUrl },
            );
            continue;
          }
        }
        this.log.debug(`dropped unsupported or oversized data part (${part.mimeType})`);
        continue;
      }
      if (part instanceof vscode.LanguageModelToolResultPart) {
        // The result of a call Copilot ran for us; hand it back verbatim.
        parts.push({
          type: 'function_call_output',
          call_id: part.callId,
          output: part.content
            .map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : ''))
            .join(''),
        });
        continue;
      }
      if (part instanceof vscode.LanguageModelToolCallPart) {
        parts.push({
          type: 'function_call',
          call_id: part.callId,
          name: part.name,
          arguments: JSON.stringify(part.input),
        });
      }
    }
    return parts;
  }

  /**
   * Local estimate. Exact tokenization would need a call per request, and the
   * API has no cheap counting endpoint, so this is `chars ÷ 4` as documented in
   * the README — approximate, never exact, and never blocking.
   */
  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    if (typeof text === 'string') {
      return Promise.resolve(Math.ceil(text.length / CHARS_PER_TOKEN));
    }
    let count = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        count += part.value.length;
      }
    }
    return Promise.resolve(Math.ceil(count / CHARS_PER_TOKEN));
  }

  /**
   * Map a transport failure onto the CLI's error taxonomy so one presentation
   * layer covers both providers. The plan gate is passed through verbatim: it is
   * the only reliable way to learn the user's plan, and hiding it behind a
   * generic failure would hide a billing problem.
   */
  private toUserFacingError(error: unknown): CliError {
    if (error instanceof ProviderApiError) {
      if (error.isPlanGate) {
        return new CliError('auth', error.message);
      }
      if (error.status === 401) {
        return new CliError('auth', 'The Command Code API key was rejected. Check cmdcode.apiKey.');
      }
      if (error.status === 429) {
        return new CliError('rate-limited', 'The Command Code API is rate limiting this key.');
      }
      if (error.status === 400) {
        return new CliError('no-response', error.message);
      }
      return new CliError('no-response', `Command Code API error (${error.status}): ${error.message}`);
    }
    if (error instanceof StreamIncompleteError) {
      return new CliError('no-response', error.message);
    }
    return new CliError('no-response', error instanceof Error ? error.message : String(error));
  }
}
