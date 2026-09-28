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

/** The probe argv. Fixed here, not shared: no sibling module owns it (§4.5). */
const VERSION_PROBE_ARGS: readonly string[] = Object.freeze(['--output-format', 'json', '--version']);

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
 * The probe is `--output-format json --version`: `command-code@1.66.0` answers
 * in 0.67 s ✅, and deliberately NOT `config get`, which takes 5.1 s ✅ — five
 * times the default budget, on a path that runs at every activation.
 *
 * A flag the CLI does not know is not an error: the same binary answers
 * `--totally-bogus-flag --version` with exit 0 ✅, so exit status alone cannot
 * decide the question and the echoed argv is what is inspected. Anything else
 * (a timeout, a signal, a crash, unparseable output) is reported as
 * unsupported rather than guessed at, which degrades to the `cli-too-old`
 * message in §4.2.
 *
 * @param timeoutMs bounds the probe. 0 disables the deadline.
 */
export async function supportsJsonOutput(r: ResolvedCli, timeoutMs = 5_000): Promise<boolean> {
  const result = await runProbe(r.command, [...r.args, ...VERSION_PROBE_ARGS], timeoutMs);
  if (result === null) {
    return false;
  }
  return mentionsOutputFormatJson(result.stdout, result.stderr);
}

/**
 * Does the probe's own output show that `--output-format json` was accepted?
 *
 * Matching the echoed argv is the only probe that survives the vendor's
 * forgiving argument parsing: a pre-JSON build reports `--help` text or an
 * "Unknown option" line instead of echoing the flag back.
 */
function mentionsOutputFormatJson(...streams: readonly string[]): boolean {
  return streams.some((text) => /--output-format[= ]+json/i.test(text));
}
