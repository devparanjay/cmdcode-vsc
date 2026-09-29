import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { NdjsonReader } from './ndjson.js';
import type { ResolvedCli } from './resolve.js';
import {
  CliError,
  ExitCode,
  isEventFrame,
  isResultFrame,
  ZERO_USAGE,
  type CliTransport,
  type Frame,
  type Logger,
  type ResultFrame,
  type RunHandlers,
  type RunRequest,
  type RunSummary,
} from '../types.js';

/**
 * SIGTERM → SIGKILL escalation window for cancel() and the timeout.
 *
 * A Node child that keeps a handle-less `process.on('exit')` handler alive can
 * handle SIGTERM and survive it, so a bare SIGTERM cannot be trusted to end a
 * run. The escalation is armed at the moment of the first signal and cleared
 * as soon as the child closes.
 */
export const KILL_GRACE_MS = 2000;

/** Anything longer than this is a hung CLI, not a slow one. Guards --max-turns<=100. */
export const MAX_PROMPT_BYTES = 1_000_000;

/** Byte cap on buffered stderr. Log-only; the CliError carries the truncated text. */
const MAX_STDERR_BYTES = 8 * 1024;

/** The vendor's own plan message, matched case-insensitively. */
const PLAN_STDERR = /model not in plan/i;

/**
 * The vendor's own permission heuristic, copied from `classifyPrintModeError`
 * so our `permission` copy matches the CLI's interpretation of its own error.
 */
const PERMISSION_STDERR = /permission denied|access denied|not permitted|unauthorized/i;

/** Everything `classify` is allowed to look at, and nothing else. */
export interface ClassifyInput {
  /** Child's exit status. null when it died from a signal. */
  readonly exitCode: number | null;
  /** reader.sawResultFrame() — the D3 predicate. NOT sawAnyFrame(). */
  readonly sawResultFrame: boolean;
  /** The terminal frame, or null when none arrived. */
  readonly result: ResultFrame | null;
  /** Accumulated stderr, already truncated. */
  readonly stderr: string;
  /**
   * True when our own deadline fired. Checked before the exit code, because our
   * SIGTERM produces exit 130 and would otherwise read as a user cancel.
   */
  readonly timedOut: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// classify — the ONLY place that maps a process outcome to a CliErrorCode.
//
// Pure and total: every input yields either a CliError or null, and null means
// success and nothing else. The rule order below is §5.2's algorithm verbatim;
// the table in test/classify.test.ts is that algorithm's exhaustive expansion.

export function classify(input: ClassifyInput): CliError | null {
  const { exitCode, sawResultFrame, result, stderr, timedOut } = input;

  // 1. Our own deadline outranks everything, including the 130 its own SIGTERM
  //    produces — otherwise a hung CLI and a user cancel are indistinguishable.
  if (timedOut) {
    return new CliError('timeout', 'the Command Code deadline fired', { stderr, exitCode });
  }

  // 2. A user cancel (SIGTERM → exit 130) or a death by signal (exitCode null).
  if (exitCode === ExitCode.Interrupted || exitCode === null) {
    return new CliError('interrupted', 'the run was interrupted', { stderr, exitCode });
  }

  // 3. A clean exit is the only place the result subtype is consulted at all.
  if (exitCode === ExitCode.Success) {
    // 3a. §D3: exit 0 with no result frame is an error, never a success.
    if (!sawResultFrame) {
      return new CliError('no-response', 'the CLI exited 0 without a result frame', {
        stderr,
        exitCode,
      });
    }
    if (result?.subtype === 'max_turns') {
      return new CliError('max-turns', 'the run stopped at the turn limit', { stderr, exitCode });
    }
    // 3c. Defensive only: never observed, because the vendor assigns a real
    //     non-zero exit alongside subtype 'error' (verified, §4.1a). Reporting
    //     `unknown` beats reporting success from an `error` frame.
    if (result?.subtype === 'error') {
      return new CliError('unknown', 'the CLI reported an error result with exit 0', {
        stderr,
        exitCode,
      });
    }
    // 3d. Success — the ONLY row that returns null.
    return null;
  }

  // 4. The plan string alone is never enough: guarded to the two exits that can
  //    plausibly carry it (§5.2 rule 4). Without the guard, every failing run
  //    quoting the phrase would read as plan-gated, including a rate limit.
  if (
    (exitCode === ExitCode.Error || exitCode === ExitCode.InsufficientCredits) &&
    PLAN_STDERR.test(stderr)
  ) {
    return new CliError('plan-gated', 'the model is not in your plan', { stderr, exitCode });
  }

  // 5. The vendor's own permission heuristic, guarded to the generic branch.
  if (exitCode === ExitCode.Error && PERMISSION_STDERR.test(stderr)) {
    return new CliError('permission', 'the CLI reported a permission error', { stderr, exitCode });
  }

  // 6–13. One row per vendor exit code. The exit code is classified BEFORE the
  //       result subtype, so a rate-limited run that also carries an `error`
  //       result frame still reports its real cause.
  switch (exitCode) {
    case ExitCode.MaxTurnsReached:
      return new CliError('max-turns', 'the run stopped at the turn limit', { stderr, exitCode });
    case ExitCode.AuthError:
      return new CliError('auth', 'the CLI reported an authentication error', { stderr, exitCode });
    case ExitCode.PermissionDenied:
      return new CliError('permission', 'the CLI was denied a permission', { stderr, exitCode });
    case ExitCode.RateLimited:
      return new CliError('rate-limited', 'the CLI reported a rate limit', { stderr, exitCode });
    case ExitCode.ConnectionError:
      return new CliError('network', 'the CLI reported a connection error', { stderr, exitCode });
    case ExitCode.ServerError:
      return new CliError('server', 'the CLI reported a server error', { stderr, exitCode });
    case ExitCode.NoResponse:
      return new CliError('no-response', 'the CLI exited with its no-response code', {
        stderr,
        exitCode,
      });
    case ExitCode.InsufficientCredits:
      return new CliError('insufficient-credits', 'the account is out of credits', {
        stderr,
        exitCode,
      });
    default:
      return new CliError('unknown', `the CLI exited ${exitCode}`, { stderr, exitCode });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The argv and env the child is spawned with.

/**
 * The exact argv for every run (AC-06). Order-sensitive and literal.
 *
 * Intentionally NOT passed: --yolo, --tools-all, --tools-enable,
 * --skip-onboarding, --trust, --plan, --permission-mode, --effort, --verbose.
 * Headless print mode already blocks file writes and shell commands, so
 * `--yolo` would only let a model-driven edit land in the user's workspace
 * from a Copilot suggestion; and `--plan` is a plan *selector* we must never
 * guess (reference/plans.md). `--effort` is omitted because mapping Copilot's
 * reasoning-effort control onto it is a product decision, not a v1 one.
 *
 * @throws CliError('timeout') when the prompt exceeds MAX_PROMPT_BYTES. Thrown
 *         here, before any process exists: past ARG_MAX the spawn itself fails
 *         with E2BIG, which is a far worse message than a size we can report.
 */
export function buildArgs(req: RunRequest): string[] {
  const bytes = Buffer.byteLength(req.prompt, 'utf8');
  if (bytes > MAX_PROMPT_BYTES) {
    throw new CliError('timeout', `prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES}-byte limit`);
  }
  const args: string[] = [];
  if (req.resumeSessionId) {
    args.push('-r', req.resumeSessionId);
  }
  args.push('-p', req.prompt);
  args.push('--output-format', 'json');
  args.push('-m', req.model);
  args.push('--max-turns', String(req.maxTurns));
  args.push('--no-auto-update');
  if (req.readImages) {
    // Headless mode has no way to ask the user for consent, so image vision
    // resolves to false unless this is set:
    //   const e = await getImageVisionEnabled();
    //   if (void 0 !== e) return e;      // explicit setting wins
    //   if (!S.askQuestion) return !1;   // headless → refuse
    // It is passed only when the turn actually carries an image, so a text-only
    // turn is not silently opting the user into reading images.
    args.push('--config', 'imageVisionEnabled=true');
  }
  return args;
}

/**
 * The argv as it is logged: every flag and value, except the prompt, which is
 * replaced by a length. The prompt is the user's own conversation text and the
 * output channel is what they paste into a bug report, so the spawn line keeps
 * the configuration that is observable behaviour (`--max-turns`, `-m`, `-r`)
 * and drops the one that is not.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-p' && i + 1 < args.length) {
      out.push('-p', `<${Buffer.byteLength(args[i + 1], 'utf8')} bytes>`);
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * The env overlay for the child: a NEW object carrying `baseEnv` plus three
 * forced values. Never mutates its argument, and never invents a
 * CMD_CONFIG_DIR — the child must honour the user's real config.
 *
 * `CI: '1'` is a correctness requirement, not a test convenience (ADR-01): the
 * vendor's auto-installer returns immediately under CI, so a turn can never
 * cause an install. PATH is inherited unchanged — the resolver either found
 * `cmd` on it or handed us an absolute path.
 */
export function buildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The transport.

/** Just the two pipes the transport reads. */
type WritableLike = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  setEncoding(encoding: BufferEncoding): void;
};

/**
 * An EventEmitter-shaped child: what the transport actually touches, and
 * exactly what a hand-driven EventEmitter can present in the test tree.
 */
export type ChildLike = {
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  // `any[]` rather than `never[]`: a real EventEmitter's `on` is generic over
  // `any[]` args, and the narrower form is not assignable from it. This is the
  // standard EventEmitter structural signature, and the only way it can be
  // misused is by passing a listener this module owns.
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};
/** The options the transport builds for a spawn; `shell` is false by design. */
export interface SpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: ['ignore', 'pipe', 'pipe'];
}

/**
 * The seam the test tree drives instead of a real `cmd` binary: it returns a
 * fake child rather than spawning one. Defaults to `spawn`; the production path
 * never overrides it, so this is not a shipped extension point.
 */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildLike;

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    // No shell, ever: the prompt is arbitrary user text, and passing it as argv
    // means it is never interpreted by one (§4.6).
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Renders an unknown throwable for the output channel. */
function describeUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One spawned child and the coordination state that belongs to it alone.
 *
 * Every field here is per-RUN, and the bug this replaces was four pieces of per-run
 * state living on the shared instance. `killTimer` in particular is the SIGKILL
 * backstop for exactly this child: no other run may read, write, or clear it.
 */
interface RunState {
  /** The spawned child. Never reassigned after execute() allocates the state. */
  readonly child: ChildLike;
  /**
   * The SIGTERM -> SIGKILL escalation for THIS run, or null when none is armed.
   * Armed by signal(), cleared by settle() — and by nothing else, ever.
   */
  killTimer: NodeJS.Timeout | null;
}

/**
 * One headless run of the CLI.
 *
 * `run` NEVER rejects. It resolves on child `close` — lifecycle-driven, never on
 * the arrival of a result frame (§D3): an invalid model yields exit 1 with zero
 * bytes of stdout, so a result-frame-driven design would wait forever. Failures
 * arrive through `handlers.onError`, exactly once, and the only pre-spawn
 * failures (an unlocatable CLI, an oversize prompt) report and return.
 */
export class CliTransportImpl implements CliTransport {
  /** Every run that has spawned a child and not yet closed it. */
  private readonly live = new Set<RunState>();
  /** A cancel with no live child, awaiting the next run. Cleared on consumption. */
  private pendingCancel = false;

  constructor(
    private readonly resolve: () => Promise<ResolvedCli | null>,
    private readonly log: Logger,
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {}

  /**
   * Spawn one run and resolve when the child closes.
   *
   * @param req.cwd the working directory for the child process.
   */
  async run(req: RunRequest, handlers: RunHandlers): Promise<void> {
    let cli: ResolvedCli | null;
    try {
      cli = await this.resolve();
    } catch (err) {
      this.log.error(`Command Code: CLI resolution failed: ${describeUnknown(err)}`);
      handlers.onError(new CliError('cli-not-found', 'the CLI could not be located'));
      return;
    }

    // A cancel that landed while the resolver was still running: that turn has no
    // child to kill, so the request is latched here and consumed by this run rather
    // than silently dropped (§5.3). Only reachable when NO run is live — a cancel
    // aimed at a live run (§P4) must not latch against a future one.
    if (this.pendingCancel) {
      this.pendingCancel = false;
      this.log.info('Command Code: cancelled before the run started');
      handlers.onError(new CliError('interrupted', 'the run was cancelled before it started'));
      return;
    }

    let args: string[];
    try {
      args = buildArgs(req); // throws before any process is created
    } catch (err) {
      this.log.error(`Command Code: ${describeUnknown(err)}`);
      handlers.onError(
        err instanceof CliError ? err : new CliError('unknown', 'the request could not be built'),
      );
      return;
    }

    if (cli === null) {
      this.log.error('Command Code: the CLI could not be located');
      handlers.onError(new CliError('cli-not-found', 'the CLI could not be located'));
      return;
    }

    // §AC-16 observability: the spawn line is what makes `maxTurns` and
    // `timeoutSeconds` visible in the log, which is the only place either is
    // observable at runtime. The prompt is redacted — it is the user's own
    // conversation text, and the log is something they paste into bug reports.
    // `cli.args` leads the real spawn argv, so the line has to carry it too or
    // the npm-global mode would name a node binary with no entry point.
    this.log.info(
      `Command Code: spawning ${cli.command} ${[...cli.args, ...redactArgs(args)].join(' ')}`,
    );

    await this.execute(req, cli, args, handlers);
  }

  async cancel(): Promise<void> {
    if (this.live.size === 0) {
      // §5.3: a cancel with no live child latches, and the NEXT run consumes the
      // latch. VS Code may cancel before the first spawn, and that turn must
      // still not run. A cancel aimed at a live run signals it instead and must
      // not latch: the next turn the user starts is a new intent.
      this.pendingCancel = true;
      this.log.info('Command Code: cancel with no live child');
      return;
    }
    for (const state of [...this.live]) {
      this.signal(state, 'cancellation requested');
    }
    // Deliberately no await: §P5. A cancel that waited on a child's completion
    // would wait on the very behaviour it just requested. The per-run SIGKILL
    // escalation is the backstop for a child that ignores SIGTERM.
  }

  async describe(): Promise<string | null> {
    let cli: ResolvedCli | null;
    try {
      cli = await this.resolve();
    } catch {
      return null;
    }
    if (cli === null) {
      return null;
    }
    return cli.args.length > 0 ? `${cli.command} ${cli.args.join(' ')}` : cli.command;
  }

  /** SIGTERM now, SIGKILL after KILL_GRACE_MS if the child is still there. */
  private signal(state: RunState, reason: string): void {
    this.log.info(`Command Code: ${reason}; sending SIGTERM`);
    state.child.kill('SIGTERM');
    if (state.killTimer !== null) {
      return; // an escalation is already armed FOR THIS RUN
    }
    state.killTimer = setTimeout(() => {
      state.killTimer = null;
      this.log.error('Command Code: SIGKILL after KILL_GRACE_MS');
      state.child.kill('SIGKILL');
    }, KILL_GRACE_MS);
  }

  /**
   * Spawn, stream, and resolve on `close`.
   *
   * The returned promise is a completion PROMISE, not a gate: the only way out
   * of it is the `settle` call in the close handler, so a refused spawn, a dead
   * child and a deadline all leave through `onError` and none of them rejects.
   */
  private execute(
    req: RunRequest,
    cli: ResolvedCli,
    args: readonly string[],
    handlers: RunHandlers,
  ): Promise<void> {
    return new Promise<void>((resolveRun) => {
      let settled = false;
      let stdoutBytes = 0;
      let stderr = '';
      let result: ResultFrame | null = null;
      let sessionId: string | null = null;
      let timedOut = false;
      let spawnError: CliError | null = null;
      let streamError: CliError | null = null;

      const reader = new NdjsonReader((frame: Frame) => {
        if (isResultFrame(frame)) {
          result = frame;
          return;
        }
        if (!isEventFrame(frame)) {
          return;
        }
        if (frame.event.type === 'run_start') {
          const id = frame.event['sessionId'];
          if (typeof id === 'string' && id !== '') {
            sessionId = id;
            handlers.onSessionId(id);
          }
          return;
        }
        if (frame.event.type === 'text_delta') {
          const delta = frame.event['delta'];
          if (typeof delta === 'string' && delta !== '') {
            handlers.onTextDelta(delta);
          }
        }
      });

      // The single exit from the run. `error` is always followed by `close`, so
      // recording the spawn failure here and letting close finish is enough;
      // settling on both would fire onError twice.
      const settle = (code: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (deadline !== null) {
          clearTimeout(deadline);
        }
        // The narrowing happens once, here: the spawn-throw path runs with no
        // state at all, and under the old shared field it destroyed whichever
        // OTHER run's escalation happened to be armed.
        const owned: RunState | null = state;
        if (owned !== null) {
          if (owned.killTimer !== null) {
            clearTimeout(owned.killTimer);
            owned.killTimer = null;
          }
          this.live.delete(owned);
        }
        this.log.info(
          `Command Code: exited ${code === null ? 'on a signal' : `with code ${code}`}; ` +
            `${reader.frameCount()} frames, ${stdoutBytes} stdout bytes`,
        );

        // Precedence below `classify`: the two failures we detected ourselves
        // describe a stream or a process that never ran, and neither is
        // recoverable by looking at the exit code.
        const error =
          spawnError ??
          streamError ??
          classify({
            exitCode: code,
            // §D3's predicate, never sawAnyFrame(): a stream of events only is
            // exactly the case that must not read as an answer.
            sawResultFrame: reader.sawResultFrame(),
            result,
            stderr,
            timedOut,
          });
        if (error !== null) {
          this.log.error(`Command Code: [${error.code}] ${error.message}`);
          handlers.onError(error);
          resolveRun();
          return;
        }
        const summary: RunSummary = {
          sessionId: result?.sessionId ?? sessionId,
          text: result?.finalText ?? '',
          usage: result?.usage ?? ZERO_USAGE,
          durationMs: result?.durationMs ?? 0,
          stopReason: result?.stopReason ?? null,
        };
        handlers.onDone(summary);
        resolveRun();
      };

      let child: ChildLike | null = null;
      let deadline: NodeJS.Timeout | null = null;
      let state: RunState | null = null;
      try {
        child = this.spawnFn(cli.command, [...cli.args, ...args], {
          cwd: req.cwd,
          env: buildEnv(process.env),
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        this.log.error(`Command Code: spawn failed: ${describeUnknown(err)}`);
        spawnError = new CliError('spawn-failed', 'the CLI process could not be started');
        settle(ExitCode.Error);
        return;
      }
      // After the try/catch, so a spawn that threw never enters the registry:
      // `live` holds exactly the runs with a spawned, not-yet-closed child.
      const run: RunState = { child, killTimer: null };
      this.live.add(run);
      state = run; // the binding the hoisted `settle` closes over
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        const failure = reader.push(chunk as string);
        if (failure !== null && streamError === null) {
          streamError = failure;
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        if (stderr.length < MAX_STDERR_BYTES) {
          stderr += chunk.toString();
        }
      });
      child.on('error', (err: unknown) => {
        this.log.error(`Command Code: child error: ${describeUnknown(err)}`);
        if (spawnError === null) {
          spawnError = new CliError('spawn-failed', 'the CLI process could not be started');
        }
      });
      child.on('close', (code: number | null) => {
        // A truncated pipe leaves a last line with no newline behind it; it is
        // still the answer, so flush it before classifying.
        const tail = reader.end();
        if (tail !== null && streamError === null) {
          streamError = tail;
        }
        settle(code);
      });

      // §5.4: the deadline is armed after the spawn, so a turn cannot be timed
      // out by a resolver that was slow. 0 disables it. The callback captures
      // the non-null `run` const, never the nullable `state` hoisted above:
      // narrowing does not carry into a deferred function, so `state` would
      // widen back to `RunState | null` here and fail to typecheck.
      if (req.timeoutMs > 0) {
        deadline = setTimeout(() => {
          timedOut = true;
          this.signal(run, 'deadline reached');
        }, req.timeoutMs);
      }
    });
  }
}
