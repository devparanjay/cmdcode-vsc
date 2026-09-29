import { CliError, type CliErrorCode } from './types.js';

export interface ErrorPresentation {
  /** Short, user-facing sentence. Never contains stderr, paths, or model ids. */
  readonly message: string;
  /** Notification button label, or null when there is no action. */
  readonly action: string | null;
  /** Built-in or `cmdcode.*` command the label invokes, or null. */
  readonly command: string | null;
}

const SHOW_LOG: ErrorPresentation['action'] = 'Show Log';
const COPY_DIAGNOSTICS: ErrorPresentation['action'] = 'Copy Diagnostics';

/**
 * The ONLY mapping from CliErrorCode to user-visible copy. Total: every code in
 * the union has an entry, and no entry mentions stderr.
 *
 * Copy is keyed on `error.code` alone — never on the message, stderr or exit
 * code — so the detail (which model, which stderr line) can only reach the
 * output channel. `interrupted` has a row so the switch stays exhaustive even
 * though §5.3 swallows that code before it is ever rendered.
 */
export function toPresentation(error: CliError): ErrorPresentation {
  const code: CliErrorCode = error.code;
  switch (code) {
    case 'cli-not-found':
      return {
        message:
          'Command Code CLI not found. Install it with `npm i -g command-code`, or set `cmdcode.cliPath`.',
        action: 'Open Settings',
        command: 'workbench.action.openSettings',
      };
    case 'cli-too-old':
      return {
        message: 'This Command Code CLI is too old. Update it with `npm i -g command-code@latest`.',
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
    case 'spawn-failed':
      return {
        message: 'Command Code could not be started. See the Command Code log.',
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
    case 'timeout':
      return {
        message: "Command Code didn't finish in time. Raise `cmdcode.timeoutSeconds` or narrow the request.",
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
    case 'interrupted':
      return {
        message: 'Command Code was interrupted.',
        action: null,
        command: null,
      };
    case 'auth':
      return {
        message: 'Not signed in to Command Code. Run `cmd login` in a terminal.',
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
    case 'plan-gated':
      return {
        message: "Your Command Code plan doesn't include that model.",
        action: COPY_DIAGNOSTICS,
        command: 'cmdcode.copyDiagnostics',
      };
    case 'rate-limited':
      return {
        message: 'Rate limited by Command Code. Try again shortly.',
        action: COPY_DIAGNOSTICS,
        command: 'cmdcode.copyDiagnostics',
      };
    case 'insufficient-credits':
      return {
        message: 'Out of Command Code credits.',
        action: COPY_DIAGNOSTICS,
        command: 'cmdcode.copyDiagnostics',
      };
    case 'permission':
      return {
        message: "Command Code needs a permission it wasn't given.",
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
    case 'network':
      return {
        message: "Can't reach Command Code. Check your connection.",
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
    case 'server':
      return {
        message: "Command Code's servers returned an error.",
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
    case 'max-turns':
      return {
        message: 'Stopped at the turn limit. Narrow the request.',
        action: COPY_DIAGNOSTICS,
        command: 'cmdcode.copyDiagnostics',
      };
    case 'no-response':
      return {
        message: 'Command Code ended without an answer. See the Command Code log.',
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
    case 'malformed-stream':
      return {
        message: "Command Code sent output this extension couldn't read. See the Command Code log.",
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
    case 'unknown':
      return {
        message: 'Command Code failed. See the Command Code log.',
        action: SHOW_LOG,
        command: 'cmdcode.showLog',
      };
  }
}
