import type { CliTransport, Frame, RunHandlers, RunRequest, RunSummary } from '../src/types.js';
import { CliError, ZERO_USAGE } from '../src/types.js';

/**
 * The `CliTransport` seam, faked.
 *
 * `CliTransport` exists as an interface precisely so the provider can be tested
 * without a process (§9.1). This is that second consumer: it replays a scripted
 * stream instead of spawning a CLI, which makes `test/provider.test.ts` hermetic
 * and instant — nothing here ever forks a process.
 */
export class FakeTransport implements CliTransport {
  /** Everything the provider asked us to run, in order. */
  readonly requests: RunRequest[] = [];

  /** Set by the test to make the next run fail through `onError`. */
  nextError: CliError | null = null;

  /** Frames the next run replays, in order, through the real handlers. */
  nextFrames: Frame[] = [];

  /** Set when the test wants a session id even if no result frame carries one. */
  nextSessionId: string | null = null;

  /** Number of times `cancel()` was called. */
  cancelCount = 0;

  /** How many times `describe()` was called. */
  describeCount = 0;

  async run(req: RunRequest, handlers: RunHandlers): Promise<void> {
    this.requests.push(req);

    for (const frame of this.nextFrames) {
      if (frame.type === 'result') {
        if (this.nextSessionId !== null && frame.sessionId === undefined) {
          handlers.onSessionId(this.nextSessionId);
        }
        continue;
      }
      if (frame.event.type === 'text_delta') {
        const delta = frame.event['delta'];
        if (typeof delta === 'string' && delta !== '') {
          handlers.onTextDelta(delta);
        }
      } else if (frame.event.type === 'run_start') {
        const sessionId = frame.event['sessionId'];
        if (typeof sessionId === 'string' && sessionId !== '') {
          handlers.onSessionId(sessionId);
        }
      }
    }

    if (this.nextError !== null) {
      // The contract is that `run` NEVER rejects (§4.1): a failure arrives only
      // through `onError`. The provider captures it and re-throws after the
      // await, which is what these tests exercise.
      handlers.onError(this.nextError);
      return;
    }

    handlers.onDone(this.summary());
  }

  async cancel(): Promise<void> {
    this.cancelCount += 1;
  }

  async describe(): Promise<string | null> {
    this.describeCount += 1;
    return 'fake';
  }

  /** The terminal result frame's projection, as the real transport would build it. */
  private summary(): RunSummary {
    const result = this.nextFrames.find((f) => f.type === 'result');
    const text = result !== undefined && result.type === 'result' ? result.finalText : '';
    const sessionId =
      result !== undefined && result.type === 'result' && result.sessionId !== undefined
        ? result.sessionId
        : this.nextSessionId;
    return {
      sessionId: sessionId ?? null,
      text,
      usage: ZERO_USAGE,
      durationMs: 0,
      stopReason: null,
    };
  }
}

/**
 * A cancellation token whose listener bookkeeping is observable.
 *
 * AC-14 requires the provider's `onCancellationRequested` subscription to be
 * disposed on every exit path, including the throwing one. Inferring that from
 * behaviour is impossible — a leaked listener simply stays attached — so the
 * fake counts registrations and disposals and the test asserts the two balance.
 */
export class FakeCancellationToken {
  /** True from construction, or once `cancel()` is called. */
  isCancellationRequested = false;

  /** Cumulative count of `onCancellationRequested` calls. */
  registrations = 0;

  /** Cumulative count of disposals on the subscriptions handed back. */
  disposals = 0;

  private readonly listeners = new Set<() => void>();

  readonly onCancellationRequested = (listener: () => void): { dispose: () => void } => {
    this.registrations += 1;
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.disposals += 1;
        this.listeners.delete(listener);
      },
    };
  };

  /** Fire every live listener, as the host would on a user cancel. */
  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /** Listeners still attached — zero on every clean exit path. */
  get liveListenerCount(): number {
    return this.listeners.size;
  }
}

