// ─────────────────────────────────────────────────────────────────────────────
// Vendor id. A LanguageModelChatInformation.id must be unique per provider.
//
// Frozen. This string is hashed into every `cmdc-` model id (see `chatIdFor`),
// so changing it would orphan every existing chat and invalidate every pinned
// model. Only the DISPLAY name may change freely.
export const VENDOR_ID = 'cmdcode';

/**
 * The second vendor, for the direct Provider API.
 *
 * A separate vendor rather than a mode on the first, because the two are
 * different capabilities: the CLI runs its own tools in-process and cannot host
 * Copilot's tool loop, while the API passes tool arrays through and lets the
 * client execute them. A Go-plan user also has the CLI and not the API, and a
 * single vendor with a mode would silently swap one out from under them.
 */
export const API_VENDOR_ID = 'cmdcode-api';

/** Value reported as LanguageModelChatInformation.version — our adapter, not the model. */
export const ADAPTER_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// CLI exit codes. Verified against command-code@1.66.0, dist/cli.mjs:
//   iT={SUCCESS:0,ERROR:1,AUTH_ERROR:3,PERMISSION_DENIED:4,RATE_LIMITED:5,
//       CONNECTION_ERROR:6,SERVER_ERROR:7,MAX_TURNS_REACHED:8,NO_RESPONSE:9,
//       INSUFFICIENT_CREDITS:10,INTERRUPTED:130}
// NOTE: there is no exit code 2. The enum jumps 1 -> 3.
//
// Declared as a frozen const object plus a same-named type, NOT `const enum`:
// test/classify.test.ts iterates these values at runtime, and `const enum`
// inlines under plain tsc while esbuild (tsup, vitest) gives it different
// semantics. A runtime-value object behaves identically under all three.
export const ExitCode = Object.freeze({
  Success: 0,
  Error: 1,
  AuthError: 3,
  PermissionDenied: 4,
  RateLimited: 5,
  ConnectionError: 6,
  ServerError: 7,
  MaxTurnsReached: 8,
  NoResponse: 9,
  InsufficientCredits: 10,
  Interrupted: 130,
} as const);

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

// ─────────────────────────────────────────────────────────────────────────────
// Plan tiers, cheapest first. Verified: reference/plans.md —
//   "Individual plans, cheapest first: Go, GOAT, Pro, Max."
//   "read the Min plan column in models.md ... every higher plan includes it."
// This is CATALOG METADATA used to label models. It is NEVER used to gate a
// request — see the note on minPlan below.
export type PlanTier = 'go' | 'goat' | 'pro' | 'max';

export const PLAN_TIER_ORDER: readonly PlanTier[] = ['go', 'goat', 'pro', 'max'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// A single catalog entry. Display data is transcribed from the CLI's
// reference/models.md; capability flags come from the CLI's own static catalog.
export interface CatalogModel {
  /** EXACT id accepted by `cmd -m`. Never transform, lowercase, or trim. */
  readonly id: string;
  /**
   * Whether the model accepts image input.
   *
   * NOT derived from `blurb`. The prose is not a data source — it disagrees
   * with the product in both directions: `deepseek/deepseek-v4.1-flash` says
   * "with vision" and is vision-capable, while `deepseek/deepseek-v4-pro` says
   * nothing about vision and is text-only. This flag mirrors the CLI's own
   * catalog, which is what the product branches on:
   *
   *   modelSupportsVision: m => !m?.inputModalities || m.inputModalities.includes("image")
   *
   * Regenerate with `node scripts/sync-capabilities.mjs --write`.
   */
  readonly vision: boolean;
  /**
   * Whether the model produces reasoning content. Captured for accuracy; it
   * gates nothing in the VS Code API today.
   */
  readonly reasoning: boolean;
  /** Human display name, e.g. "Space Bunny Alpha". */
  readonly name: string;
  /** Context window in tokens. 0 when the catalog does not state one. */
  readonly contextWindow: number;
  /**
   * Reasoning efforts this model accepts. Empty when the catalog lists none.
   * Verified set: low | medium | high | xhigh | max.
   */
  readonly efforts: readonly string[];
  /** Cheapest plan that can serve this model. */
  readonly minPlan: PlanTier;
  /** One-line "best for" blurb, shown as the model tooltip. */
  readonly blurb: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration. Every key has exactly one consumer, listed in §6.1.
// Populated once, at activation, by readConfig() in src/extension.ts.
export type LogLevel = 'error' | 'normal' | 'verbose';

export interface CmdCodeConfig {
  /** `cmdcode.cliPath`. Empty string means "auto-resolve" (§4.4). */
  readonly cliPath: string;
  /** `cmdcode.maxTurns`, already clamped to 1..100. Becomes RunRequest.maxTurns. */
  readonly maxTurns: number;
  /** `cmdcode.timeoutSeconds` × 1000. 0 disables the deadline. */
  readonly timeoutMs: number;
  /** `cmdcode.maxPromptChars` → buildPrompt({maxChars}). */
  readonly maxPromptChars: number;
  /** `cmdcode.logLevel` → createLogger(). */
  readonly logLevel: LogLevel;
  /**
   * `cmdcode.imageSupport`. True by default: image support is a feature, not a
   * risk, and a user who does not attach images is unaffected either way. When
   * false, image parts are dropped and the CLI is not asked to read any.
   */
  readonly imageSupport: boolean;
  /**
   * `cmdcode.enableCliProvider`. The CLI path works on every plan, so it is on
   * by default; a user can turn it off to run API-only.
   */
  readonly enableCliProvider: boolean;
  /**
   * `cmdcode.enableApiProvider`. The API path needs a key and a GOAT-or-higher
   * plan, so it is opt-in — but registering the vendor is free without one, so
   * this only controls whether the group is offered, not whether a key is set.
   */
  readonly enableApiProvider: boolean;
  /**
   * `cmdcode.zeroDataRetention`. Sends `x-cmd-zdr: 1`, which enforces no prompt
   * training and ZDR-only routing — and narrows the accepted tool set, so a
   * request carrying anything outside it fails. See src/api/tools.ts.
   */
  readonly zeroDataRetention: boolean;
}

export const CONFIG_DEFAULTS: Readonly<CmdCodeConfig> = Object.freeze({
  cliPath: '',
  maxTurns: 24,
  timeoutMs: 600_000,
  maxPromptChars: 900_000,
  logLevel: 'normal',
  imageSupport: true,
  enableCliProvider: true,
  enableApiProvider: true,
  zeroDataRetention: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// Errors. One flat class with a discriminated code; carries a user-safe message
// and the raw stderr for the output channel.
//
// Producer ledger — every code has exactly one producer (test: "every
// CliErrorCode is produced by some row" is covered by test/errors.test.ts):
//
//   cli-not-found      extension.ts      resolveCli() returned null
//   cli-too-old        extension.ts      supportsJsonOutput() returned false
//   spawn-failed       cli/process.ts    child_process.spawn() threw synchronously
//   timeout            cli/process.ts    our own deadline fired (checked first)
//   interrupted        cli/process.ts    exit 130, or exitCode === null (signalled)
//   auth               cli/process.ts    classify(), exit 3
//   plan-gated         cli/process.ts    classify(), exit 1 or 10 AND stderr
//                                          matches "Model not in plan" (§5.2 rule 4)
//   rate-limited       cli/process.ts    classify(), exit 5
//   network            cli/process.ts    classify(), exit 6
//   server             cli/process.ts    classify(), exit 7
//   permission         cli/process.ts    classify(), exit 4, or exit 1 + a permission string
//   max-turns          cli/process.ts    classify(), exit 8, or a max_turns result frame
//   no-response        cli/process.ts    classify(), exit 9, or exit 0 with no result frame
//   insufficient-credits cli/process.ts   classify(), exit 10
//   malformed-stream   cli/ndjson.ts     reader returned a protocol-violation error
//   unknown            cli/process.ts    classify() fallback
export type CliErrorCode =
  | 'cli-not-found'        // cmd not on PATH / not executable
  | 'cli-too-old'          // installed cmd lacks --output-format json
  | 'spawn-failed'         // child_process spawn threw
  | 'timeout'              // our own wall-clock deadline fired
  | 'auth'                 // exit 3
  | 'plan-gated'           // exit 1 or 10 AND stderr "Model not in plan:" (§5.2 rule 4)
  | 'rate-limited'         // exit 5
  | 'network'              // exit 6
  | 'server'               // exit 7
  | 'permission'           // exit 4
  | 'max-turns'            // exit 8, or a max_turns result frame
  | 'no-response'          // exit 9, or no result frame at all
  | 'insufficient-credits' // exit 10
  | 'interrupted'          // exit 130 / our own cancellation / killed by signal
  | 'malformed-stream'     // stdout was not parseable NDJSON
  | 'unknown';             // exit 1 or anything unrecognized

export class CliError extends Error {
  readonly code: CliErrorCode;
  /** Raw stderr, truncated to 8 KiB. Log-only; never shown to the user. */
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(
    code: CliErrorCode,
    message: string,
    opts: { stderr?: string; exitCode?: number | null } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.stderr = opts.stderr ?? '';
    this.exitCode = opts.exitCode ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NDJSON frame shapes. Verified against live runs of
//   cmd -p "reply with exactly: PONG" --output-format json -m stealth/space-bunny-alpha
// against command-code@1.66.0 (see §4.1a for the captured stream).
//
// Stream = zero or more {"type":"event","event":{...}}, then exactly one
// {"type":"result",...}. Unknown `event.type` values MUST be ignored
// (forward compatibility — reference/headless.md:145 says so explicitly).

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** The zero-usage constant the CLI uses when no model request completed ✅. */
export const ZERO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/**
 * The single terminal frame. `sessionId`, `stopReason` and `error` are optional.
 *
 * Verified shape (command-code@1.66.0, `buildPrintResultLine`):
 *   {type, subtype, sessionId?, stopReason?, usage, durationMs, finalText, error?}
 *
 * `finalText` is the assistant's final answer **verbatim, with no trailing newline**
 * ✅ (captured: `'PONG'`). Do not trim it.
 */
export interface ResultFrame {
  readonly type: 'result';
  readonly subtype: 'success' | 'error' | 'max_turns';
  readonly sessionId?: string;
  readonly stopReason?: string;
  readonly usage: Usage;
  readonly durationMs: number;
  /** Empty string when subtype === 'error'. */
  readonly finalText: string;
  readonly error?: string;
}

// Event payloads are intentionally open: we consume exactly two event types
// (text_delta, run_start) and ignore the rest.
export type EventFrame = {
  readonly type: 'event';
  readonly event: { readonly type: string; readonly [k: string]: unknown };
};

export type Frame = EventFrame | ResultFrame;

export function isResultFrame(f: Frame): f is ResultFrame {
  return f.type === 'result';
}
export function isEventFrame(f: Frame): f is EventFrame {
  return f.type === 'event';
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport contract — the single seam between the provider and the CLI.
// One implementation ships: CliTransport. See §9.1 for the HTTP migration path.

/** Incremental callbacks. A turn is driven by the transport, never by timers. */
export interface RunHandlers {
  /**
   * Fired for each text_delta event, in arrival order. Forwarded to
   * progress.report immediately — never buffered (AC-05).
   * @param delta non-empty text fragment
   */
  onTextDelta(delta: string): void;
  /**
   * Fired once, with the CLI session id, as soon as run_start is seen. The
   * provider records it but only persists it on success (§4.9), so a failed
   * turn never poisons the session cache.
   */
  onSessionId(sessionId: string): void;
  /**
   * Fired when the run failed. Exactly one of onDone / onError will run,
   * exactly once. The provider captures this and throws after the awaited run
   * returns — `run` itself never rejects (§4.9 step 12).
   */
  onError(error: CliError): void;
  /** Fired on terminal success. Never fires alongside onError. */
  onDone(summary: RunSummary): void;
}

export interface RunSummary {
  readonly sessionId: string | null;
  /**
   * `result.finalText` verbatim, or '' when no result frame arrived (which is
   * itself always an error, so onDone never carries an empty text unless
   * finalText was genuinely empty). Never newline-trimmed.
   */
  readonly text: string;
  readonly usage: Usage;
  readonly durationMs: number;
  readonly stopReason: string | null;
}

export interface RunRequest {
  /** Fully-rendered prompt. Sent as a single argv element. */
  readonly prompt: string;
  /** `-m` value. Always a verified catalog id. */
  readonly model: string;
  /** `--max-turns` value. From CmdCodeConfig.maxTurns, clamped 1..100. */
  readonly maxTurns: number;
  /** `-r` value, or null for a fresh session. Optimization only (§D1). */
  readonly resumeSessionId: string | null;
  /** Working directory for the child process. */
  readonly cwd: string;
  /** Hard wall-clock ceiling in ms. 0 disables. */
  readonly timeoutMs: number;
  /**
   * Whether this turn carries an image. When true the spawn adds
   * `--config imageVisionEnabled=true`, because headless mode has no way to ask
   * the user for consent and therefore refuses to read any image by default.
   */
  readonly readImages: boolean;
}

export interface CliTransport {
  /**
   * Spawn one headless run. Resolves when the CHILD PROCESS closes — NOT when a
   * result frame arrives. See §D3: an invalid model yields exit 1 with zero
   * stdout, so lifecycle-driven completion is mandatory.
   *
   * Never rejects. Failures arrive via handlers.onError.
   */
  run(req: RunRequest, handlers: RunHandlers): Promise<void>;
  /**
   * Abort the in-flight run(s) on this transport.
   *
   * Sends SIGTERM to EVERY live run, not just the newest: a user pressing stop in
   * a chat holding several in-flight turns means "stop" (§P4). Each signalled
   * child keeps its own independent SIGKILL escalation after KILL_GRACE_MS, so a
   * child that ignores SIGTERM is still reaped.
   *
   * Does NOT wait for any child to exit (§P5). Awaiting here would make cancel
   * depend on the process it just signalled, which is a deadlock whenever that
   * process is slow to honour SIGTERM — the one case the escalation exists for.
   * The escalation, not this promise, is the backstop.
   *
   * With no live child, this resolves immediately and latches: the NEXT run()
   * reports `interrupted` without spawning (§P6). A cancel issued while a run IS
   * live does not latch.
   */
  cancel(): Promise<void>;
  /** Resolves a display string for the resolved CLI path, or null if not found. */
  describe(): Promise<string | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging. Kept here (rather than in a src/log.ts) because it is a 15-line pure
// function over a structural channel type: it needs no `vscode` import, so
// types.ts stays importable from plain vitest, and it avoids an extra file in
// the parallel-execution map for something with no second implementation.

/** Structurally satisfied by vscode.OutputChannel; declared locally to keep types.ts vscode-free. */
export interface OutputChannelLike {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface Logger {
  /** Always emitted. */
  error(message: string): void;
  /** Emitted unless level === 'error'. */
  info(message: string): void;
  /** Emitted only when level === 'verbose'. */
  debug(message: string): void;
  /** Reveal the output channel. */
  show(preserveFocus?: boolean): void;
}

/**
 * Wraps an OutputChannel in level filtering. The `level` argument is captured
 * at construction and never re-read; see §6.3 for why settings are not live.
 */
export function createLogger(channel: OutputChannelLike, level: LogLevel): Logger {
  return {
    error(message: string): void {
      channel.appendLine(`[error] ${message}`);
    },
    info(message: string): void {
      if (level !== 'error') {
        channel.appendLine(`[info] ${message}`);
      }
    },
    debug(message: string): void {
      if (level === 'verbose') {
        channel.appendLine(`[debug] ${message}`);
      }
    },
    show(preserveFocus?: boolean): void {
      channel.show(preserveFocus);
    },
  };
}
