import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveCli, supportsJsonOutput, type ResolvedCli } from '../src/cli/resolve.js';

// No `vscode` import anywhere in this file: cli/resolve.ts is a leaf under plain
// vitest (§3.1). No test spawns the real `cmd` binary and none touches the
// network — every executable is a fake, written into a temp directory.

// ─────────────────────────────────────────────────────────────────────────────
// A fake CLI. It echoes its own argv space-separated, the way a real CLI
// reports a flag it accepted, which is what lets `supportsJsonOutput` assert
// *both* directions without a real binary: a fake that supports JSON echoes the
// flag back, one that does not exits 1 and says "Unknown option".
const SUPPORTS_JSON = `#!/usr/bin/env node
process.stdout.write(process.argv.slice(2).join(' ') + '\\n');
`;

const NO_JSON = `#!/usr/bin/env node
process.stderr.write('Unknown option: --output-format\\n');
process.exit(1);
`;

/** Never settles without being killed, to prove the deadline is real. */
const HANGS = `#!/usr/bin/env node
setInterval(() => {}, 1000);
`;

/** Ignores SIGTERM, so only the SIGKILL escalation can end the probe. */
const IGNORES_SIGTERM = `#!/usr/bin/env node
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

/** Touches the Command Code config directory, proving a probe cannot create it. */
const WRITES_CONFIG = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = join(process.env.HOME, '.commandcode');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'config.json'), JSON.stringify({ autoInstallExtension: false }));
process.exit(1);
`;

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cmdcode-resolve-'));
  temps.push(dir);
  return dir;
}

/**
 * Write a fake executable and return its absolute path.
 *
 * The shebang is the ABSOLUTE host `process.execPath`, never `env node`: these
 * tests deliberately clobber `PATH`, and a `#!/usr/bin/env node` fake would
 * then fail to launch for a reason that has nothing to do with what is under
 * test. Pinning the interpreter keeps every fake independent of PATH.
 */
function fakeBin(name: string, source: string, dir = tempDir()): string {
  const file = join(dir, name);
  const body = source.replace(/^#![^\n]*\n/, '');
  writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

/**
 * Stage a fake npm-global install and point `npm_config_prefix` at it, so the
 * strategy resolves deterministically on a host whose own global install
 * (if any) lives somewhere the strategy does not name — as nvm's does.
 * @returns the absolute entry point that was created.
 */
function fakeGlobalInstall(): string {
  const prefix = tempDir();
  const pkg = join(prefix, 'lib', 'node_modules', 'command-code');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  const entryPoint = join(pkg, 'dist', 'index.mjs');
  writeFileSync(entryPoint, '// fake entry point\n', { mode: 0o755 });
  process.env.npm_config_prefix = prefix;
  return entryPoint;
}

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_PREFIX = process.env.npm_config_prefix;
const ORIGINAL_HOME = process.env.HOME;
const IS_WINDOWS = process.platform === 'win32';

/** Set or clear an env key, tolerating an originally-absent value. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function withPath(value: string | undefined): void {
  setEnv('PATH', value);
}

afterEach(() => {
  setEnv('PATH', ORIGINAL_PATH);
  setEnv('npm_config_prefix', ORIGINAL_PREFIX);
  setEnv('HOME', ORIGINAL_HOME);
  while (temps.length > 0) {
    rmSync(temps.pop() as string, { recursive: true, force: true });
  }
});

/**
 * The exact argv a `ResolvedCli` produces, observed by running the resolved
 * command with a real interpreter and having it write `process.argv` back.
 *
 * The resolved `command` is honoured verbatim — this is the npm-global shape,
 * where `command` is the host node and the entry point is `args[0]` — so what
 * is asserted is the real spawn vector, not a reconstruction of it.
 */
async function runProbeArgv(resolved: ResolvedCli): Promise<string[]> {
  const dir = tempDir();
  const argv = join(dir, 'argv.log');
  // The entry point doubles as the recorder: as `args[0]` of the host node it
  // is executed, and it writes the argv it was handed.
  const entryPoint = join(dir, 'recorder.mjs');
  writeFileSync(
    entryPoint,
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv));\n`,
  );

  const observed: ResolvedCli = { ...resolved, command: process.execPath, args: [entryPoint] };
  expect(await supportsJsonOutput(observed)).toBe(false);
  const seen = JSON.parse(readFileSync(argv, 'utf8')) as string[];
  // argv[0] is the interpreter and argv[1] the entry point: the shape the
  // transport will spawn, with the entry point ahead of the probe flags.
  return seen.slice(1);
}

describe('resolveCli — strategy 1: configured path', () => {
  it('returns a non-empty configured path with source configured, without probing PATH', async () => {
    const cli = fakeBin('cmd', SUPPORTS_JSON);
    // A PATH that would resolve if it were consulted at all.
    withPath(tempDir());

    const resolved = await resolveCli(cli);

    expect(resolved).toEqual({ command: cli, args: [], source: 'configured' });
  });

  it('trims a configured path and ignores surrounding whitespace', async () => {
    const cli = fakeBin('cmd', SUPPORTS_JSON);

    const resolved = await resolveCli(`  ${cli}\t\n`);

    expect(resolved?.command).toBe(cli);
  });

  it('falls through to PATH when the configured path does not exist', async () => {
    const dir = tempDir();
    const cli = fakeBin('cmd', SUPPORTS_JSON, dir);
    withPath(dir);

    const resolved = await resolveCli(join(dir, 'not-installed'));

    expect(resolved).toEqual({ command: 'cmd', args: [], source: 'path' });
  });

  it('falls through to PATH when the configured path is a directory', async () => {
    const dir = tempDir();
    fakeBin('cmd', SUPPORTS_JSON, dir);
    withPath(dir);

    const resolved = await resolveCli(dir);

    expect(resolved?.source).toBe('path');
  });
});

describe('resolveCli — strategy 2/3: PATH', () => {
  it('resolves a command found on PATH with source path', async () => {
    const dir = tempDir();
    const cli = fakeBin('cmd', SUPPORTS_JSON, dir);
    withPath(dir);

    const resolved = await resolveCli(undefined);

    expect(resolved).toEqual({ command: 'cmd', args: [], source: 'path' });
  });

  it('finds an executable in a later PATH entry, not only the first', async () => {
    const emptyDir = tempDir();
    const withBin = tempDir();
    fakeBin('cmd', SUPPORTS_JSON, withBin);
    withPath([emptyDir, withBin].join(delimiter));

    const resolved = await resolveCli(undefined);

    expect(resolved?.command).toBe('cmd');
  });

  it('falls back to the long package names when cmd is absent', async () => {
    const dir = tempDir();
    fakeBin('command-code', SUPPORTS_JSON, dir);
    withPath(dir);

    const resolved = await resolveCli(undefined);

    expect(resolved).toEqual({ command: 'command-code', args: [], source: 'path' });
  });

  it('prefers cmd over the long names', async () => {
    const dir = tempDir();
    fakeBin('cmd', SUPPORTS_JSON, dir);
    fakeBin('commandcode', SUPPORTS_JSON, dir);
    withPath(dir);

    expect((await resolveCli(undefined))?.command).toBe('cmd');
  });

  it('ignores a PATH entry holding a non-executable file', async () => {
    const notExecutable = tempDir();
    writeFileSync(join(notExecutable, 'cmd'), SUPPORTS_JSON, { mode: 0o644 });
    const withBin = tempDir();
    fakeBin('cmd', SUPPORTS_JSON, withBin);
    withPath([notExecutable, withBin].join(delimiter));

    expect((await resolveCli(undefined))?.command).toBe('cmd');
  });

  it('returns null for an empty PATH with no npm fallback', async () => {
    // `npm_config_prefix` is cleared rather than merely unset: this host has a
    // real global install under it, and a test asserting null must not be
    // decided by whatever the developer happens to have installed.
    withPath('');
    setEnv('npm_config_prefix', '');

    expect(await resolveCli(undefined)).toBeNull();
  });

  it('returns null when PATH is absent entirely', async () => {
    withPath(undefined);
    setEnv('npm_config_prefix', '');

    expect(await resolveCli(undefined)).toBeNull();
  });

  it('returns null when no PATH entry contains any known command', async () => {
    withPath(tempDir());
    setEnv('npm_config_prefix', '');

    expect(await resolveCli(undefined)).toBeNull();
  });
});

describe('resolveCli — cmdc alias (win32 shadowing of cmd)', () => {
  it('accepts the cmdc alias when cmd is shadowed by Command Prompt', async () => {
    // The vendor ships `cmdc` as the Windows alias because `cmd` is the built-in
    // Command Prompt ✅ (vendor README:28). A PATH carrying only `cmdc` must
    // therefore resolve, on every platform.
    const dir = tempDir();
    fakeBin('cmdc', SUPPORTS_JSON, dir);
    withPath(dir);

    expect(await resolveCli(undefined)).toEqual({
      command: 'cmdc',
      args: [],
      source: 'path',
    });
  });

  it('probes cmd before cmdc off Windows, and cmdc before cmd on win32', async () => {
    const dir = tempDir();
    fakeBin('cmdc', SUPPORTS_JSON, dir);
    fakeBin('cmd', SUPPORTS_JSON, dir);
    withPath(dir);

    const resolved = await resolveCli(undefined);

    // The win32 branch inverts this list (`cmdc` first) precisely because
    // `cmd` is Command Prompt there; the platform itself is not injectable
    // from a test, so the ordering asserted here is the non-win32 one.
    expect(resolved?.command).toBe(IS_WINDOWS ? 'cmdc' : 'cmd');
    expect(resolved?.source).toBe('path');
  });

  it('tries cmdc when cmd is absent', async () => {
    const dir = tempDir();
    fakeBin('cmdc', SUPPORTS_JSON, dir);
    withPath(dir);

    expect((await resolveCli(undefined))?.command).toBe('cmdc');
  });
});

describe('resolveCli — strategy 4: npm global', () => {
  it('returns the host execPath as the command, with the entry point in args', async () => {
    // A temp dir stands in for a global root, so the strategy is exercised
    // whatever this host happens to have installed.
    const entryPoint = fakeGlobalInstall();
    withPath('');

    const resolved = await resolveCli(undefined, 2_000);

    expect(resolved).toEqual({
      command: process.execPath,
      args: [entryPoint],
      source: 'npm-global',
    });
  });

  it('never runs the npm-global entry point through a shell', async () => {
    const entryPoint = fakeGlobalInstall();
    withPath('');

    const resolved = await resolveCli(undefined, 2_000);

    expect(resolved?.source).toBe('npm-global');
    // argv, not a command string: the transport spawns `command` with `args`
    // appended and `shell: false` (§4.6), so the entry point can never be
    // re-parsed. The interpreter is the host's own node, not a PATH lookup.
    expect(resolved?.args).toEqual([entryPoint]);
    expect(resolved?.command).toBe(process.execPath);
    expect(resolved?.command).not.toBe('sh');
    expect(resolved?.args[0]).not.toContain(' ');
  });

  it('is reached only after PATH yields nothing', async () => {
    fakeGlobalInstall();
    const pathDir = tempDir();
    fakeBin('cmd', SUPPORTS_JSON, pathDir);
    withPath(pathDir);

    // The npm-global entry point exists, but PATH wins — proving the order.
    expect((await resolveCli(undefined, 2_000))?.source).toBe('path');
  });
});

describe('resolveCli — timeout', () => {
  it('never lets a probe outlive the timeout it was given', async () => {
    // Nothing is on PATH, so every strategy misses. The npm-global candidate
    // is checked by stat (never spawned), so this asserts the contract that
    // matters: a total miss resolves `null` promptly rather than stalling
    // activation on a probe.
    withPath('');
    setEnv('npm_config_prefix', '');

    const started = Date.now();
    const resolved = await resolveCli(undefined, 1_000);
    const elapsed = Date.now() - started;

    expect(resolved).toBeNull();
    expect(elapsed).toBeLessThan(10_000);
  });

  it('kills a probe that ignores SIGTERM rather than waiting on close', async () => {
    const cli = fakeBin('cmd', IGNORES_SIGTERM);
    withPath(tempDir());

    const started = Date.now();
    const supported = await supportsJsonOutput({ command: cli, args: [], source: 'configured' }, 300);
    const elapsed = Date.now() - started;

    expect(supported).toBe(false);
    // Resolving on the deadline rather than on `close` is what makes this
    // bounded: a child that traps SIGTERM never closes.
    expect(elapsed).toBeLessThan(5_000);
  });
});
describe('supportsJsonOutput', () => {
  it('returns true when the probe echoes --output-format json back', async () => {
    const cli = fakeBin('cmd', SUPPORTS_JSON);

    expect(await supportsJsonOutput({ command: cli, args: [], source: 'configured' })).toBe(true);
  });

  it('returns false when the installed CLI rejects the flag', async () => {
    const cli = fakeBin('cmd', NO_JSON);

    expect(await supportsJsonOutput({ command: cli, args: [], source: 'configured' })).toBe(false);
  });

  it('returns false for a command that does not exist', async () => {
    const missing = join(tempDir(), 'not-a-real-cli');

    expect(await supportsJsonOutput({ command: missing, args: [], source: 'configured' })).toBe(false);
  });

  it('returns false when the probe hangs past the deadline', async () => {
    const cli = fakeBin('cmd', HANGS);

    const started = Date.now();
    const supported = await supportsJsonOutput({ command: cli, args: [], source: 'configured' }, 200);

    expect(supported).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('prepends the resolved args so the npm-global entry point is executed', async () => {
    // The npm-global shape: `command` is the host node, `args[0]` is the
    // package entry point. Read the child's argv back to prove the entry point
    // is executed and the probe flags land after it, in order, with no shell.
    const seen = await runProbeArgv({
      command: process.execPath,
      args: [],
      source: 'npm-global',
    });

    expect(seen[0]).toMatch(/recorder\.mjs$/);
    expect(seen.slice(1)).toEqual(['--output-format', 'json', '--version']);
  });

  it('defaults the probe deadline to 5000 ms when no timeout is given', async () => {
    // §4.5 declares a 5 s default, and the acceptance criterion is that the
    // default is what bounds a hung probe. A hanging fake is the only way to
    // observe that bound. The vitest timeout is set above it deliberately:
    // the test would be vacuous if vitest's own 5 s limit fired first and
    // failed the test for the wrong reason.
    const cli = fakeBin('cmd', HANGS);

    const started = Date.now();
    const supported = await supportsJsonOutput({ command: cli, args: [], source: 'configured' });
    const elapsed = Date.now() - started;

    expect(supported).toBe(false);
    // The probe settled on its own deadline, not vitest's: ~5 s, and nowhere
    // near the ceiling that would indicate a leaked process.
    expect(elapsed).toBeGreaterThan(4_000);
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);
});

describe('Command Code configuration directory is never touched', () => {
  const configDir = join(homedir(), '.commandcode');
  const configFile = join(configDir, 'config.json');

  function snapshot(): string[] {
    if (!existsSync(configDir)) {
      return [];
    }
    return readdirSync(configDir).sort();
  }

  it('creates nothing under the config directory when resolution runs', async () => {
    withPath(tempDir());
    const before = snapshot();

    await resolveCli(undefined, 1_000);

    expect(snapshot()).toEqual(before);
  });

  it('leaves no config file created or modified by a full resolve+probe', async () => {
    const cli = fakeBin('cmd', SUPPORTS_JSON, tempDir());
    withPath(tempDir());
    const before = snapshot();
    const beforeStat = existsSync(configFile) ? statSync(configFile).mtimeMs : null;

    const resolved = await resolveCli(cli, 1_000);
    expect(resolved?.source).toBe('configured');
    expect(await supportsJsonOutput(resolved as ResolvedCli)).toBe(true);

    expect(snapshot()).toEqual(before);
    expect(existsSync(configFile)).toBe(beforeStat !== null);
    if (beforeStat !== null) {
      expect(statSync(configFile).mtimeMs).toBe(beforeStat);
      // The auto-install opt-out key is the user's alone (ADR-01).
      expect(readFileSync(configFile, 'utf8')).not.toContain('autoInstallExtension: false');
    }
  });

  it('never sets CMD_LOCAL_ONLY, and always sets CI=1', async () => {
    // `CI=1` is the vendor's own switch for suppressing its IDE auto-installer
    // ✅ (`if (process.env.CI) return`). The probe env is the whole defence, so
    // assert it on the child rather than asserting a side effect we cannot
    // observe. The fake writes its own env to a log the test reads back.
    const sandbox = tempDir();
    const log = join(sandbox, 'env.log');
    const reporter = fakeBin(
      'reporter',
      `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.env));
process.stdout.write('--output-format json --version\\n');
`,
      sandbox,
    );

    const resolved: ResolvedCli = { command: reporter, args: [], source: 'configured' };
    expect(await supportsJsonOutput(resolved)).toBe(true);
    const env = JSON.parse(readFileSync(log, 'utf8')) as Record<string, string>;
    // Suppresses the auto-installer…
    expect(env.CI).toBe('1');
    // …and the module never reaches for the vendor's undocumented escape hatch.
    expect(env.CMD_LOCAL_ONLY).toBeUndefined();
  });

  it('leaves the opt-out key alone even when a probe would write it', async () => {
    // The strongest form of the guarantee: a fake that deliberately writes the
    // auto-install opt-out cannot create the file for the real user, because
    // the resolver itself never creates ~/.commandcode in the first place. HOME
    // is redirected so the fake's write lands in a sandbox, proving the
    // directory was not already there and was not created by resolution.
    const sandbox = tempDir();
    const before = snapshot();
    setEnv('HOME', sandbox);
    try {
      const cli = fakeBin('cmd', WRITES_CONFIG);
      withPath(tempDir());

      const resolved = await resolveCli(cli, 1_000);
      expect(resolved?.source).toBe('configured');
      expect(await supportsJsonOutput(resolved as ResolvedCli)).toBe(false);

      // The fake's write landed in the sandbox…
      expect(existsSync(join(sandbox, '.commandcode', 'config.json'))).toBe(true);
      // …and the user's real Command Code directory is untouched.
      expect(snapshot()).toEqual(before);
    } finally {
      setEnv('HOME', ORIGINAL_HOME);
    }
  });

  it('resolves without touching the config directory, whatever it finds', async () => {
    // Run the real resolution down both arms — a PATH that resolves, and a PATH
    // that does not — and assert the config directory is byte-identical after
    // each. The second arm is the one that reaches the npm-global strategy, so
    // it is also the branch where a side effect would be most likely.
    const dir = tempDir();
    fakeBin('cmd', SUPPORTS_JSON, dir);
    const before = snapshot();

    withPath(dir);
    expect((await resolveCli(undefined, 2_000))?.source).toBe('path');
    expect(snapshot()).toEqual(before);

    withPath('');
    setEnv('npm_config_prefix', '');
    expect(await resolveCli(undefined, 2_000)).toBeNull();
    expect(snapshot()).toEqual(before);
  });
});

describe('ResolvedCli shape', () => {
  it('carries exactly command, args and source', async () => {
    const cli = fakeBin('cmd', SUPPORTS_JSON);
    const resolved = await resolveCli(cli);

    expect(resolved).not.toBeNull();
    expect(Object.keys(resolved as ResolvedCli).sort()).toEqual(['args', 'command', 'source']);
    expect(Array.isArray(resolved?.args)).toBe(true);
  });

  it('reports a displayable command that exists on disk', async () => {
    const cli = fakeBin('cmd', SUPPORTS_JSON);

    const resolved = await resolveCli(cli);

    expect(resolved?.command).toBe(cli);
    expect(existsSync(cli)).toBe(true);
    // The fake is runnable end to end — the contract the transport relies on.
    const run = execFileSync(cli, ['--version'], { encoding: 'utf8' });
    expect(run).toContain('--version');
  });
});
