import { describe, expect, it } from 'vitest';

import { buildArgs, buildEnv, MAX_PROMPT_BYTES, redactArgs } from '../src/cli/process.js';
import { CliError, type RunRequest } from '../src/types.js';

// AC-06 and AC-07 at the boundary: the exact argv, the exact env overlay, and
// the size guard that has to fire before a process exists. No `vscode` import
// and no stub: process.ts is a leaf (§3.1).

const MODEL = 'stealth/space-bunny-alpha';
const PROMPT = '<user-now>reply with exactly: PONG</user-now>';

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    prompt: PROMPT,
    model: MODEL,
    maxTurns: 24,
    resumeSessionId: null,
    cwd: '/tmp/workspace',
    timeoutMs: 600_000,
    readImages: false,
    ...over,
  };
}

describe('buildArgs exact argv', () => {
  it('is exactly the seven documented flags for a fresh session', () => {
    expect(buildArgs(request())).toEqual([
      '-p',
      PROMPT,
      '--output-format',
      'json',
      '-m',
      MODEL,
      '--max-turns',
      '24',
      '--no-auto-update',
    ]);
  });

  it('leads with -r <id> when a session is being resumed', () => {
    expect(buildArgs(request({ resumeSessionId: 'ab4c5b22-0000' }))).toEqual([
      '-r',
      'ab4c5b22-0000',
      '-p',
      PROMPT,
      '--output-format',
      'json',
      '-m',
      MODEL,
      '--max-turns',
      '24',
      '--no-auto-update',
    ]);
  });

  it('omits -r entirely when the session id is null or empty', () => {
    for (const resumeSessionId of [null, '']) {
      expect(buildArgs(request({ resumeSessionId }))).not.toContain('-r');
    }
  });

  it('passes maxTurns through verbatim rather than reading a constant', () => {
    for (const maxTurns of [1, 2, 100]) {
      const args = buildArgs(request({ maxTurns }));
      expect(args[args.indexOf('--max-turns') + 1]).toBe(String(maxTurns));
    }
  });

  it('keeps the prompt as a single argv element, whatever it contains', () => {
    // The prompt is arbitrary user text, so it must survive as ONE argument
    // and never be split, quoted or globbed.
    const prompt = 'a "quoted" $var `ticked` \\ back\nnewline --output-format text';
    const args = buildArgs(request({ prompt }));
    expect(args).toHaveLength(9);
    expect(args[1]).toBe(prompt);
  });
});

describe('buildArgs image consent', () => {
  // Headless mode has no way to ask the user, so image vision resolves to false:
  //   const e = await getImageVisionEnabled();
  //   if (void 0 !== e) return e;      // explicit setting wins
  //   if (!S.askQuestion) return !1;   // headless → refuse
  // Without this flag every image is silently refused, so it is required — but
  // only on a turn that actually carries an image, so a text-only turn is not
  // quietly opting the user into reading images.
  it('adds imageVisionEnabled only when the turn carries an image', () => {
    expect(buildArgs(request({ readImages: false }))).not.toContain('imageVisionEnabled=true');
    const withImage = buildArgs(request({ readImages: true }));
    expect(withImage).toContain('--config');
    expect(withImage).toContain('imageVisionEnabled=true');
  });

  it('keeps the flag as a separate argv element', () => {
    const args = buildArgs(request({ readImages: true }));
    const i = args.indexOf('--config');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('imageVisionEnabled=true');
  });
});

describe('buildArgs excluded flags', () => {
  const EXCLUDED = [
    '--yolo',
    '--tools-all',
    '--tools-enable',
    '--skip-onboarding',
    '--trust',
    '--plan',
    '--permission-mode',
    '--verbose',
  ] as const;

  it('never passes a flag that could widen what the CLI is allowed to do', () => {
    const args = buildArgs(request({ resumeSessionId: 'ab4c5b22-0000', maxTurns: 2 }));
    for (const flag of EXCLUDED) {
      expect(args, `flag: ${flag}`).not.toContain(flag);
      // Not even as a value of another flag, and never as a bare word.
      expect(args.some((arg) => arg.includes(flag)), `substring: ${flag}`).toBe(false);
    }
  });

  it('passes no flag at all beyond the seven documented ones', () => {
    const args = buildArgs(request());
    const flags = args.filter((arg) => arg.startsWith('-'));
    expect(flags).toEqual(['-p', '--output-format', '-m', '--max-turns', '--no-auto-update']);
  });
});

describe('buildArgs prompt size guard', () => {
  it('accepts a prompt of exactly MAX_PROMPT_BYTES', () => {
    const prompt = 'x'.repeat(MAX_PROMPT_BYTES);
    expect(Buffer.byteLength(prompt, 'utf8')).toBe(MAX_PROMPT_BYTES);
    expect(buildArgs(request({ prompt }))).toContain(prompt);
  });

  it('throws a timeout-coded CliError one byte over the cap', () => {
    const prompt = 'x'.repeat(MAX_PROMPT_BYTES + 1);
    let thrown: unknown;
    try {
      buildArgs(request({ prompt }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).code).toBe('timeout');
  });

  it('measures bytes, not characters, so multi-byte text is rejected earlier', () => {
    // 'é' is 2 bytes in UTF-8: a prompt that is legal by length is over the
    // cap by the measure that actually matters to ARG_MAX.
    const chars = Math.floor(MAX_PROMPT_BYTES / 2) + 1;
    const prompt = 'é'.repeat(chars);
    expect(prompt.length).toBeLessThan(MAX_PROMPT_BYTES);
    expect(() => buildArgs(request({ prompt }))).toThrow(CliError);
  });
});

// AC-16 observability, half 1: the spawn line is the only place `maxTurns` is
// visible at runtime, and the only place the user can see which model and
// session a turn used. The prompt is the one argument that must never reach it.
describe('redactArgs — the logged argv', () => {
  it('keeps every flag, so --max-turns stays observable in the log', () => {
    const logged = redactArgs(buildArgs(request({ maxTurns: 2 })));

    expect(logged).toEqual([
      '-p',
      `<${Buffer.byteLength(PROMPT, 'utf8')} bytes>`,
      '--output-format',
      'json',
      '-m',
      MODEL,
      '--max-turns',
      '2',
      '--no-auto-update',
    ]);
  });

  it('never emits the prompt text, only its size', () => {
    const secret = 'my API key is hunter2 and my question is private';
    const logged = redactArgs(buildArgs(request({ prompt: secret })));

    expect(logged.join(' ')).not.toContain('hunter2');
    expect(logged.join(' ')).not.toContain('private');
    expect(logged).toContain(`<${Buffer.byteLength(secret, 'utf8')} bytes>`);
  });

  it('reports bytes, not characters, for multi-byte prompts', () => {
    const prompt = 'é'.repeat(10);
    const logged = redactArgs(['-p', prompt]);

    expect(logged[1]).toBe('<20 bytes>');
  });

  it('keeps a resumed session id, which is not user prose', () => {
    const logged = redactArgs(buildArgs(request({ resumeSessionId: 'ab4c5b22-0000' })));

    expect(logged.slice(0, 2)).toEqual(['-r', 'ab4c5b22-0000']);
  });

  it('leaves an argv with no prompt untouched', () => {
    expect(redactArgs(['--help'])).toEqual(['--help']);
  });

  it('does not drop a trailing -p with no value', () => {
    expect(redactArgs(['--help', '-p'])).toEqual(['--help', '-p']);
  });

  it('does not mutate the argv it was given', () => {
    const args = buildArgs(request());
    const copy = [...args];
    redactArgs(args);

    expect(args).toEqual(copy);
  });
});

describe('buildEnv', () => {
  it('forces CI, NO_COLOR and FORCE_COLOR', () => {
    const env = buildEnv({});
    expect(env.CI).toBe('1');
    expect(env.NO_COLOR).toBe('1');
    expect(env.FORCE_COLOR).toBe('0');
  });

  it('overrides values the parent already had, rather than deferring to them', () => {
    const env = buildEnv({ CI: '0', NO_COLOR: '0', FORCE_COLOR: '3' });
    expect(env.CI).toBe('1');
    expect(env.NO_COLOR).toBe('1');
    expect(env.FORCE_COLOR).toBe('0');
  });

  it('inherits PATH and every other key unchanged', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/u' };
    const env = buildEnv(base);
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.HOME).toBe('/home/u');
  });

  it('returns a new object and never mutates its argument', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const env = buildEnv(base);

    expect(env).not.toBe(base);
    expect(base).toEqual({ PATH: '/usr/bin' });
    expect(Object.keys(base)).toEqual(['PATH']);
  });

  it('never sets CMD_CONFIG_DIR — the child must read the real user config', () => {
    expect(buildEnv({})).not.toHaveProperty('CMD_CONFIG_DIR');
  });
});
