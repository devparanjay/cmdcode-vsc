import { describe, expect, it } from 'vitest';

import { toPresentation, type ErrorPresentation } from '../src/errors.js';
import { CliError, type CliErrorCode } from '../src/types.js';

// No `vscode` import anywhere in this file: errors.ts must be importable from a
// plain vitest run with no alias and no stub (AC-6).

/** The 16 codes, written out by hand rather than derived from the type. */
const ALL_CODES: readonly CliErrorCode[] = [
  'cli-not-found',
  'cli-too-old',
  'spawn-failed',
  'timeout',
  'interrupted',
  'auth',
  'plan-gated',
  'rate-limited',
  'network',
  'server',
  'permission',
  'max-turns',
  'no-response',
  'insufficient-credits',
  'malformed-stream',
  'unknown',
];

/** The three registered targets. §4.2: three actions exist, no fourth. */
const COMMANDS: readonly string[] = [
  'workbench.action.openSettings',
  'cmdcode.showLog',
  'cmdcode.copyDiagnostics',
];

/** Hostile payload: an absolute path, a catalog model id and a stderr blob. */
const HOSTILE_STDERR =
  'Error: unknown model "stealth/space-bunny-alpha".\n' +
  '  at /Users/x/dev/cmdcode-vsc/src/cli/process.ts:214:19\n' +
  '  argv: /opt/homebrew/bin/cmd -p hi --output-format json -m stealth/space-bunny-alpha';

function present(code: CliErrorCode, stderr = ''): ErrorPresentation {
  return toPresentation(new CliError(code, `internal ${code} detail`, { stderr }));
}

describe('toPresentation', () => {
  it('is total over the 16 CliErrorCode values', () => {
    expect(ALL_CODES).toHaveLength(16);
    for (const code of ALL_CODES) {
      const presentation = present(code);
      expect(presentation, `no presentation for ${code}`).toBeDefined();
      expect(typeof presentation.message).toBe('string');
    }
  });

  it('renders the exact architecture 4.2 copy for every code', () => {
    expect(present('cli-not-found')).toEqual({
      message:
        'Command Code CLI not found. Install it with `npm i -g command-code`, or set `cmdcode.cliPath`.',
      action: 'Open Settings',
      command: 'workbench.action.openSettings',
    });
    expect(present('cli-too-old')).toEqual({
      message: 'This Command Code CLI is too old. Update it with `npm i -g command-code@latest`.',
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
    expect(present('spawn-failed')).toEqual({
      message: 'Command Code could not be started. See the Command Code log.',
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
    expect(present('timeout')).toEqual({
      message: "Command Code didn't finish in time. Raise `cmdcode.timeoutSeconds` or narrow the request.",
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
    expect(present('interrupted')).toEqual({
      message: 'Command Code was interrupted.',
      action: null,
      command: null,
    });
    expect(present('auth')).toEqual({
      message: 'Not signed in to Command Code. Run `cmd login` in a terminal.',
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
    expect(present('plan-gated')).toEqual({
      message: "Your Command Code plan doesn't include that model.",
      action: 'Copy Diagnostics',
      command: 'cmdcode.copyDiagnostics',
    });
    expect(present('rate-limited')).toEqual({
      message: 'Rate limited by Command Code. Try again shortly.',
      action: 'Copy Diagnostics',
      command: 'cmdcode.copyDiagnostics',
    });
    expect(present('insufficient-credits')).toEqual({
      message: 'Out of Command Code credits.',
      action: 'Copy Diagnostics',
      command: 'cmdcode.copyDiagnostics',
    });
    expect(present('permission')).toEqual({
      message: "Command Code needs a permission it wasn't given.",
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
    expect(present('network')).toEqual({
      message: "Can't reach Command Code. Check your connection.",
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
    expect(present('server')).toEqual({
      message: "Command Code's servers returned an error.",
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
    expect(present('max-turns')).toEqual({
      message: 'Stopped at the turn limit. Narrow the request.',
      action: 'Copy Diagnostics',
      command: 'cmdcode.copyDiagnostics',
    });
    expect(present('no-response')).toEqual({
      message: 'Command Code ended without an answer. See the Command Code log.',
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
    expect(present('malformed-stream')).toEqual({
      message: "Command Code sent output this extension couldn't read. See the Command Code log.",
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
    expect(present('unknown')).toEqual({
      message: 'Command Code failed. See the Command Code log.',
      action: 'Show Log',
      command: 'cmdcode.showLog',
    });
  });

  it('gives every non-null command one of the three registered ids', () => {
    const seen = new Set<string>();
    for (const code of ALL_CODES) {
      const { command } = present(code);
      if (command === null) {
        continue;
      }
      expect(COMMANDS, `${code} points at an unregistered command`).toContain(command);
      seen.add(command);
    }
    // No fourth action: the table must not invent one.
    expect([...seen].sort()).toEqual([...COMMANDS].sort());
  });

  it('leaves interrupted with no action and no command', () => {
    const { action, command } = present('interrupted');
    expect(action).toBeNull();
    expect(command).toBeNull();
  });

  it('leaks neither stderr, an absolute path, nor a catalog model id', () => {
    for (const code of ALL_CODES) {
      const clean = present(code).message;
      const dirty = present(code, HOSTILE_STDERR).message;
      // Hostile stderr changes nothing — the mapping is keyed on code alone.
      expect(dirty, `${code} varies with stderr`).toBe(clean);
      expect(clean, `${code} leaks stderr text`).not.toContain('unknown model');
      expect(clean, `${code} leaks an absolute path`).not.toMatch(/(^|\s)\/[A-Za-z0-9._-]+\//);
      expect(clean, `${code} leaks a catalog model id`).not.toContain('stealth/');
      expect(clean, `${code} leaks the internal Error message`).not.toContain(`internal ${code}`);
    }
  });

  it('keeps stderr on the error, for the output channel only', () => {
    const error = new CliError('server', 'HTTP 503 from POST /alpha/generate', {
      stderr: HOSTILE_STDERR,
      exitCode: 7,
    });
    expect(error.stderr).toBe(HOSTILE_STDERR);
    expect(error.exitCode).toBe(7);
    expect(error.code).toBe('server');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CliError');

    expect(toPresentation(error).message).not.toContain('alpha/generate');
  });

  it('defaults stderr to empty and exitCode to null', () => {
    const error = new CliError('unknown', 'boom');
    expect(error.stderr).toBe('');
    expect(error.exitCode).toBeNull();
  });
});
