import { describe, expect, it } from 'vitest';

import { classify, type ClassifyInput } from '../src/cli/process.js';
import { CliError, ExitCode, ZERO_USAGE, type CliErrorCode, type ResultFrame } from '../src/types.js';

// The vendor's entire exit-code contract in one file (AC-09, AC-10). No `vscode`
// import and no stub: process.ts is a leaf, so this runs under a plain vitest
// (§3.1). Every row of the §5.2 table appears exactly once below, and the
// success row is the ONLY input that may return null.

const result = (subtype: ResultFrame['subtype']): ResultFrame => ({
  type: 'result',
  subtype,
  usage: ZERO_USAGE,
  durationMs: 10,
  finalText: subtype === 'success' ? 'PONG' : '',
});

/** Every input is fully specified unless a column says otherwise. */
function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    exitCode: ExitCode.Error,
    sawResultFrame: false,
    result: null,
    stderr: '',
    timedOut: false,
    ...over,
  };
}

/** The code classify returns, for a table row. */
function code(over: Partial<ClassifyInput>): CliErrorCode | null {
  return classify(input(over))?.code ?? null;
}

/** One §5.2 row: a label and the input that produces it. */
interface Row {
  readonly label: string;
  readonly input: Partial<ClassifyInput>;
  readonly expect: CliErrorCode | null;
}

const PLAN = 'Error: Model not in plan: space-bunny-alpha\n';
const PERMISSION = 'Error: permission denied: write_file\n';

const ROWS: readonly Row[] = [
  // 1. Our own deadline outranks the 130 its SIGTERM produces.
  { label: '1 timedOut → timeout', input: { timedOut: true }, expect: 'timeout' },
  { label: '1 timedOut on exit 130 → timeout', input: { exitCode: ExitCode.Interrupted, timedOut: true }, expect: 'timeout' },
  { label: '1 timedOut on a signalled child → timeout', input: { exitCode: null, timedOut: true }, expect: 'timeout' },

  // 2. Cancel and signal death are one code.
  { label: '2 exit 130 → interrupted', input: { exitCode: ExitCode.Interrupted }, expect: 'interrupted' },
  { label: '2 signalled child → interrupted', input: { exitCode: null }, expect: 'interrupted' },

  // 3a. §D3: a clean exit with no result frame is an error, not a success.
  { label: '3a exit 0, no result frame → no-response', input: { exitCode: ExitCode.Success }, expect: 'no-response' },
  { label: '3a exit 0, events but no result frame → no-response', input: { exitCode: ExitCode.Success, sawResultFrame: false }, expect: 'no-response' },

  // 3b. 3c. 3d.
  { label: '3b exit 0 + max_turns → max-turns', input: { exitCode: ExitCode.Success, sawResultFrame: true, result: result('max_turns') }, expect: 'max-turns' },
  { label: '3c exit 0 + error subtype → unknown', input: { exitCode: ExitCode.Success, sawResultFrame: true, result: result('error') }, expect: 'unknown' },
  { label: '3d exit 0 + success subtype → null', input: { exitCode: ExitCode.Success, sawResultFrame: true, result: result('success') }, expect: null },

  // 4. The plan rule, guarded to the two exits that can carry it.
  { label: '4 exit 1 + plan phrase → plan-gated', input: { exitCode: ExitCode.Error, stderr: PLAN }, expect: 'plan-gated' },
  { label: '4 exit 10 + plan phrase → plan-gated', input: { exitCode: ExitCode.InsufficientCredits, stderr: PLAN }, expect: 'plan-gated' },

  // 4-guard. The pair that matters: the SAME stderr on a guarded exit is
  // plan-gated, and on an unguarded one falls through to that exit's own row.
  { label: '4-guard exit 5 + plan phrase → rate-limited', input: { exitCode: ExitCode.RateLimited, stderr: PLAN }, expect: 'rate-limited' },
  { label: '4-guard exit 1 + plan phrase → plan-gated', input: { exitCode: ExitCode.Error, stderr: PLAN }, expect: 'plan-gated' },
  { label: '4-guard exit 3 + plan phrase → auth', input: { exitCode: ExitCode.AuthError, stderr: PLAN }, expect: 'auth' },
  { label: '4-guard exit 4 + plan phrase → permission', input: { exitCode: ExitCode.PermissionDenied, stderr: PLAN }, expect: 'permission' },
  { label: '4-guard exit 6 + plan phrase → network', input: { exitCode: ExitCode.ConnectionError, stderr: PLAN }, expect: 'network' },
  { label: '4-guard exit 7 + plan phrase → server', input: { exitCode: ExitCode.ServerError, stderr: PLAN }, expect: 'server' },
  { label: '4-guard exit 8 + plan phrase → max-turns', input: { exitCode: ExitCode.MaxTurnsReached, stderr: PLAN }, expect: 'max-turns' },
  { label: '4-guard exit 9 + plan phrase → no-response', input: { exitCode: ExitCode.NoResponse, stderr: PLAN }, expect: 'no-response' },

  // 5. The vendor's own permission heuristic, guarded to the generic branch.
  { label: '5 exit 1 + permission denied → permission', input: { exitCode: ExitCode.Error, stderr: PERMISSION }, expect: 'permission' },
  { label: '5 exit 1 + access denied → permission', input: { exitCode: ExitCode.Error, stderr: 'Error: access denied' }, expect: 'permission' },
  { label: '5 exit 1 + not permitted → permission', input: { exitCode: ExitCode.Error, stderr: 'Error: not permitted' }, expect: 'permission' },
  { label: '5 exit 1 + unauthorized → permission', input: { exitCode: ExitCode.Error, stderr: 'Error: unauthorized' }, expect: 'permission' },
  { label: '5-guard exit 4 + permission phrase → permission', input: { exitCode: ExitCode.PermissionDenied, stderr: PERMISSION }, expect: 'permission' },

  // 6–13. One row per vendor exit code.
  { label: '6 exit 8 → max-turns', input: { exitCode: ExitCode.MaxTurnsReached }, expect: 'max-turns' },
  { label: '7 exit 3 → auth', input: { exitCode: ExitCode.AuthError }, expect: 'auth' },
  { label: '8 exit 4 → permission', input: { exitCode: ExitCode.PermissionDenied }, expect: 'permission' },
  // 9 with the mid-run shape: an `error` result frame AND exit 5. The exit
  // code is classified first, so this is the real cause, not `unknown`.
  { label: '9 exit 5 + error result frame → rate-limited', input: { exitCode: ExitCode.RateLimited, sawResultFrame: true, result: result('error'), stderr: 'weekly usage limit' }, expect: 'rate-limited' },
  { label: '10 exit 6 → network', input: { exitCode: ExitCode.ConnectionError }, expect: 'network' },
  { label: '11 exit 7 → server', input: { exitCode: ExitCode.ServerError }, expect: 'server' },
  { label: '12 exit 9 → no-response', input: { exitCode: ExitCode.NoResponse }, expect: 'no-response' },
  { label: '13 exit 10 → insufficient-credits', input: { exitCode: ExitCode.InsufficientCredits }, expect: 'insufficient-credits' },

  // 14. The fallback.
  { label: '14 unknown model, exit 1 → unknown', input: { exitCode: ExitCode.Error, stderr: 'Error: unknown model "bogus/nonexistent".' }, expect: 'unknown' },
  { label: '14 exit 2 (never defined) → unknown', input: { exitCode: 2 }, expect: 'unknown' },
  { label: '14 exit 42 → unknown', input: { exitCode: 42 }, expect: 'unknown' },
];

describe('classify §5.2 table', () => {
  it.each(ROWS)('$label', ({ input: over, expect: expected }) => {
    expect(code(over)).toBe(expected);
  });
});

describe('classify totality', () => {
  it('never leaves a row unclassified: every non-success input yields a CliError', () => {
    for (const row of ROWS) {
      if (row.expect === null) {
        continue;
      }
      const error = classify(input(row.input));
      expect(error, `row: ${row.label}`).toBeInstanceOf(CliError);
    }
  });

  it('returns null for the success row and for no other row', () => {
    const successes = ROWS.filter((row) => classify(input(row.input)) === null);
    expect(successes.map((row) => row.label)).toEqual(['3d exit 0 + success subtype → null']);
  });

  it('classifies the same result frame to different codes as the exit code changes', () => {
    // The precedence the whole table exists to prove: subtype is only consulted
    // on a clean exit, so an `error` frame plus exit 5 is rate-limited, not
    // unknown, and the same frame on exit 9 is no-response.
    const errorFrame = { sawResultFrame: true, result: result('error') };
    expect(code({ ...errorFrame, exitCode: ExitCode.RateLimited })).toBe('rate-limited');
    expect(code({ ...errorFrame, exitCode: ExitCode.NoResponse })).toBe('no-response');
    expect(code({ ...errorFrame, exitCode: ExitCode.ServerError })).toBe('server');
    expect(code({ ...errorFrame, exitCode: ExitCode.Success })).toBe('unknown');
  });

  it('carries the exit code and stderr onto every error it returns', () => {
    const error = classify(input({ exitCode: ExitCode.RateLimited, stderr: 'boom' }));
    expect(error?.exitCode).toBe(ExitCode.RateLimited);
    expect(error?.stderr).toBe('boom');
  });
});

describe('classify code coverage', () => {
  /**
   * Every CliErrorCode `classify` can emit, and the one input that produces it.
   * Iterated rather than spot-checked: a code reachable from a §5.2 row that is
   * not listed here fails the assertion below, which is the point.
   */
  const BY_CLASSIFY: Readonly<Record<string, Partial<ClassifyInput>>> = {
    timeout: { timedOut: true, exitCode: ExitCode.Interrupted },
    interrupted: { exitCode: ExitCode.Interrupted },
    'no-response': { exitCode: ExitCode.Success },
    'max-turns': { exitCode: ExitCode.Success, sawResultFrame: true, result: result('max_turns') },
    unknown: { exitCode: 2 },
    'plan-gated': { exitCode: ExitCode.Error, stderr: PLAN },
    permission: { exitCode: ExitCode.PermissionDenied },
    auth: { exitCode: ExitCode.AuthError },
    'rate-limited': { exitCode: ExitCode.RateLimited },
    network: { exitCode: ExitCode.ConnectionError },
    server: { exitCode: ExitCode.ServerError },
    'insufficient-credits': { exitCode: ExitCode.InsufficientCredits },
  };

  /**
   * The producer ledger in types.ts, asserted from the other side: these codes
   * are produced AROUND classify — by the resolver, by the spawn and by the
   * reader — and classify must never invent one of them.
   */
  const AROUND_CLASSIFY: readonly CliErrorCode[] = [
    'cli-not-found',
    'cli-too-old',
    'spawn-failed',
    'malformed-stream',
  ];

  it('reaches every code the §5.2 table can produce', () => {
    for (const [expected, over] of Object.entries(BY_CLASSIFY)) {
      expect(classify(input(over))?.code, `code: ${expected}`).toBe(expected);
    }
  });

  it('emits exactly the classified codes across the whole table — and nothing produced around it', () => {
    const emitted = new Set(ROWS.map((row) => code(row.input)).filter((c) => c !== null));
    expect([...emitted].sort()).toEqual(Object.keys(BY_CLASSIFY).sort());
  });

  it('never emits a code that belongs to the resolver, the spawn or the reader', () => {
    for (const row of ROWS) {
      expect(AROUND_CLASSIFY).not.toContain(code(row.input));
    }
  });
});


