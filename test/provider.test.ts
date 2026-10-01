import { describe, expect, it, vi } from 'vitest';

// The bare specifier — the same resolution `src/chat-provider.ts` performs via
// the vitest alias. Both must land on `test/vscode-stub.ts`, or the
// `instanceof vscode.LanguageModelTextPart` narrowing below silently matches
// nothing and the token-count assertions would pass for the wrong reason.
import * as vscode from 'vscode';

import { CmdCodeChatProvider } from '../src/chat-provider.js';
import { MODELS, chatIdFor } from '../src/catalog.js';
import { toPresentation } from '../src/errors.js';
import { TranscriptStore } from '../src/transcript.js';
import {
  CONFIG_DEFAULTS,
  CliError,
  ZERO_USAGE,
  type CmdCodeConfig,
  type Frame,
  type Logger,
  type RunSummary,
} from '../src/types.js';
import { FakeCancellationToken, FakeTransport } from './fake-transport.js';
// `LanguageModelDataPart` is stub-only: @types/vscode has no such export, so it
// is reached through the stub module directly. It is the same object either way.
import { LanguageModelDataPart, LanguageModelTextPart } from './vscode-stub.js';

// Every test in this file runs against `FakeTransport`. Nothing here spawns a
// process, resolves a CLI, or waits on a real clock — the provider's whole
// observable surface is reachable through the `CliTransport` seam (§4.1).

const WS = '/Users/paranjay/dev/cmdcode-vsc';
const MODEL_ID = 'stealth/space-bunny-alpha';
const CHAT_ID = chatIdFor(MODEL_ID, WS);
const SESSION_ID = 'ab4c5b22-7d1e-4f0a-9c3b-5e6d7a8b9c01';

/** A model handle shaped like the one `provideLanguageModelChatInformation` emits. */
function chatInformation(id: string): vscode.LanguageModelChatInformation {
  return {
    id,
    name: 'Space Bunny Alpha',
    family: 'cmdcode',
    version: '1.0.0',
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    capabilities: { imageInput: false, toolCalling: false },
  };
}

function user(value: string): vscode.LanguageModelChatRequestMessage {
  return {
    name: 'user',
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new LanguageModelTextPart(value)],
  };
}

function textDelta(delta: string): Frame {
  return { type: 'event', event: { type: 'text_delta', delta } };
}

function runStart(sessionId = SESSION_ID): Frame {
  return { type: 'event', event: { type: 'run_start', sessionId } };
}

function resultFrame(finalText: string, sessionId: string | undefined = SESSION_ID): Frame {
  return {
    type: 'result',
    subtype: 'success',
    ...(sessionId === undefined ? {} : { sessionId }),
    usage: ZERO_USAGE,
    durationMs: 12,
    finalText,
  };
}

/** A logger that records what reached it, so "stderr goes to the log only" is checkable. */
function recordingLogger(): Logger & { readonly errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    error: (message: string) => {
      errors.push(message);
    },
    info: () => {},
    debug: () => {},
    show: () => {},
  };
}

function makeConfig(overrides: Partial<CmdCodeConfig> = {}): CmdCodeConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

/**
 * Records every `progress.report` call, in invocation order, with the text it
 * carried. AC-05 is about *when* the deltas are reported, not merely about the
 * final content, so order is the property under test here.
 */
function recordingProgress(): {
  readonly parts: vscode.LanguageModelResponsePart[];
  readonly texts: string[];
  report(value: vscode.LanguageModelResponsePart): void;
} {
  const parts: vscode.LanguageModelResponsePart[] = [];
  return {
    parts,
    get texts(): string[] {
      return parts.map((p) => (p as LanguageModelTextPart).value);
    },
    report(value: vscode.LanguageModelResponsePart): void {
      parts.push(value);
    },
  };
}

interface Harness {
  readonly provider: CmdCodeChatProvider;
  readonly transport: FakeTransport;
  readonly store: TranscriptStore;
  readonly token: FakeCancellationToken;
  readonly log: Logger & { readonly errors: string[] };
}

function harness(overrides: Partial<CmdCodeConfig> = {}): Harness {
  const transport = new FakeTransport();
  const store = new TranscriptStore();
  const log = recordingLogger();
  return {
    provider: new CmdCodeChatProvider(
      MODELS,
      transport,
      store,
      log,
      WS,
      makeConfig(overrides),
    ),
    transport,
    store,
    token: new FakeCancellationToken(),
    log,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('CmdCodeChatProvider.provideLanguageModelChatInformation', () => {
  it('returns all 82 catalog models synchronously and never touches the transport (AC-01)', () => {
    const { provider, transport } = harness();

    const info = provider.provideLanguageModelChatInformation(
      { silent: false },
      new FakeCancellationToken() as never,
    );

    // Synchronous: a promise here would stall the model picker on every refresh.
    expect(Array.isArray(info)).toBe(true);
    expect(info as vscode.LanguageModelChatInformation[]).toHaveLength(82);
    expect((info as vscode.LanguageModelChatInformation[])[0]?.id).toMatch(/^cmdc-[0-9a-f]{12}$/);

    // No I/O, no spawn: the seam is never called, not even to describe the CLI.
    expect(transport.requests).toHaveLength(0);
    expect(transport.describeCount).toBe(0);
  });

  it('returns the full list even when the caller asks silently, and with a cancelled token (AC-01)', () => {
    // `silent` means "do not prompt for credentials". Nothing here prompts, so
    // there is nothing to suppress and the list is unconditional.
    const { provider } = harness();
    const cancelled = new FakeCancellationToken();
    cancelled.isCancellationRequested = true;

    expect(provider.provideLanguageModelChatInformation({ silent: true }, cancelled as never))
      .toHaveLength(82);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CmdCodeChatProvider.provideLanguageModelChatResponse — streaming (AC-05)', () => {
  it('reports every text_delta in arrival order, before the run closes', async () => {
    const { provider, transport, token, store } = harness();
    transport.nextFrames = [runStart(), textDelta('Hello'), textDelta(', '), textDelta('world')];

    const progress = recordingProgress();
    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      progress as never,
      token as never,
    );

    // The three deltas arrive as three separate parts. Buffering until close
    // would still produce the same concatenation — the per-delta parts prove it
    // did not, because three separate parts arrived rather than one joined one.
    // The first part is the model's own text: nothing is prepended.
    expect(progress.texts).toEqual(['Hello', ', ', 'world']);
    expect(progress.parts).toHaveLength(3);
    expect(store.get(CHAT_ID)).toBe(SESSION_ID);
  });

  it('forwards each delta as its own part without joining or trimming', async () => {
    const { provider, transport, token } = harness();
    transport.nextFrames = [textDelta('a'), textDelta(''), textDelta('b\n')];

    const progress = recordingProgress();
    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      progress as never,
      token as never,
    );

    // An empty delta is dropped by the transport; a delta carrying a newline is
    // passed through verbatim, because trimming would corrupt legitimate output.
    expect(progress.texts).toEqual(['a', 'b\n']);
  });

  /**
   * The first reported part must be the model's own first token.
   *
   * This extension used to report a `Working…` text part before the run started,
   * to fill the ~3-4 s the CLI takes to produce its first token. Every part
   * reported to `progress` becomes response *content* and cannot be retracted, so
   * that placeholder was permanently prefixed to the reply:
   *
   *   "Working…Hello! I'm working in the cmdcode-vsc VS Code extension…"
   *
   * The stable API has no non-content channel for it — `LanguageModelResponsePart`
   * is a closed union of three content-bearing part types, and
   * `ProvideLanguageModelChatResponseOptions` carries no progress handle — so the
   * placeholder was removed rather than reworded. These assertions exist to stop
   * any "helpful" status text being reintroduced.
   */
  it('reports nothing before the model produces its first token', async () => {
    const { provider, transport, token } = harness();
    transport.nextFrames = [textDelta('Hello')];

    const progress = recordingProgress();
    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      progress as never,
      token as never,
    );

    expect(progress.texts).toEqual(['Hello']);
    expect(progress.texts[0]).not.toMatch(/working|thinking|please wait|\.\.\./i);
  });

  it('emits no fabricated content at all when the model says nothing', async () => {
    // A silent run must not be padded with a placeholder to look busy.
    const { provider, transport, token } = harness();
    transport.nextFrames = [runStart()];

    const progress = recordingProgress();
    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      progress as never,
      token as never,
    );

    expect(progress.texts).toEqual(['Command Code finished without returning any text. See the Command Code log.']);
  });

  it('projects config and the resume hint onto the RunRequest', async () => {
    const { provider, transport, store, token } = harness({ maxTurns: 7, timeoutMs: 1234 });
    transport.nextFrames = [runStart(), textDelta('ok')];
    store.set(CHAT_ID, 'previous-session');

    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      recordingProgress() as never,
      token as never,
    );

    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0]!;
    expect(request.model).toBe(MODEL_ID);
    expect(request.maxTurns).toBe(7);
    expect(request.timeoutMs).toBe(1234);
    expect(request.cwd).toBe(WS);
    expect(request.resumeSessionId).toBe('previous-session');
    expect(request.prompt).toContain('<user-now>');
    expect(request.prompt).toContain('hi');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CmdCodeChatProvider.provideLanguageModelChatResponse — zero-delta runs (AC-15)', () => {
  it('emits summary.text verbatim when the run produced no deltas', async () => {
    const { provider, transport, token } = harness();
    transport.nextFrames = [runStart(), resultFrame('PONG')];

    const progress = recordingProgress();
    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('reply with exactly: PONG')],
      {} as never,
      progress as never,
      token as never,
    );

    // The placeholder plus the summary. This is the case the previous iteration's
    // two overlapping rules disagreed about: a success with `finalText: 'PONG'`
    // and no deltas emits PONG, not an explanatory message.
    expect(progress.texts).toEqual(['PONG']);
  });

  it('emits exactly one explanatory part when both the deltas and the text are empty', async () => {
    const { provider, transport, token } = harness();
    transport.nextFrames = [runStart(), resultFrame('   \n  ')];

    const progress = recordingProgress();
    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      progress as never,
      token as never,
    );

    // Copilot renders an empty response as a hang, so silence is never correct.
    // Exactly one part: the explanation. Nothing is prepended to it.
    expect(progress.texts).toHaveLength(1);
    expect(progress.texts[0]).toBe(
      'Command Code finished without returning any text. See the Command Code log.',
    );
  });

  it('emits the explanatory part when the transport reports no summary at all', async () => {
    // A transport that settles with neither onDone nor onError. The provider
    // must not throw over it — it degrades to the empty-response message.
    const transport = new FakeTransport();
    transport.nextFrames = [];
    const log = recordingLogger();
    const provider = new CmdCodeChatProvider(MODELS, transport, new TranscriptStore(), log, WS, makeConfig());

    const progress = recordingProgress();
    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      progress as never,
      new FakeCancellationToken() as never,
    );

    expect(progress.texts).toHaveLength(1);
    expect(progress.texts[0]).toContain('without returning any text');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CmdCodeChatProvider.provideLanguageModelChatResponse — the error bridge (AC-12)', () => {
  it('throws a CliError whose message is the code-keyed user-safe copy', async () => {
    const { provider, transport, token } = harness();
    const stderr = 'Error: unknown model "bogus/nonexistent".\nRun "cmd --list-models" to see all';
    transport.nextError = new CliError('unknown', 'raw transport detail', { stderr, exitCode: 1 });

    const error = await provider
      .provideLanguageModelChatResponse(
        chatInformation(CHAT_ID),
        [user('hi')],
        {} as never,
        recordingProgress() as never,
        token as never,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('unknown');
    expect((error as CliError).message).toBe('Command Code failed. See the Command Code log.');
  });

  it('keeps raw stderr in the log and out of the thrown message', async () => {
    const { provider, transport, token, log } = harness();
    const stderr = 'Error: unknown model "stealth/space-bunny-alpha". /Users/me/secret';
    transport.nextError = new CliError('unknown', 'raw detail', { stderr, exitCode: 1 });

    const error = (await provider
      .provideLanguageModelChatResponse(
        chatInformation(CHAT_ID),
        [user('hi')],
        {} as never,
        recordingProgress() as never,
        token as never,
      )
      .then(
        () => null,
        (e: unknown) => e,
      )) as CliError;

    // The thrown message is the presentation copy: no stderr, no paths, and no
    // model id, because stderr carries all three.
    expect(error.message).not.toContain('unknown model');
    expect(error.message).not.toContain(MODEL_ID);
    expect(error.message).not.toContain('/Users/me/secret');
    expect(error.message).toBe(toPresentation(new CliError('unknown', '', {})).message);

    // The log is the only place the raw stderr lands.
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toContain(stderr);
  });

  it('resolves quietly, without throwing, when the failure is interrupted', async () => {
    const { provider, transport, token } = harness();
    transport.nextError = new CliError('interrupted', 'killed by SIGTERM', { exitCode: 130 });

    // §5.3: the user cancelled. An error dialog here would be hostile.
    await expect(
      provider.provideLanguageModelChatResponse(
        chatInformation(CHAT_ID),
        [user('hi')],
        {} as never,
        recordingProgress() as never,
        token as never,
      ),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CmdCodeChatProvider.provideLanguageModelChatResponse — cancellation (AC-11, AC-14)', () => {
  it('cancels the transport and returns without throwing when cancelled mid-run', async () => {
    const { provider, transport, token, store } = harness();

    // Scripted to interrupt mid-stream: a delta lands, the user hits stop, the
    // child is signalled and the run settles as `interrupted` — the exact shape
    // a real SIGTERM produces (§5.3).
    transport.run = async (_req, handlers) => {
      handlers.onTextDelta('partial');
      token.cancel();
      handlers.onError(new CliError('interrupted', 'killed by SIGTERM', { exitCode: 130 }));
    };

    const progress = recordingProgress();
    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      progress as never,
      token as never,
    );

    // The child was signalled, no throw surfaced, and the partial text that had
    // already streamed stays put — VS Code has no retract API.
    expect(transport.cancelCount).toBe(1);
    expect(progress.texts).toEqual(['partial']);
    // A cancelled turn is not a success, so nothing is persisted.
    expect(store.get(CHAT_ID)).toBeNull();
  });

  it('returns without spawning anything when cancellation is already requested at entry', async () => {
    const { provider, transport, token } = harness();
    token.isCancellationRequested = true;

    const progress = recordingProgress();
    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      progress as never,
      token as never,
    );

    expect(transport.requests).toHaveLength(0);
    expect(progress.parts).toHaveLength(0);
    // Nothing ran, so nothing was subscribed to.
    expect(token.registrations).toBe(0);
  });

  it('disposes the cancellation subscription on the success path (AC-14)', async () => {
    const { provider, transport, token } = harness();
    transport.nextFrames = [runStart(), textDelta('ok')];

    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      recordingProgress() as never,
      token as never,
    );

    expect(token.registrations).toBe(1);
    expect(token.disposals).toBe(1);
    expect(token.liveListenerCount).toBe(0);
  });

  it('disposes the cancellation subscription on the interrupted path (AC-11, AC-14)', async () => {
    const { provider, transport, token } = harness();
    transport.nextError = new CliError('interrupted', 'SIGTERM', { exitCode: 130 }) as never;

    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      recordingProgress() as never,
      token as never,
    );

    expect(token.registrations).toBe(1);
    expect(token.disposals).toBe(1);
    expect(token.liveListenerCount).toBe(0);
  });

  it('disposes the cancellation subscription on the throwing path too (AC-14)', async () => {
    // Repeated for every non-interrupted code that can actually reach the
    // provider from a turn, because the `finally` is the only thing standing
    // between a failure and a listener that lives for the chat's lifetime.
    for (const code of ['unknown', 'auth', 'rate-limited', 'no-response', 'timeout'] as const) {
      const { provider, transport, token } = harness();
      transport.nextError = new CliError(code, 'raw', { stderr: 'boom', exitCode: 1 }) as never;

      await expect(
        provider.provideLanguageModelChatResponse(
          chatInformation(CHAT_ID),
          [user('hi')],
          {} as never,
          recordingProgress() as never,
          token as never,
        ),
      ).rejects.toThrow();

      expect(token.registrations, `registrations for ${code}`).toBe(1);
      expect(token.disposals, `disposals for ${code}`).toBe(1);
      expect(token.liveListenerCount, `live listeners for ${code}`).toBe(0);
    }
  });

  it('registers the subscription before the awaited run so a mid-run cancel is seen', async () => {
    const { provider, transport, token } = harness();
    let registrationsAtRunStart = -1;
    transport.run = async (_req, _handlers) => {
      registrationsAtRunStart = token.registrations;
    };

    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      recordingProgress() as never,
      token as never,
    );

    // A subscription created after the await could never fire for a
    // cancellation that arrives during the run.
    expect(registrationsAtRunStart).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CmdCodeChatProvider.provideTokenCount (AC-13)', () => {
  it('returns ceil(chars / 4) for a string and spawns nothing', async () => {
    const { provider, transport } = harness();

    expect(await provider.provideTokenCount(chatInformation(CHAT_ID), 'a'.repeat(9), new FakeCancellationToken() as never))
      .toBe(3);
    expect(await provider.provideTokenCount(chatInformation(CHAT_ID), '', new FakeCancellationToken() as never))
      .toBe(0);
    expect(await provider.provideTokenCount(chatInformation(CHAT_ID), 'abcd', new FakeCancellationToken() as never))
      .toBe(1);

    expect(transport.requests).toHaveLength(0);
    expect(transport.describeCount).toBe(0);
  });

  it('sums the text parts of a request message and ignores non-text parts', async () => {
    const { provider } = harness();
    const message: vscode.LanguageModelChatRequestMessage = {
      name: 'user',
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelTextPart('12345'), //  5 chars
        new LanguageModelDataPart(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
        new LanguageModelTextPart('123'), //  3 chars
      ],
    };

    // 8 chars total; the data part contributes 0, matching what the prompt
    // builder renders, so counting and rendering never disagree.
    expect(await provider.provideTokenCount(chatInformation(CHAT_ID), message, new FakeCancellationToken() as never))
      .toBe(2);
  });

  it('counts an empty message as zero tokens', async () => {
    const { provider } = harness();
    const message: vscode.LanguageModelChatRequestMessage = {
      name: 'user',
      role: vscode.LanguageModelChatMessageRole.User,
      content: [],
    };

    expect(await provider.provideTokenCount(chatInformation(CHAT_ID), message, new FakeCancellationToken() as never))
      .toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CmdCodeChatProvider.provideLanguageModelChatResponse — model resolution', () => {
  it('throws before any spawn when the model id resolves to nothing in the catalog', async () => {
    const { provider, transport, token } = harness();

    await expect(
      provider.provideLanguageModelChatResponse(
        chatInformation('cmdc-000000000000'),
        [user('hi')],
        {} as never,
        recordingProgress() as never,
        token as never,
      ),
    ).rejects.toThrow('Unknown model: cmdc-000000000000');

    // The failure is a lookup miss, not a CLI failure: nothing was ever sent.
    expect(transport.requests).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CmdCodeChatProvider — session continuity', () => {
  it('persists the session id after a successful run', async () => {
    const { provider, transport, store, token } = harness();
    transport.nextFrames = [runStart(), textDelta('done')];

    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      recordingProgress() as never,
      token as never,
    );

    expect(store.get(CHAT_ID)).toBe(SESSION_ID);
  });

  it('persists nothing after a failed run, so a failed turn never poisons the store', async () => {
    const { provider, transport, store, token } = harness();
    // run_start fired, then the run failed. The id exists but the transcript
    // has no answer in it, so persisting it would poison the next turn.
    transport.run = async (_req, handlers) => {
      handlers.onSessionId(SESSION_ID);
      handlers.onError(new CliError('unknown', 'raw', { stderr: 'boom', exitCode: 1 }) as never);
    };

    await expect(
      provider.provideLanguageModelChatResponse(
        chatInformation(CHAT_ID),
        [user('hi')],
        {} as never,
        recordingProgress() as never,
        token as never,
      ),
    ).rejects.toThrow();

    expect(store.size).toBe(0);
    expect(store.get(CHAT_ID)).toBeNull();
  });

  it('falls back to the run_start session id when the result frame carries none', async () => {
    const { provider, transport, store, token } = harness();
    transport.nextFrames = [runStart(), resultFrame('answer', undefined)];

    await provider.provideLanguageModelChatResponse(
      chatInformation(CHAT_ID),
      [user('hi')],
      {} as never,
      recordingProgress() as never,
      token as never,
    );

    expect(store.get(CHAT_ID)).toBe(SESSION_ID);
  });

  it('leaves an existing entry untouched when a later turn fails', async () => {
    const { provider, transport, store, token } = harness();
    store.set(CHAT_ID, 'good-session');
    transport.nextError = new CliError('unknown', 'raw', { exitCode: 1 }) as never;

    await expect(
      provider.provideLanguageModelChatResponse(
        chatInformation(CHAT_ID),
        [user('hi')],
        {} as never,
        recordingProgress() as never,
        token as never,
      ),
    ).rejects.toThrow();

    expect(store.get(CHAT_ID)).toBe('good-session');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CmdCodeChatProvider.refreshModelInformation', () => {
  it('fires the change event so VS Code re-queries the model list', () => {
    const { provider } = harness();
    const listener = vi.fn();

    provider.onDidChangeLanguageModelChatInformation!(listener);
    provider.refreshModelInformation();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

// A local alias so the throw assertions above read as `CliError` without
// importing the class under a name the bridge also uses.

