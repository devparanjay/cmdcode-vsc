import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NdjsonReader } from '../src/cli/ndjson.js';
import { resolveCli, supportsJsonOutput } from '../src/cli/resolve.js';
import { toPresentation } from '../src/errors.js';
import { TranscriptStore } from '../src/transcript.js';
import {
  CliError,
  CONFIG_DEFAULTS,
  ExitCode,
  isResultFrame,
  type EventFrame,
  type Frame,
  type ResultFrame,
  type RunRequest,
} from '../src/types.js';

// The whole loop, across all four merged feature branches, with a REAL process:
//
//   resolveCli -> spawn(argv) -> stdout -> NdjsonReader -> TranscriptStore
//                                    exit code -> CliError -> toPresentation
//
// resolve.test.ts drives the resolver with a fake; ndjson.test.ts feeds the
// reader strings. Neither proves the two agree on the actual byte stream of a
// real child process, which is where a merged seam breaks: a resolver that
// returns the wrong argv, or a reader that mishandles how a pipe really chunks
// its output, both pass in isolation.
//
// ISOLATION IS LOAD-BEARING HERE. resolveCli has an npm-global fallback keyed on
// `npm_config_prefix`, and npm sets that variable when it launches the test
// runner. On an nvm host the real command-code is installed under that prefix,
// so a test whose PATH staging does not actually resolve WILL spawn the user's
// genuine CLI. Every test below therefore points BOTH PATH and
// npm_config_prefix at empty temp directories, so the only thing that can ever
// be spawned is a fake written by this file. No real binary is ever invoked.

const IS_WINDOWS = process.platform === 'win32';
const FAKE_NAME = IS_WINDOWS ? 'cmdc.cmd' : 'cmd';
const MODEL = 'stealth/space-bunny-alpha';
const SESSION_ID = 'e2e-session-0001';

/** The recorded options-table declaration from command-code@1.66.0. */
const HELP_WITH_JSON = [
  'Command Code v1.66.0',
  '',
  'Options',
  '  -p, --print [query]               Run in non-interactive mode, output response and exit',
  '  --output-format <format>          -p output: text (default) or json (NDJSON event stream + final result line)',
  '  -m, --model <model>               Run on a specific model this session',
  '  -h, --help                        Display this help message',
  '',
].join('\n');

/** A pre-JSON build: the flag simply is not declared. */
const HELP_WITHOUT_JSON = [
  'Command Code v1.20.0',
  '',
  'Options',
  '  -p, --print [query]               Run in non-interactive mode, output response and exit',
  '  -h, --help                        Display this help message',
  '',
].join('\n');

/**
 * A run that streams a real NDJSON turn and exits cleanly.
 *
 * The argv sink path is interpolated by `stageCli`, which knows it up front.
 * Note the absence of `process.exit()`: Node discards buffered stdout when a
 * pipe is still draining, so a large write followed by an immediate exit is
 * truncated mid-line. Setting `process.exitCode` and returning lets the event
 * loop flush first, which is how a well-behaved CLI behaves.
 */
const successRun = (argvSink: string): string => `const sessionId = ${JSON.stringify(SESSION_ID)};
process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId } }) + '\\n');
for (const piece of ['PONG', ' from ', 'the ', 'CLI']) {
  process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'text_delta', text: piece } }) + '\\n');
}
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', sessionId,
  usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  durationMs: 42, finalText: 'PONG from the CLI',
}) + '\\n');
require('node:fs').writeFileSync(${JSON.stringify(argvSink)}, JSON.stringify(process.argv.slice(2)));
process.exitCode = 0;
`;

/** Writes a run_start, then exits 1 with a plan-gating message on stderr. */
const PLAN_GATED_RUN = `process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId: 'never-committed' } }) + '\\n');
process.stderr.write('Error: Model not in plan: ${MODEL}\\n');
process.exitCode = ${ExitCode.Error};
`;

const MALFORMED_RUN = `process.stdout.write('this is not NDJSON at all\\n');
process.exitCode = ${ExitCode.Success};
`;

/** Zero stdout, exit 1: the §D3 lifecycle case (an invalid model). */
const SILENT_FAILURE_RUN = `process.exitCode = ${ExitCode.Error};
`;

/** Writes every frame with no trailing newline, then exits. */
const UNTERMINATED_TAIL_RUN = `const sessionId = 'tail-session';
process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId } }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', sessionId,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  durationMs: 1, finalText: 'tail text',
}));
process.exitCode = 0;
`;

/** A 300 KB line: far larger than any single pipe read. */
const BIG_LINE_RUN = `const sessionId = 'big-session';
process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'text_delta', text: 'x'.repeat(300000) } }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', sessionId,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  durationMs: 1, finalText: 'done',
}) + '\\n');
process.exitCode = 0;
`;

const temps: string[] = [];
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_PREFIX = process.env.npm_config_prefix;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cmdcode-e2e-'));
  temps.push(dir);
  return dir;
}

/**
 * Write a fake executable. The shebang is the absolute host `process.execPath`:
 * these tests replace PATH with a single temp directory, so `#!/usr/bin/env
 * node` would fail to launch for a reason unrelated to what is under test.
 */
function writeFakeBin(dir: string, name: string, source: string): void {
  const file = join(dir, name);
  writeFileSync(file, `#!${process.execPath}\n${source.replace(/^#![^\n]*\n/, '')}`);
  chmodSync(file, 0o755);
}

interface Staging {
  /** PATH holding the fake. */
  readonly dir: string;
  /** Where the fake records the argv it was handed. */
  readonly argvSink: string;
}

/**
 * Stage a fake CLI in an isolated PATH and point npm_config_prefix at an empty
 * prefix, so no resolution strategy can reach a real install.
 *
 * The fake answers BOTH `--help` (the capability probe) and a run (the turn),
 * because the real CLI does both in one process and the test asserts the two
 * agree. `run` defaults to a bare successful run with no output.
 */
function stageCli(opts: {
  readonly help: 'with-json' | 'without-json';
  readonly run?: (argvSink: string) => string;
  readonly dirName?: string;
}): Staging {
  const parent = tempDir();
  const dir = opts.dirName === undefined ? join(parent, 'bin') : join(parent, opts.dirName);
  mkdirSync(dir, { recursive: true });
  const argvSink = join(parent, 'argv.json');

  const helpText = opts.help === 'with-json' ? HELP_WITH_JSON : HELP_WITHOUT_JSON;
  const run = opts.run === undefined ? `process.exitCode = ${ExitCode.Success};\n` : opts.run(argvSink);
  writeFakeBin(
    dir,
    FAKE_NAME,
    `if (process.argv.includes('--help')) {
  process.stdout.write(${JSON.stringify(helpText)} + '\\n');
  process.exitCode = 0;
} else {
${run}
}
`,
  );

  // An empty prefix: npmGlobalRoots() then names a directory with no
  // command-code in it, so strategy 4 cannot fire.
  const emptyPrefix = join(parent, 'empty-prefix');
  mkdirSync(join(emptyPrefix, 'lib', 'node_modules'), { recursive: true });

  process.env.PATH = dir;
  process.env.npm_config_prefix = emptyPrefix;

  return { dir, argvSink };
}

function setEnv(key: 'PATH' | 'npm_config_prefix', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  setEnv('PATH', ORIGINAL_PATH);
  setEnv('npm_config_prefix', ORIGINAL_PREFIX);
  while (temps.length > 0) {
    rmSync(temps.pop() as string, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The turn driver, mirroring the RunHandlers contract in types.ts.

interface TurnResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly deltas: readonly string[];
  readonly result: ResultFrame | null;
  readonly error: CliError | null;
  readonly sawResultFrame: boolean;
  readonly sawAnyFrame: boolean;
  readonly announced: readonly string[];
}

/** One headless run against a resolved CLI, read exactly as the transport will. */
function runHeadless(
  resolved: { command: string; args: readonly string[] },
  req: RunRequest,
  store: TranscriptStore,
  modelId: string,
): Promise<TurnResult> {
  return new Promise((resolve) => {
    const argv = [
      ...resolved.args,
      '-p',
      req.prompt,
      '--output-format',
      'json',
      '-m',
      req.model,
      '--max-turns',
      String(req.maxTurns),
      ...(req.resumeSessionId === null ? [] : ['-r', req.resumeSessionId]),
    ];

    const child = spawn(resolved.command, argv, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
      cwd: req.cwd,
    });

    const deltas: string[] = [];
    const announced: string[] = [];
    let result: ResultFrame | null = null;
    let streamError: CliError | null = null;
    let pendingSessionId: string | null = null;

    const reader = new NdjsonReader((frame: Frame) => {
      if (isResultFrame(frame)) {
        result = frame;
        return;
      }
      const event = (frame as EventFrame).event;
      if (event.type === 'text_delta') {
        deltas.push(event.text as string);
      } else if (event.type === 'run_start') {
        const id = event.sessionId as string;
        announced.push(id);
        pendingSessionId = id;
      }
    });

    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const error = reader.push(chunk);
      if (error !== null) {
        streamError = error;
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('close', (code: number | null) => {
      if (streamError === null) {
        const error = reader.end();
        if (error !== null) {
          streamError = error;
        }
      }
      // §4.9: commit the session id only for a genuinely successful turn.
      if (
        streamError === null &&
        code === ExitCode.Success &&
        result !== null &&
        result.subtype === 'success' &&
        pendingSessionId !== null
      ) {
        store.set(modelId, pendingSessionId);
      }
      resolve({
        exitCode: code,
        stderr,
        deltas,
        result,
        error: streamError,
        sawResultFrame: reader.sawResultFrame(),
        sawAnyFrame: reader.sawAnyFrame(),
        announced,
      });
    });
  });
}

function request(cwd: string, resumeSessionId: string | null = null): RunRequest {
  return {
    prompt: '<cmdcode-request model="stealth/space-bunny-alpha">\n<user-now>\nhi\n</user-now>\n</cmdcode-request>',
    model: MODEL,
    maxTurns: CONFIG_DEFAULTS.maxTurns,
    resumeSessionId,
    cwd,
    timeoutMs: 0,
  };
}

/** A fresh store per test, so no ordering dependency can creep in. */
function newStore(): TranscriptStore {
  return new TranscriptStore();
}

// ─────────────────────────────────────────────────────────────────────────────

describe('resolve -> spawn -> NDJSON -> session cache, end to end', () => {
  it('resolves a real CLI on PATH, passes its own capability probe, and streams a turn', async () => {
    const staging = stageCli({ help: 'with-json', run: successRun });
    const store = newStore();

    const resolved = await resolveCli(CONFIG_DEFAULTS.cliPath);
    expect(resolved, 'the fake on PATH should have resolved').not.toBeNull();
    expect(resolved!.source, 'PATH must beat the npm-global fallback').toBe('path');
    expect(resolved!.command).toBe(FAKE_NAME);

    // The probe and the run agree: the same resolved binary both declares and
    // honours the JSON contract.
    expect(await supportsJsonOutput(resolved!)).toBe(true);

    const turn = await runHeadless(resolved!, request(tempDir()), store, MODEL);

    expect(turn.error, `stderr: ${turn.stderr}`).toBeNull();
    expect(turn.exitCode).toBe(ExitCode.Success);
    expect(turn.sawResultFrame).toBe(true);
    // Four separate writes from the child, reassembled in arrival order.
    expect(turn.deltas).toEqual(['PONG', ' from ', 'the ', 'CLI']);
    expect(turn.deltas.join('')).toBe('PONG from the CLI');
    expect(turn.result?.finalText).toBe('PONG from the CLI');
    // The session id crossed the process boundary into the cache.
    expect(turn.announced).toEqual([SESSION_ID]);
    expect(store.get(MODEL)).toBe(SESSION_ID);
    expect(staging.dir).not.toBe('');
  });

  it('hands the child the exact prompt and model as single argv elements', async () => {
    // A prompt full of shell metacharacters must arrive at the child as ONE
    // argument, uninterpreted. If any layer built a shell string, this breaks.
    const staging = stageCli({ help: 'with-json', run: successRun });
    const store = newStore();

    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;
    expect(resolved.source).toBe('path');

    const hostile = 'a b\tc "d" $HOME `id` ; echo pwned | tee /tmp/x #';
    const req: RunRequest = { ...request(tempDir()), prompt: `<user-now>\n${hostile}\n</user-now>` };
    const turn = await runHeadless(resolved, req, store, MODEL);

    expect(turn.error).toBeNull();

    const argv = JSON.parse(readFileSync(staging.argvSink, 'utf8')) as string[];
    // The prompt is one element, verbatim — the metacharacters were data.
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe(req.prompt);
    expect(argv[1]).toContain(hostile);
    expect(argv[2]).toBe('--output-format');
    expect(argv[3]).toBe('json');
    expect(argv[4]).toBe('-m');
    expect(argv[5]).toBe(MODEL);
    expect(argv).toContain('--max-turns');
    expect(argv).toContain(String(CONFIG_DEFAULTS.maxTurns));
    // The child ran to completion, so nothing was interpreted as a command.
    expect(turn.exitCode).toBe(ExitCode.Success);
  });

  it('resumes with -r only when the store holds a session for that model', async () => {
    const staging = stageCli({ help: 'with-json', run: successRun });
    const store = newStore();
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    // Cold turn: no session, so no -r at all.
    await runHeadless(resolved, request(tempDir()), store, MODEL);
    let argv = JSON.parse(readFileSync(staging.argvSink, 'utf8')) as string[];
    expect(argv, 'a cold turn must not pass -r').not.toContain('-r');
    expect(store.get(MODEL)).toBe(SESSION_ID);

    // Warm turn: the id the previous run stored is passed back verbatim.
    const warm = await runHeadless(resolved, request(tempDir(), store.get(MODEL)), store, MODEL);
    expect(warm.error).toBeNull();
    argv = JSON.parse(readFileSync(staging.argvSink, 'utf8')) as string[];
    expect(argv).toContain('-r');
    expect(argv[argv.indexOf('-r') + 1]).toBe(SESSION_ID);
  });

  it('flushes an unterminated final line from a real pipe', async () => {
    // The child exits without a trailing newline. A reader that only splits on
    // "\n" would lose the result frame and the turn would look like no-response.
    stageCli({ help: 'with-json', run: () => UNTERMINATED_TAIL_RUN });
    const store = newStore();
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    const turn = await runHeadless(resolved, request(tempDir()), store, MODEL);

    expect(turn.error).toBeNull();
    expect(turn.sawResultFrame).toBe(true);
    expect(turn.result?.finalText).toBe('tail text');
    expect(store.get(MODEL)).toBe('tail-session');
  });
});

describe('a real child that fails: exit code -> CliError -> user-facing copy', () => {
  it('refuses a CLI that does not declare --output-format json', async () => {
    stageCli({ help: 'without-json' });
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    // The probe is the gate: a pre-JSON build must be refused before any turn.
    expect(await supportsJsonOutput(resolved)).toBe(false);
    expect(toPresentation(new CliError('cli-too-old', 'no json')).message).toBe(
      'This Command Code CLI is too old. Update it with `npm i -g command-code@latest`.',
    );
  });

  it('turns a malformed real stream into copy that names no stream content', async () => {
    stageCli({ help: 'with-json', run: () => MALFORMED_RUN });
    const store = newStore();
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    const turn = await runHeadless(resolved, request(tempDir()), store, MODEL);

    expect(turn.error).toBeInstanceOf(CliError);
    expect(turn.error?.code).toBe('malformed-stream');
    expect(turn.sawResultFrame).toBe(false);
    const copy = toPresentation(turn.error!).message;
    expect(copy).toBe("Command Code sent output this extension couldn't read. See the Command Code log.");
    // The offending bytes never reach the user, and nothing was cached.
    expect(copy).not.toContain('NDJSON');
    expect(store.get(MODEL)).toBeNull();
  });

  it('never commits a session announced by a child that then fails', async () => {
    // The dangerous interleaving: run_start arrives, THEN the child dies with a
    // plan error. A driver that commits on run_start alone would cache a
    // session for a turn that never produced a result.
    stageCli({ help: 'with-json', run: () => PLAN_GATED_RUN });
    const store = newStore();
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    const turn = await runHeadless(resolved, request(tempDir()), store, MODEL);

    expect(turn.exitCode).toBe(ExitCode.Error);
    expect(turn.announced).toEqual(['never-committed']);
    expect(store.get(MODEL), 'a failed turn must not poison the cache').toBeNull();
    // The stderr reached the parent verbatim, ready for the output channel.
    expect(turn.stderr).toContain(`Model not in plan: ${MODEL}`);
  });

  it('treats a silent nonzero exit as no result, not as a silent success', async () => {
    // §D3: an invalid model yields exit 1 with zero stdout. The turn must not
    // read as complete just because the child exited.
    stageCli({ help: 'with-json', run: () => SILENT_FAILURE_RUN });
    const store = newStore();
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    const turn = await runHeadless(resolved, request(tempDir()), store, MODEL);

    expect(turn.exitCode).toBe(ExitCode.Error);
    expect(turn.sawAnyFrame).toBe(false);
    expect(turn.sawResultFrame).toBe(false);
    expect(turn.deltas).toEqual([]);
    expect(turn.result).toBeNull();
    expect(store.get(MODEL)).toBeNull();
  });

  it('reports a missing CLI with copy that names the setting, not a path', () => {
    const presentation = toPresentation(new CliError('cli-not-found', 'resolved null'));
    expect(presentation.message).toBe(
      'Command Code CLI not found. Install it with `npm i -g command-code`, or set `cmdcode.cliPath`.',
    );
    expect(presentation.command).toBe('workbench.action.openSettings');
  });
});

describe('the resolver and the reader agree on how a real pipe chunks stdout', () => {
  it('reads a stream whose lines span many pipe reads', async () => {
    stageCli({ help: 'with-json', run: () => BIG_LINE_RUN });
    const store = newStore();
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    // A single NDJSON line of ~300 KB arrives as many 64 KB pipe reads, so the
    // reader must buffer and reassemble rather than assume one chunk, one line.
    // The fake exits via `process.exitCode`, never `process.exit()`: Node
    // discards buffered stdout on an early exit, which would truncate the
    // stream before the reader ever saw it.
    const turn = await runHeadless(resolved, request(tempDir()), store, MODEL);

    expect(turn.error).toBeNull();
    expect(turn.deltas).toHaveLength(1);
    expect(turn.deltas[0]).toHaveLength(300_000);
    expect(turn.result?.finalText).toBe('done');
    expect(store.get(MODEL)).toBe('big-session');
  });

  it('reads a stream cut on a multi-byte UTF-8 boundary by the pipe', async () => {
    const unicode = 'héllo — 世界 🌍';
    const source = `const sessionId = 'utf8-session';
process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'text_delta', text: ${JSON.stringify(unicode)} } }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', sessionId,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  durationMs: 1, finalText: ${JSON.stringify(unicode)},
}) + '\\n');
process.exit(0);
`;
    stageCli({ help: 'with-json', run: () => source });
    const store = newStore();
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    const turn = await runHeadless(resolved, request(tempDir()), store, MODEL);

    expect(turn.error).toBeNull();
    // The reader's string concatenation must not mangle a split emoji.
    expect(turn.deltas.join('')).toBe(unicode);
    expect(turn.result?.finalText).toBe(unicode);
  });

  it('ignores CRLF line endings from a child on a pipe', async () => {
    const crlfSource = `const sessionId = 'crlf-session';
process.stdout.write(JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId } }) + '\\r\\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', sessionId,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  durationMs: 1, finalText: 'crlf ok',
}) + '\\r\\n');
process.exit(0);
`;
    stageCli({ help: 'with-json', run: () => crlfSource });
    const store = newStore();
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    const turn = await runHeadless(resolved, request(tempDir()), store, MODEL);

    expect(turn.error).toBeNull();
    expect(turn.result?.finalText).toBe('crlf ok');
    expect(store.get(MODEL)).toBe('crlf-session');
  });
});

describe('no resolution path lets a turn escape into a shell', () => {
  it('runs a CLI from a PATH entry containing spaces and a semicolon', async () => {
    // A directory name with a space and ";" is enough to break any command
    // string built by concatenation. Resolution must go through argv only.
    stageCli({ help: 'with-json', run: successRun, dirName: 'bin ; echo pwned' });
    const store = newStore();

    const resolved = await resolveCli(CONFIG_DEFAULTS.cliPath);
    expect(resolved, 'a PATH entry with spaces must still resolve').not.toBeNull();
    expect(resolved!.source).toBe('path');

    const turn = await runHeadless(resolved!, request(tempDir()), store, MODEL);

    expect(turn.error).toBeNull();
    expect(turn.result?.finalText).toBe('PONG from the CLI');
    expect(store.get(MODEL)).toBe(SESSION_ID);
  });

  it('keeps a model id with a slash as one verbatim argv element', async () => {
    const staging = stageCli({ help: 'with-json', run: successRun });
    const store = newStore();
    const resolved = (await resolveCli(CONFIG_DEFAULTS.cliPath))!;

    const turn = await runHeadless(resolved, request(tempDir()), store, MODEL);
    expect(turn.error).toBeNull();

    const argv = JSON.parse(readFileSync(staging.argvSink, 'utf8')) as string[];
    // The -m value is the exact vendor id, one element, slashes intact.
    expect(argv[argv.indexOf('-m') + 1]).toBe('stealth/space-bunny-alpha');
  });
});
