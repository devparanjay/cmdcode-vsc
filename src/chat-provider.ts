import * as vscode from 'vscode';

import { findModelByChatId } from './catalog.js';
import { toChatInformation } from './catalog-to-chat.js';
import { toPresentation } from './errors.js';
import { isSupportedImage, stageImage } from './images.js';
import { buildPrompt } from './prompt.js';
import { TranscriptStore } from './transcript.js';
import {
  CliError,
  VENDOR_ID,
  type CatalogModel,
  type CliTransport,
  type CmdCodeConfig,
  type Logger,
  type RunSummary,
} from './types.js';

const EMPTY_RESPONSE_MESSAGE =
  'Command Code finished without returning any text. See the Command Code log.';

/**
 * Verified averages: 18570/3, 18577/60, 18601/3 input/output. Exact tokenization
 * would need a subprocess round-trip, which costs seconds and makes model
 * budgeting unusable — the estimate is documented as such in the README.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Stage every image in the live message to disk and return the paths.
 *
 * Fails soft: a part that is not a usable image, or a file that cannot be
 * written, is skipped rather than failing the turn. A missing image is a
 * degradation; a thrown error would be a broken chat.
 */
function stageImages(message: vscode.LanguageModelChatRequestMessage | undefined): string[] {
  if (message === undefined) {
    return [];
  }
  const paths: string[] = [];
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      continue;
    }
    const record = part as { mimeType?: unknown; data?: unknown };
    if (typeof record.mimeType !== 'string' || !(record.data instanceof Uint8Array)) {
      continue;
    }
    if (!isSupportedImage(record.mimeType)) {
      continue;
    }
    try {
      paths.push(stageImage({ mimeType: record.mimeType, data: record.data }));
    } catch {
      // A staging failure is reported by the caller's part count, not thrown.
    }
  }
  return paths;
}

/**
 * The single integration point between VS Code and the Command Code CLI.
 *
 * Per turn this is stateless: one spawn, one stream, no long-lived process (D1).
 * The only state is the {@link TranscriptStore}, keyed by model id, and it is
 * written only after a turn succeeds (§4.9) so a failed run never poisons it.
 */
export class CmdCodeChatProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  /** Advertised so VS Code re-queries the model list. */
  readonly onDidChangeLanguageModelChatInformation?: vscode.Event<void> =
    this.onDidChangeEmitter.event;

  constructor(
    private readonly catalog: readonly CatalogModel[],
    private readonly transport: CliTransport,
    private readonly store: TranscriptStore,
    private readonly log: Logger,
    private readonly workspaceFsPath: string,
    private readonly config: CmdCodeConfig,
  ) {}

  /**
   * Synchronous, total and I/O-free. The model picker must never block on a
   * subprocess, which is exactly why the catalog is an embedded literal (D4).
   *
   * `options.silent` needs no special handling: the full list is returned
   * unconditionally and nothing here prompts, so there is nothing to suppress.
   */
  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return toChatInformation(
      this.catalog,
      this.workspaceFsPath,
      {
        // Declared true so the models are selectable in EVERY Copilot session,
        // Agent included, and so a pin actually reaches the picker. This is not a
        // claim that Copilot drives the CLI's tools — it never does, because the
        // CLI runs them in-process and never yields. It is a claim that a Cmd
        // Code model *can* call tools, which is true, and the difference matters
        // because VS Code's Agent filter drops every model that says false:
        //
        //   uZi(m, kind) = kind === "agent" ? suitableForAgentMode(m) : true
        //
        // With false, pinning a CLI model produced a pin that could never
        // resolve into the picker, which reads as "pinned models do not work"
        // rather than as an honest limitation. The API group is where Copilot's
        // own tools and browser control actually run; the README says so.
        toolCalling: true,
        // Images work here, but only when the CLI is told to read them —
        // headless mode has no way to ask the user.
        imagesAvailable: this.config.imageSupport,
      },
      VENDOR_ID,
    );
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
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

    const cwd = this.workspaceFsPath;

    // The CLI reads images from a *path in the prompt*, so the bytes are staged
    // to a content-addressed file and the prompt names it. Only the live turn
    // carries them — the vendor documents that older messages' images are no
    // longer readable, and a stale path would be worse than nothing.
    const imagePaths = this.config.imageSupport ? stageImages(messages[messages.length - 1]) : [];
    if (imagePaths.length > 0) {
      this.log.info(`staged ${imagePaths.length} image(s) for the CLI to read`);
    }

    const built = await buildPrompt(messages, {
      model: catalogModel.id,
      cwd,
      maxChars: this.config.maxPromptChars,
      imagePaths,
    });
    if (built.truncatedChars > 0) {
      this.log.info(`prompt truncated: -${built.truncatedChars} chars`);
    }

    const resumeSessionId = this.store.get(model.id);

    // No placeholder is reported here. The CLI needs ~3-4 s to produce its first
    // token (§6.2), and this used to fill that silence with a `Working…` text
    // part — but every part reported to `progress` becomes response *content*.
    // VS Code concatenates them into the answer with no retract, so the
    // placeholder was permanently prefixed to the model's reply:
    //
    //   "Working…Hello! I'm working in the cmdcode-vsc VS Code extension…"
    //
    // The stable API offers no non-content channel for this. `LanguageModelResponsePart`
    // is a closed union of `LanguageModelTextPart | LanguageModelToolResultPart |
    // LanguageModelToolCallPart` — all of which are content — and
    // `ProvideLanguageModelChatResponseOptions` carries no `progress` handle. The
    // CLI's own tool loop has no streaming status to forward either.
    //
    // Copilot renders its own pending state while awaiting the provider, so the
    // wait is still visibly busy; a fake token is not needed to avoid a spinner.
    // See docs/verification.md §11.13.

    // The transport is not a caller: it fills these in from callbacks, which
    // control-flow analysis cannot follow. A mutable record (rather than four
    // `let`s) keeps the compiler from narrowing them to `null` past the await,
    // and keeps the §4.10 step order readable as written.
    const captured: {
      failure: CliError | null;
      pendingSessionId: string | null;
      sawDelta: boolean;
      summary: RunSummary | null;
    } = { failure: null, pendingSessionId: null, sawDelta: false, summary: null };

    // Registered BEFORE the await: a subscription created after it can never
    // observe a cancellation that arrives during the run (§4.10 step 8).
    const cancelSub = token.onCancellationRequested(() => {
      this.log.info('cancellation requested; sending SIGTERM');
      // Fire-and-forget: `run` still settles on its own, through onError.
      void this.transport.cancel();
    });

    try {
      await this.transport.run(
        {
          prompt: built.text,
          model: catalogModel.id,
          maxTurns: this.config.maxTurns,
          resumeSessionId,
          cwd,
          timeoutMs: this.config.timeoutMs,
          readImages: imagePaths.length > 0,
        },
        {
          onTextDelta: (delta: string) => {
            captured.sawDelta = true;
            progress.report(new vscode.LanguageModelTextPart(delta));
          },
          onSessionId: (sessionId: string) => {
            captured.pendingSessionId = sessionId;
          },
          // Capture, never throw: `run` is contractually incapable of rejecting
          // (§4.1), so a throw here would be swallowed by the transport.
          onError: (error: CliError) => {
            captured.failure = error;
          },
          onDone: (summary: RunSummary) => {
            captured.summary = summary;
          },
        },
      );
    } finally {
      // Every exit path, including the throwing one (§4.10 step 12).
      cancelSub.dispose();
    }

    const { failure, summary, pendingSessionId } = captured;

    if (failure !== null) {
      this.log.error(`[${failure.code}] ${failure.message}\n${failure.stderr}`);
      // A user-initiated cancel must not raise an error dialog (§5.3).
      if (failure.code === 'interrupted') {
        return;
      }
      // The only throw site for a run error, and the only place a user-safe
      // message is attached. Raw stderr stays in the log above.
      throw new CliError(failure.code, toPresentation(failure).message, {
        stderr: failure.stderr,
        exitCode: failure.exitCode,
      });
    }

    if (summary !== null) {
      const sessionId = summary.sessionId ?? pendingSessionId;
      if (sessionId !== null) {
        // Persist only on success: onSessionId fires at run_start, so a turn
        // that then failed would otherwise leave an id pointing at a transcript
        // with no answer in it (§4.9).
        this.store.set(model.id, sessionId);
      }
    }

    // Precedence (§4.10 step 15): deltas are the answer, so anything they already
    // produced is never duplicated by summary.text.
    if (captured.sawDelta) {
      return;
    }
    const text = summary?.text ?? '';
    progress.report(
      new vscode.LanguageModelTextPart(text.trim() !== '' ? text : EMPTY_RESPONSE_MESSAGE),
    );
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(Math.ceil(this.countChars(text) / CHARS_PER_TOKEN));
  }

  /**
   * Fire onDidChangeLanguageModelChatInformation so VS Code re-queries the model
   * list. The catalog is an embedded literal, so this re-renders the same 82
   * entries; it exists so the model picker refreshes without a window reload.
   */
  refreshModelInformation(): void {
    this.onDidChangeEmitter.fire();
  }

  /**
   * The two arms of the union are narrowed separately: a request message has
   * `.content`, not `.length`. Non-text parts contribute 0 — the same rule the
   * prompt builder uses, so counting and rendering never disagree (§4.10).
   */
  private countChars(text: string | vscode.LanguageModelChatRequestMessage): number {
    if (typeof text === 'string') {
      return text.length;
    }
    let count = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        count += part.value.length;
      }
    }
    return count;
  }
}
