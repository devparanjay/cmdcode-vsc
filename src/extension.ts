import * as vscode from 'vscode';

import { CmdCodeChatProvider } from './chat-provider.js';
import { CliTransportImpl } from './cli/process.js';
import { resolveCli, supportsJsonOutput, type ResolvedCli } from './cli/resolve.js';
import { MODELS } from './catalog.js';
import { registerCommands } from './commands.js';
import { toPresentation } from './errors.js';
import { TranscriptStore } from './transcript.js';
import {
  CliError,
  CONFIG_DEFAULTS,
  VENDOR_ID,
  createLogger,
  type CliTransport,
  type CmdCodeConfig,
  type LogLevel,
  type Logger,
  type RunHandlers,
  type RunRequest,
  type RunSummary,
} from './types.js';

/**
 * Extension entry point. `activate` is the whole wiring tree's root: it is the
 * only place `vscode.workspace.getConfiguration` is called, the only place the
 * CLI is resolved, and the only place a provider is registered.
 *
 * **The order below is normative** (architecture §4.11) and is not an
 * implementation detail:
 *
 *  1. the output channel, pushed to `context.subscriptions` first so that every
 *     later step has somewhere to log, even the degraded ones;
 *  2. configuration, read exactly once (§6.3 — settings are deliberately not
 *     live, so a reload is what applies a change);
 *  3. CLI resolution, then the JSON capability probe. Both are one-shot
 *     subprocess work, done here so the per-turn path never pays for them;
 *  4. store, transport, provider;
 *  5. the provider registration under `VENDOR_ID`;
 *  6. the commands.
 *
 * Steps 3's two failure modes return early and register nothing. That is the
 * point: a provider whose every request fails is worse than an absent one, so a
 * broken install degrades to "no Command Code models" rather than to an error on
 * every chat. `activate` therefore never throws.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 1. The channel is created first and pushed immediately: steps 3-4 log
  // through it, and a channel nothing holds would leak on deactivation.
  const channel = vscode.window.createOutputChannel('Command Code');
  context.subscriptions.push(channel);

  // 2. Read once. Everything downstream takes the captured `CmdCodeConfig`.
  const config = readConfig();
  const log = createLogger(channel, config.logLevel);
  log.info(`Command Code: activating (logLevel=${config.logLevel}, models=${MODELS.length})`);

  // 3. Resolve the CLI. A null result is `cli-not-found`; the diagnostic
  // message lives in errors.ts, so the copy has exactly one home.
  let resolved: ResolvedCli | null;
  try {
    resolved = await resolveCli(config.cliPath || undefined);
  } catch (error) {
    resolved = null;
    log.error(
      `Command Code: resolveCli threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (resolved === null) {
    reportUsabilityFailure(
      new CliError('cli-not-found', 'resolveCli() returned null'),
      log,
    );
    return;
  }
  log.info(`Command Code: CLI resolved to ${resolved.command} (${resolved.source})`);

  // 4. The capability probe. Same shape as step 3, different copy.
  let supported: boolean;
  try {
    supported = await supportsJsonOutput(resolved);
  } catch (error) {
    supported = false;
    log.error(
      `Command Code: supportsJsonOutput threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!supported) {
    reportUsabilityFailure(
      new CliError('cli-too-old', 'supportsJsonOutput() returned false'),
      log,
    );
    return;
  }

  // 5. Build the object graph. The resolver result is captured by the transport
  // rather than re-run per turn (§6.2: `resolveCli` is memoized at activation,
  // so a turn never pays for resolution).
  const store = new TranscriptStore();
  const transport = new RecordingTransport(
    new CliTransportImpl(async () => resolved, log),
    log,
  );
  const provider = new CmdCodeChatProvider(
    MODELS,
    transport,
    store,
    log,
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    config,
  );

  // 6. The provider, then 7. the commands. Both are pushed to
  // `context.subscriptions`, so deactivation unregisters them.
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider));
  registerCommands(context, provider, transport, log, channel, resolved, config);
  log.info('Command Code: activated');
}

/**
 * The single call site of `vscode.workspace.getConfiguration` (architecture
 * §6.1), and the only place the clamps live.
 *
 * Every clamp here is load-bearing and applies exactly once:
 *
 *  - `maxTurns` is rounded and clamped to 1-100 because it becomes
 *    `--max-turns`; the CLI rejects 0 and negative values, and a value above
 *    100 is a typo rather than an intent.
 *  - `timeoutSeconds` is floored at 0 (0 is the documented "no deadline"
 *    sentinel, so a negative value must clamp to it rather than pass through)
 *    and multiplied by 1000 to become `timeoutMs`.
 *  - `maxPromptChars` is floored at 1000: below that the cap would truncate the
 *    envelope itself, leaving nothing to send.
 *  - `cliPath` is trimmed so a pasted path with a trailing newline still
 *    resolves, and so an all-whitespace value reads as "auto-resolve".
 *
 * A non-finite or missing value falls back to `CONFIG_DEFAULTS` — the same
 * default `package.json` declares, so a corrupt `settings.json` degrades to
 * the documented behaviour rather than to `NaN` reaching a child process.
 */
function readConfig(): CmdCodeConfig {
  const c = vscode.workspace.getConfiguration('cmdcode');
  const maxTurns = c.get<number>('maxTurns', CONFIG_DEFAULTS.maxTurns);
  const timeoutSeconds = c.get<number>('timeoutSeconds', CONFIG_DEFAULTS.timeoutMs / 1000);
  const maxPromptChars = c.get<number>('maxPromptChars', CONFIG_DEFAULTS.maxPromptChars);
  return {
    cliPath: c.get<string>('cliPath', CONFIG_DEFAULTS.cliPath).trim(),
    maxTurns: Number.isFinite(maxTurns)
      ? Math.min(100, Math.max(1, Math.round(maxTurns)))
      : CONFIG_DEFAULTS.maxTurns,
    timeoutMs: Number.isFinite(timeoutSeconds)
      ? Math.max(0, Math.round(timeoutSeconds) * 1000)
      : CONFIG_DEFAULTS.timeoutMs,
    maxPromptChars: Number.isFinite(maxPromptChars)
      ? Math.max(1_000, Math.round(maxPromptChars))
      : CONFIG_DEFAULTS.maxPromptChars,
    logLevel: c.get<LogLevel>('logLevel', CONFIG_DEFAULTS.logLevel),
  };
}

/**
 * The one degraded-path presentation: log the code, then show the user-facing
 * message from `toPresentation` (§4.2) as an error. The action label, if the
 * copy has one, is not rendered — `showErrorMessage` is called with the message
 * alone so the user is never invited into a command this activation did not
 * register.
 */
function reportUsabilityFailure(error: CliError, log: Logger): void {
  log.error(`Command Code: [${error.code}] ${error.message}`);
  const presentation = toPresentation(error);
  void vscode.window.showErrorMessage(presentation.message);
}

/**
 * `CliTransportImpl` plus one thing it does not do: remember the last terminal
 * outcome, so `cmdcode.copyDiagnostics` can report it (§4.11).
 *
 * The observation is deliberately passive. `run` still never rejects and still
 * resolves on child `close`; this only tees the two terminal callbacks
 * (`onDone` and `onError`) into a field. The most recent outcome wins, and a
 * run that has not finished yet leaves the previous outcome in place, because
 * "last run" for a user filing a bug is the run that produced the symptom.
 */
class RecordingTransport implements CliTransport {
  private last: { summary: RunSummary | null; errorCode: string | null } = {
    summary: null,
    errorCode: null,
  };

  constructor(
    private readonly inner: CliTransport,
    private readonly log: Logger,
  ) {}

  async run(req: RunRequest, handlers: RunHandlers): Promise<void> {
    await this.inner.run(req, {
      onTextDelta: (delta) => {
        handlers.onTextDelta(delta);
      },
      onSessionId: (sessionId) => {
        handlers.onSessionId(sessionId);
      },
      onDone: (summary) => {
        this.last = { summary, errorCode: null };
        handlers.onDone(summary);
      },
      onError: (error) => {
        this.last = { summary: null, errorCode: error.code };
        this.log.debug(`recorded last run: [${error.code}]`);
        handlers.onError(error);
      },
    });
  }

  cancel(): Promise<void> {
    return this.inner.cancel();
  }

  describe(): Promise<string | null> {
    return this.inner.describe();
  }

  /** Consumed by `registerCommands`; not part of the `CliTransport` contract. */
  lastRun(): { summary: RunSummary | null; errorCode: string | null } {
    return this.last;
  }
}

export function deactivate(): void {
  // Every disposable this module created was pushed to `context.subscriptions`
  // in `activate`, and VS Code disposes that list for us. Nothing is left to
  // tear down here — a hand-rolled dispose would double-dispose the channel.
}
