import { describe, expect, it } from 'vitest';

import {
  ADAPTER_VERSION,
  CONFIG_DEFAULTS,
  ExitCode,
  PLAN_TIER_ORDER,
  VENDOR_ID,
  ZERO_USAGE,
  createLogger,
  isEventFrame,
  isResultFrame,
  type EventFrame,
  type Frame,
  type OutputChannelLike,
  type ResultFrame,
} from '../src/types.js';

// No `vscode` import anywhere in this file: types.ts must be importable from a
// plain vitest run with no alias and no stub (AC-6).

const RESULT: ResultFrame = {
  type: 'result',
  subtype: 'success',
  sessionId: 'ab4c5b22-0000-4000-8000-000000000000',
  stopReason: 'end_turn',
  usage: ZERO_USAGE,
  durationMs: 3060,
  finalText: 'PONG',
};

const EVENT: EventFrame = { type: 'event', event: { type: 'run_start', sessionId: 's-1' } };

describe('ExitCode', () => {
  it('carries the verified CLI exit numbers, asserted one by one', () => {
    // Never derived from a loop: a typo in a single number must fail here.
    expect(ExitCode.Success).toBe(0);
    expect(ExitCode.Error).toBe(1);
    expect(ExitCode.AuthError).toBe(3);
    expect(ExitCode.PermissionDenied).toBe(4);
    expect(ExitCode.RateLimited).toBe(5);
    expect(ExitCode.ConnectionError).toBe(6);
    expect(ExitCode.ServerError).toBe(7);
    expect(ExitCode.MaxTurnsReached).toBe(8);
    expect(ExitCode.NoResponse).toBe(9);
    expect(ExitCode.InsufficientCredits).toBe(10);
    expect(ExitCode.Interrupted).toBe(130);
  });

  it('has no exit code 2 — the enum jumps 1 -> 3', () => {
    const values = Object.values(ExitCode);
    expect(values).not.toContain(2);
    expect(values).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 130]);
  });

  it('is a frozen runtime object, not an inlined const enum', () => {
    // A `const enum` has no runtime presence at all, so this object existing
    // under vitest's esbuild transform is the assertion.
    expect(Object.isFrozen(ExitCode)).toBe(true);
    expect(Object.keys(ExitCode)).toHaveLength(11);
  });
});

describe('CONFIG_DEFAULTS', () => {
  it('is frozen with the six architecture 6.1 defaults', () => {
    expect(Object.isFrozen(CONFIG_DEFAULTS)).toBe(true);
    expect(CONFIG_DEFAULTS.cliPath).toBe('');
    expect(CONFIG_DEFAULTS.maxTurns).toBe(24);
    // Seconds × 1000: the manifest default is 600 s, this is ms.
    expect(CONFIG_DEFAULTS.timeoutMs).toBe(600_000);
    expect(CONFIG_DEFAULTS.showThinkingPlaceholder).toBe(true);
    expect(CONFIG_DEFAULTS.maxPromptChars).toBe(900_000);
    expect(CONFIG_DEFAULTS.logLevel).toBe('normal');
  });

  it('does not mutate on assignment', () => {
    expect(() => {
      (CONFIG_DEFAULTS as { maxTurns: number }).maxTurns = 1;
    }).toThrow(TypeError);
    expect(CONFIG_DEFAULTS.maxTurns).toBe(24);
  });
});

describe('vendor constants', () => {
  it('exports the vendor id and the adapter version', () => {
    expect(VENDOR_ID).toBe('cmdcode');
    expect(ADAPTER_VERSION).toBe('1.0.0');
  });

  it('orders plan tiers cheapest first', () => {
    expect(PLAN_TIER_ORDER).toEqual(['go', 'goat', 'pro', 'max']);
  });

  it('freezes the zero-usage constant', () => {
    expect(ZERO_USAGE).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(Object.isFrozen(ZERO_USAGE)).toBe(true);
  });
});

describe('frame type guards', () => {
  it('narrows a result frame and rejects an event frame', () => {
    const frames: readonly Frame[] = [RESULT, EVENT];
    const results = frames.filter(isResultFrame);
    expect(results).toHaveLength(1);
    // Narrowed to ResultFrame: finalText is reachable without a cast.
    expect(results[0].finalText).toBe('PONG');

    expect(isResultFrame(EVENT)).toBe(false);
  });

  it('narrows an event frame and rejects a result frame', () => {
    const frames: readonly Frame[] = [RESULT, EVENT];
    const events = frames.filter(isEventFrame);
    expect(events).toHaveLength(1);
    // Narrowed to EventFrame: the open event payload is reachable.
    expect(events[0].event.type).toBe('run_start');

    expect(isEventFrame(RESULT)).toBe(false);
  });
});

/** A plain object satisfying OutputChannelLike — no vscode import, no stub. */
function fakeChannel(): OutputChannelLike & {
  readonly lines: string[];
  readonly shows: Array<boolean | undefined>;
} {
  const lines: string[] = [];
  const shows: Array<boolean | undefined> = [];
  return {
    lines,
    shows,
    appendLine(value: string): void {
      lines.push(value);
    },
    show(preserveFocus?: boolean): void {
      shows.push(preserveFocus);
    },
    dispose(): void {},
  };
}

describe('createLogger', () => {
  it('emits everything at the verbose level', () => {
    const channel = fakeChannel();
    const logger = createLogger(channel, 'verbose');

    logger.error('e');
    logger.info('i');
    logger.debug('d');

    expect(channel.lines).toEqual(['[error] e', '[info] i', '[debug] d']);
  });

  it('drops debug at the normal level but keeps error and info', () => {
    const channel = fakeChannel();
    const logger = createLogger(channel, 'normal');

    logger.error('e');
    logger.info('i');
    logger.debug('d');

    expect(channel.lines).toEqual(['[error] e', '[info] i']);
  });

  it('emits error alone at the error level', () => {
    const channel = fakeChannel();
    const logger = createLogger(channel, 'error');

    logger.error('e');
    logger.info('i');
    logger.debug('d');

    expect(channel.lines).toEqual(['[error] e']);
  });

  it('captures the level at construction and never re-reads it', () => {
    // §6.3: settings are read once at activation, so a logger keeps the level
    // it was built with even if the source object changes afterwards.
    const config = { logLevel: 'error' } as { logLevel: 'error' | 'normal' | 'verbose' };
    const channel = fakeChannel();
    const logger = createLogger(channel, config.logLevel);

    config.logLevel = 'verbose';

    logger.debug('d');
    expect(channel.lines).toEqual([]);

    logger.error('e');
    expect(channel.lines).toEqual(['[error] e']);
  });

  it('delegates show() to the channel, preserving the argument', () => {
    const channel = fakeChannel();
    const logger = createLogger(channel, 'normal');

    logger.show();
    logger.show(true);
    logger.show(false);

    expect(channel.shows).toEqual([undefined, true, false]);
  });
});
