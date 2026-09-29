import * as vscode from 'vscode';

import { MODELS } from './catalog.js';
import type { ResolvedCli } from './cli/resolve.js';
import type { CliTransport, CmdCodeConfig, Logger, RunSummary } from './types.js';
import type { CmdCodeChatProvider } from './chat-provider.js';

/**
 * The last terminal outcome of a run, kept for `cmdcode.copyDiagnostics`.
 *
 * §4.11 requires the diagnostics bundle to carry "the last `RunSummary` … or the
 * last `CliError` code", but neither `CliTransport` nor `CmdCodeChatProvider`
 * retains one: a `run` is a single turn's worth of state, and the store keeps
 * session ids, not outcomes. The recorder is therefore a thin observer that
 * `extension.ts` installs around `CliTransportImpl.run` — it changes nothing
 * about the run itself (the contract that `run` never rejects is untouched),
 * it only remembers the last terminal callback for the diagnostics command.
 */
export interface LastRun {
  readonly summary: RunSummary | null;
  readonly errorCode: string | null;
}

/**
 * A transport that additionally exposes its last terminal outcome.
 *
 * `CliTransport` is the contract every other consumer programs against, and
 * `FakeTransport` implements it without this extra method; reading through
 * `lastRunOf` keeps both usable and only degrades the diagnostics bundle when
 * nothing recorded a run yet.
 */
export interface TransportWithLastRun extends CliTransport {
  lastRun(): LastRun;
}

/** Reads a transport's recorded outcome, or the empty one when it records none. */
export function lastRunOf(transport: CliTransport): LastRun {
  const candidate = transport as Partial<TransportWithLastRun>;
  return typeof candidate.lastRun === 'function'
    ? candidate.lastRun()
    : { summary: null, errorCode: null };
}

/** `cmd --version` costs 0.65 s (§6.2) — worth it here and nowhere else. */
const VERSION_TIMEOUT_MS = 5_000;

/** Command ids. All `cmdcode.*`; the vendor owns `commandcode.*` (§4.11). */
export const COMMAND_IDS = Object.freeze({
  showLog: 'cmdcode.showLog',
  copyDiagnostics: 'cmdcode.copyDiagnostics',
  restartProvider: 'cmdcode.restartProvider',
});

const COPIED_MESSAGE = 'Cmd Code diagnostics copied.';

/**
 * `cmd --version` for the diagnostics bundle.
 *
 * Spawned without a shell, through `child_process` rather than through the
 * transport: the transport's `run` speaks the NDJSON turn protocol, and this is
 * a plain flag. A failure is reported as text, never thrown — a user asking for
 * diagnostics on a broken install must still get a bundle.
 */
async function readCliVersion(
  cli: { command: string; args: readonly string[] } | null,
): Promise<string> {
  if (cli === null) {
    return 'unknown (no CLI resolved)';
  }
  const { execFile } = await import('node:child_process');
  return new Promise<string>((resolve) => {
    try {
      execFile(
        cli.command,
        [...cli.args, '--version'],
        { timeout: VERSION_TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => {
          if (error !== null) {
            resolve(`unknown (${error.message.split('\n')[0]})`);
            return;
          }
          const text = `${stdout}${stderr}`.trim();
          resolve(text === '' ? 'unknown (no output)' : text.split('\n')[0]);
        },
      );
    } catch (error) {
      resolve(`unknown (${error instanceof Error ? error.message : String(error)})`);
    }
  });
}

/**
 * Registers the three commands (§4.11).
 *
 * Every registration is pushed to `context.subscriptions` so deactivation
 * disposes them: a command left registered after its extension unloads is a
 * handler bound to a disposed provider.
 *
 * @param resolved the CLI located at activation. Passed in rather than
 *                  re-resolved because §6.2 memoizes resolution here, and
 *                  `describe()` can only give back a display string — the
 *                  `--version` probe needs the command and its argv.
 * @param config   the `CmdCodeConfig` read once at activation; the diagnostics
 *                 bundle reports it verbatim so a bug report carries the values
 *                 the extension was actually running with.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  provider: CmdCodeChatProvider,
  transport: CliTransport,
  log: Logger,
  channel: vscode.OutputChannel,
  resolved: ResolvedCli | null,
  config: CmdCodeConfig,
): void {
  const register = (id: string, callback: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, callback));
  };

  register(COMMAND_IDS.showLog, () => {
    // `true` keeps the editor focus: revealing a log must not steal keystrokes.
    channel.show(true);
    log.info('Cmd Code: log revealed by cmdcode.showLog');
  });

  register(COMMAND_IDS.copyDiagnostics, async () => {
    const described = await transport.describe();
    const version = await readCliVersion(resolved);
    const last = lastRunOf(transport);
    const bundle = {
      cli: described ?? 'not resolved',
      version,
      config,
      models: MODELS.length,
      lastRun:
        last.summary !== null
          ? {
              sessionId: last.summary.sessionId,
              usage: last.summary.usage,
              durationMs: last.summary.durationMs,
            }
          : null,
      lastError: last.errorCode,
    };
    const text = JSON.stringify(bundle, null, 2);
    await vscode.env.clipboard.writeText(text);
    log.info(`Cmd Code: diagnostics copied (${bundle.models} models, cli ${bundle.cli})`);
    await vscode.window.showInformationMessage(COPIED_MESSAGE);
  });

  register(COMMAND_IDS.restartProvider, () => {
    // A re-query, not a reload: the catalog is an embedded literal, so this
    // fires the change event and VS Code calls provideLanguageModelChatInformation
    // again. Nothing is re-read and nothing is re-spawned.
    provider.refreshModelInformation();
    log.info('Cmd Code: model list refresh requested');
  });
}
