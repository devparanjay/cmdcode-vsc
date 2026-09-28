import { spawn } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Locating the Command Code CLI, and probing whether the one we found is new
// enough for the JSON contract.
//
// This module is also the boundary that keeps the extension out of the user's
// Command Code configuration directory. Nothing here reads, writes or creates a
// file under `~/.commandcode/` — in particular the extension-auto-install
// opt-out (`autoInstallExtension: false`, ADR-01) is the user's key alone. The
// only environment key any probe adds is `CI=1`, which the vendor's own
// `ensureIdeExtensionInstalled` checks first (`if (process.env.CI) return`) to
// suppress its auto-installer, so a probe can never cause an install.
//
// One vendor side effect is out of our hands and is NOT a contract violation:
// the CLI creates `~/.commandcode/telemetry-install-id` on *any* invocation,
// including `--version` ✅ (verified against command-code@1.66.0 with an empty
// HOME). It creates no `config.json` and sets no `autoInstallExtension` key, so
// the opt-out this module must not touch is untouched. A probe is a run of
// somebody else's program; the guarantee this module makes is about what *we*
// do, and we write nothing.

/**
 * The probe argv. Fixed here, not shared: no sibling module owns it (§4.5).
 *
 * `--help`, and the decision is read from the flag's own declaration line in
 * the help. Verified against command-code@1.66.0 ✅:
 *
 *   `--output-format json --version` → stdout `1.66.0`, stderr empty, exit 0.
 *
 * The CLI does NOT echo its argv, so that argv cannot be recognised as having
 * been accepted. Nor can the exit status: the same build answers
 * `--totally-bogus-flag --version` with exit 0 ✅, so an unknown flag is not an
 * error and status cannot discriminate. The help text is the one place the
 * vendor *declares* the flag:
 *
 *   `--output-format <format>   -p output: text (default) or json (NDJSON …)`
 *
 * `--help` costs 0.65 s ✅ — the same as `--version`, and a tenth of the 5.1 s
 * `config get` that §4.5 rules out.
 */
const HELP_PROBE_ARGS: readonly string[] = Object.freeze(['--help']);

/** npm package name; the `npm root -g`-relative entry point lives under it. */
const NPM_PACKAGE = 'command-code';

/** npm's entry point inside the package, from the vendor's package.json `bin` ✅. */
const NPM_ENTRY_POINT = join('dist', 'index.mjs');

/**
 * The npm global roots we can name without running `npm root -g`.
 *
 * The architecture deliberately avoids that probe: it is a Node boot plus a
 * config round-trip on the activation path, and the same value is already a
 * pure function of the host layout.
 */
const GLOBAL_NPM_ROOTS: readonly string[] = Object.freeze([
  '/usr/local/lib/node_modules',
  '/usr/lib/node_modules',
  '/opt/homebrew/lib/node_modules',
  '/opt/local/lib/node_modules',
]);

/**
 * Those roots, plus `<npm_config_prefix>/lib/node_modules` when the prefix is
 * set. A version manager (nvm, asdf, volta) puts globals there rather than in
 * `/usr/local`, and announces itself through exactly this variable — so a user
 * whose `cmd` came from nvm has nothing in the fixed list. Reading it also
 * means a caller can redirect the search at a chosen prefix.
 */
function npmGlobalRoots(): readonly string[] {
  const prefix = process.env.npm_config_prefix?.trim();
  if (prefix === undefined || prefix === '') {
    return GLOBAL_NPM_ROOTS;
  }
  return [join(prefix, 'lib', 'node_modules'), ...GLOBAL_NPM_ROOTS];
}

/** True when `candidate` is a file we can actually execute. */
async function isExecutableFile(candidate: string): Promise<boolean> {
  let info;
  try {
    info = await stat(candidate);
  } catch {
    return false;
  }
  if (!info.isFile()) {
    return false;
  }
  try {
    await access(candidate, constants.X_OK);
  } catch {
    return false;
  }
  return true;
}

/** What one probe observed, or null when it never produced a usable result. */
interface ProbeOutcome {
  /** Exit status; null when the child died from a signal. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The single way this module starts a process. Three properties are load-bearing:
 *
 *  - `shell: false` — no probe is ever interpreted by a shell (§4.6).
 *  - a hard deadline — a hung probe resolves `null`/`false` instead of hanging
 *    activation forever.
 *  - `killSignal: 'SIGKILL'` — a probe that ignores SIGTERM (a childless
 *    `process.on('exit')` handler keeps the event loop alive, so SIGTERM is
 *    handleable) is killed outright rather than lingering.
 */
function runProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ProbeOutcome | null> {
  return new Promise<ProbeOutcome | null>((resolve) => {
    // `error` is always followed by `close`, and the deadline can fire after
    // either; one settle, whichever arrives first, is the whole contract.
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (outcome: ProbeOutcome | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        // A finished probe must not keep the extension host's event loop alive.
        clearTimeout(timer);
      }
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The vendor's auto-installer returns immediately under CI (ADR-01).
        env: { ...process.env, CI: '1' },
        killSignal: 'SIGKILL',
      });
    } catch {
      settle(null);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => settle(null));
    child.on('close', (code: number | null) => settle({ code, stdout, stderr }));

    timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGKILL');
            // Settle on the deadline rather than waiting for `close`: a child
            // that traps SIGTERM never closes, and activation must not block
            // on a process that already outlived its budget.
            settle(null);
          }, timeoutMs)
        : undefined;
  });
}

/**
 * Strategy 1 — the `cmdcode.cliPath` setting.
 *
 * A non-empty configured path wins outright: the user told us exactly where the
 * binary is, so we return it without probing, even if it looks wrong. An
 * unusable path falls through, because a stale setting must not make the CLI
 * unreachable when a perfectly good one is on PATH.
 */
async function resolveConfigured(configuredPath: string | undefined): Promise<ResolvedCli | null> {
  const configured = configuredPath?.trim();
  if (configured === undefined || configured === '') {
    return null;
  }
  if (await isExecutableFile(configured)) {
    return { command: configured, args: [], source: 'configured' };
  }
  return null;
}

/** Strategy 2/3 — `cmd` (plus `cmdc` on win32) and the long package names. */
async function resolveOnPath(): Promise<ResolvedCli | null> {
  // `Path`/`path` are the spellings Windows uses; `process.env` is a
  // case-sensitive map, so a PATH set as `Path` must be read under that name.
  const pathEnv = process.env.PATH ?? process.env.Path ?? process.env.path;
  if (pathEnv === undefined || pathEnv === '') {
    return null;
  }
  const dirs = pathEnv.split(delimiter).filter((entry) => entry !== '');
  // The vendor ships four bin names ✅ (its package.json maps `cmd`, `cmdc`,
  // `command-code` and `commandcode` at the same entry point). `cmdc` is tried
  // before `cmd` only on win32, where `cmd` is the built-in Command Prompt and
  // a PATH hit on that name is not the CLI at all.
  const candidates: readonly string[] =
    process.platform === 'win32'
      ? ['cmdc', 'cmd', 'command-code', 'commandcode']
      : ['cmd', 'cmdc', 'command-code', 'commandcode'];

  for (const candidate of candidates) {
    for (const dir of dirs) {
      if (await isExecutableFile(join(dir, candidate))) {
        return { command: candidate, args: [], source: 'path' };
      }
    }
  }
  return null;
}

/** Strategy 4 — a known npm global root, run through the host's own node. */
async function resolveNpmGlobal(): Promise<ResolvedCli | null> {
  // Windows installs npm globals to %APPDATA%\npm\node_modules, which the root
  // list does not name; there the alias strategies already ran, so there is
  // nothing further to add.
  if (process.platform === 'win32') {
    return null;
  }
  for (const dir of npmGlobalRoots()) {
    const entryPoint = join(dir, NPM_PACKAGE, NPM_ENTRY_POINT);
    if (await isExecutableFile(entryPoint)) {
      // The host's node rather than a shell: argv stays exact and no PATH
      // lookup can substitute a different interpreter (§4.5).
      return { command: process.execPath, args: [entryPoint], source: 'npm-global' };
    }
  }
  return null;
}

/** Locates the CLI, preferring the configured path, then PATH, then known npm roots. */
export interface ResolvedCli {
  readonly command: string;
  /** Prepended; normally empty. The npm-global entry point is the only member. */
  readonly args: readonly string[];
  readonly source: 'configured' | 'path' | 'npm-global';
}

/**
 * Locate the Command Code CLI. Runs once per activation, memoized by
 * `extension.ts` through the `resolve` callback the transport holds (§4.11).
 *
 * Resolution itself spawns nothing: every candidate is confirmed with `stat`
 * and an `X_OK` check, so a user with a hostile or slow PATH cannot stall
 * activation. `timeoutMs` is therefore part of the signature for symmetry with
 * `supportsJsonOutput` and is the bound that would apply if a strategy ever
 * did probe; no current strategy does.
 *
 * @param configuredPath `cmdcode.cliPath`; empty or undefined means auto-resolve.
 * @param _timeoutMs     bound on any subprocess a strategy might spawn. Unused
 *                       today — see the note above — and prefixed to keep the
 *                       contract honest about that.
 * @returns the resolved command, or null when no strategy succeeds.
 */
export async function resolveCli(
  configuredPath: string | undefined,
  _timeoutMs = 5_000,
): Promise<ResolvedCli | null> {
  const configured = await resolveConfigured(configuredPath);
  if (configured !== null) {
    return configured;
  }
  const onPath = await resolveOnPath();
  if (onPath !== null) {
    return onPath;
  }
  return resolveNpmGlobal();
}

/**
 * Probe whether the located CLI understands `--output-format json`.
 *
 * The probe is `--help` (see `HELP_PROBE_ARGS` for why), and the answer is
 * whether the help *declares* the flag. Anything else — a timeout, a signal, a
 * crash, help that never mentions the flag — is reported as unsupported rather
 * than guessed at, which degrades to the `cli-too-old` message in §4.2.
 *
 * @param timeoutMs bounds the probe. 0 disables the deadline.
 */
export async function supportsJsonOutput(r: ResolvedCli, timeoutMs = 5_000): Promise<boolean> {
  const result = await runProbe(r.command, [...r.args, ...HELP_PROBE_ARGS], timeoutMs);
  if (result === null) {
    return false;
  }
  // Exit status is a *necessary* condition, not the signal: a build that
  // cannot print help at all is not a build that speaks the JSON contract, and
  // requiring it keeps a partial write of help from reading as support.
  return result.code === 0 && declaresOutputFormatJson(result.stdout, result.stderr);
}

/**
 * Does the help declare `--output-format` with a `json` value?
 *
 * Anchored to the whole line so a *declared* flag is required, not merely a
 * mention. The same text appears in `Examples` and in a bare `--output-format`
 * on its own, so a looser pattern would match a CLI that has retired JSON but
 * still mentions the option; anchoring to the leading `  --output-format
 * <format>` declaration shape is what makes a false require the flag to be gone
 * from the option list.
 *
 * stdout and stderr are both read: a CLI that prints help to either stream
 * answers the question identically.
 */
function declaresOutputFormatJson(...streams: readonly string[]): boolean {
  return streams.some((text) => /^\s*--output-format\s+<[^>]+>.*\bjson\b/im.test(text));
}
