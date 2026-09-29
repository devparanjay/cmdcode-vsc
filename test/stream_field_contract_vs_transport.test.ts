import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { NdjsonReader } from '../src/cli/ndjson.js';
import { toChatInformation } from '../src/catalog-to-chat.js';
import { findModelByChatId, MODELS } from '../src/catalog.js';
import { type ChildLike, type SpawnFn, type SpawnOptions } from '../src/cli/process.js';
import { CliTransportImpl } from '../src/cli/process.js';
import { toPresentation } from '../src/errors.js';
import { buildPrompt } from '../src/prompt.js';
import { TranscriptStore } from '../src/transcript.js';
import { createLogger, ExitCode, type CliError, type RunHandlers, type RunSummary } from '../src/types.js';

import { LanguageModelTextPart } from './vscode-stub.js';

// The stream field contract, and the pre-existing suites' agreement with it.
//
// Two untracked files in this tree drive a whole turn end to end and assert on
// the streamed text: test/pipeline_stream_session_errors.test.ts and
// test/cli_resolver_ndjson_turn.test.ts. Both synthesize their text_delta frames
// as {type:'text_delta', text: '…'}. The merged transport (src/cli/process.ts)
// reads `event.delta`, types.ts documents the callback parameter as a "delta",
// and architecture §4.1a line 624 records the captured wire frame verbatim as
//   {"type":"event","event":{"type":"text_delta","delta":"PONG"}}.
//
// So those two files emit a frame shape the CLI never produces, read a field
// that is never present, and every assertion on the streamed text passes
// vacuously: `undefined` pushed into a list that is then compared against
// ['PO','NG'] would FAIL, so the suites are green for a different reason --
// the `expect` inside the driver (`onError ran after the turn had already
// settled`) never fires and the delta list is simply never compared in the
// passing cases. This file pins the real field so the drift cannot survive
// silently, and proves the transport honours it.

const WS = '/Users/paranjay/dev/cmdcode-vsc';
const MODEL = 'stealth/space-bunny-alpha';

class FakePipe extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): void {}
  feed(text: string): void {
    this.emit('data', text);
  }
}

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new FakePipe();
  readonly stderr = new FakePipe();
  kill(_signal?: NodeJS.Signals | number): boolean {
    return true;
  }
}

const RESOLVED = { command: 'cmd', args: [], source: 'path' as const };

const silentLog = createLogger(
  { appendLine: () => undefined, show: () => undefined, dispose: () => undefined },
  'error',
);

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The captured successful stream of §4.1a, with the `delta` field as recorded. */
const SUCCESS_STREAM =
  `{"type":"event","event":{"type":"run_start","sessionId":"ab4c5b22-0000"}}\n` +
  `{"type":"event","event":{"type":"thinking_delta","delta":"hmm"}}\n` +
  `{"type":"event","event":{"type":"text_delta","delta":"PO"}}\n` +
  `{"type":"event","event":{"type":"text_delta","delta":"NG"}}\n` +
  `{"type":"result","subtype":"success","sessionId":"ab4c5b22-0000","stopReason":"end_turn",` +
  `"usage":{"inputTokens":18,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0},` +
  `"durationMs":1,"finalText":"PONG"}\n`;

interface Recorder extends RunHandlers {
  readonly deltas: string[];
  readonly sessionIds: string[];
  readonly errors: CliError[];
  readonly summaries: RunSummary[];
}

function recorder(): Recorder {
  const deltas: string[] = [];
  const sessionIds: string[] = [];
  const errors: CliError[] = [];
  const summaries: RunSummary[] = [];
  return {
    deltas,
    sessionIds,
    errors,
    summaries,
    onTextDelta: (d) => deltas.push(d),
    onSessionId: (id) => sessionIds.push(id),
    onError: (e) => errors.push(e),
    onDone: (s) => summaries.push(s),
  };
}

function harness(): {
  transport: CliTransportImpl;
  child: () => FakeChild;
} {
  let captured: FakeChild | null = null;
  const spawnFn: SpawnFn = (_command, _args, _options: SpawnOptions) => {
    const child = new FakeChild();
    captured = child;
    return child;
  };
  return {
    transport: new CliTransportImpl(async () => RESOLVED, silentLog, spawnFn),
    child: () => captured as unknown as FakeChild,
  };
}

type RunRequestShape = {
  prompt: string;
  model: string;
  maxTurns: number;
  resumeSessionId: string | null;
  cwd: string;
  timeoutMs: number;
};
function req(over: Partial<RunRequestShape> = {}): RunRequestShape {
  return {
    prompt: 'reply with exactly: PONG',
    model: MODEL,
    maxTurns: 2,
    resumeSessionId: null,
    cwd: WS,
    timeoutMs: 0,
    ...over,
  };
}

describe('the streamed text field is `delta`, the shape §4.1a captured', () => {
  it('delivers a real text_delta payload through onTextDelta', async () => {
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(req() as never, handlers);
    await flush();

    h.child().stdout.feed(SUCCESS_STREAM);
    h.child().emit('close', ExitCode.Success);
    await run;

    // If the transport read any field other than `delta`, this list is empty.
    expect(handlers.deltas, 'text_delta payloads were not delivered').toEqual(['PO', 'NG']);
    expect(handlers.deltas.join('')).toBe('PONG');
    // The thinking_delta before it is ignored, never surfaced as output.
    expect(handlers.deltas).not.toContain('hmm');
  });

  it('ignores a text_delta that carries `text` instead of `delta`, exactly as the CLI would', () => {
    // A frame with the wrong field name must not be read as output. The reader
    // still accepts the frame (forward compatibility); it is the transport that
    // drops it because `event.delta` is undefined. This is why the two
    // untracked suites, which emit `text`, see no deltas at all.
    const frames: unknown[] = [];
    const reader = new NdjsonReader((f) => frames.push(f));
    reader.push('{"type":"event","event":{"type":"text_delta","text":"PONG"}}\n');
    expect(frames).toHaveLength(1);
    const event = (frames[0] as { event: Record<string, unknown> }).event;
    expect(event['delta']).toBeUndefined();
    expect(event['text']).toBe('PONG');
  });

  it('splits a delta stream across pipe reads without losing or duplicating a fragment', async () => {
    // The pipe chunks arbitrarily; the reader buffers. A delta cut in half must
    // arrive as one fragment, because a torn fragment would corrupt the answer.
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(req() as never, handlers);
    await flush();

    const stream = SUCCESS_STREAM;
    const cut = stream.indexOf('"PO"') + 3; // lands inside the PONG delta's JSON
    h.child().stdout.feed(stream.slice(0, cut));
    h.child().stdout.feed(stream.slice(cut));
    h.child().emit('close', ExitCode.Success);
    await run;

    expect(handlers.deltas).toEqual(['PO', 'NG']);
    expect(handlers.summaries).toHaveLength(1);
    expect(handlers.summaries[0]!.text).toBe('PONG');
  });

  it('reports a result whose text never streamed, so the fallback path is reachable', async () => {
    // §4.1a: a run can succeed with a finalText and zero text_delta events (for
    // example when the answer arrives in one terminal frame). The transport must
    // still report it, so the provider's fallback is not dead code.
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(req() as never, handlers);
    await flush();

    h.child().stdout.feed(
      '{"type":"result","subtype":"success","sessionId":"s","usage":' +
        '{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0},' +
        '"durationMs":1,"finalText":"PONG"}\n',
    );
    h.child().emit('close', ExitCode.Success);
    await run;

    expect(handlers.deltas).toEqual([]);
    expect(handlers.summaries).toHaveLength(1);
    expect(handlers.summaries[0]!.text).toBe('PONG');
  });
});

describe('a stream error reaches the user as copy, not as stream content', () => {
  it('maps a malformed real stream to copy that names no model and no path', async () => {
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(req() as never, handlers);
    await flush();

    // Genuinely unparseable, not merely an unknown shape: a valid JSON object
    // with an unrecognised `type` is IGNORED by design (forward compatibility)
    // and would surface as no-response, not malformed-stream.
    h.child().stdout.feed('{"broken": "sk-live-SECRET"\n');
    h.child().emit('close', ExitCode.Success);
    await run;

    expect(handlers.errors).toHaveLength(1);
    expect(handlers.errors[0]!.code).toBe('malformed-stream');
    const presentation = toPresentation(handlers.errors[0]!);
    expect(presentation.message).toBe(
      "Command Code sent output this extension couldn't read. See the Command Code log.",
    );
    // Neither the model id nor the offending secret reaches the notification.
    expect(presentation.message).not.toContain(MODEL);
    expect(presentation.message).not.toContain('SECRET');
  });

  it('degrades a well-formed but unrecognised frame to no-response, not a stream error', async () => {
    // The deliberate counterpart to the case above. A syntactically valid frame
    // the reader does not recognise is IGNORED (forward compatibility), so the
    // turn ends as a missing answer rather than as a protocol violation. Both
    // outcomes are errors, but conflating them would misreport a vendor-side
    // shape change as unreadable output.
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(req() as never, handlers);
    await flush();

    h.child().stdout.feed('{"type":"who-knows","payload":{"note":"sk-live-SECRET"}}\n');
    h.child().emit('close', ExitCode.Success);
    await run;

    expect(handlers.errors).toHaveLength(1);
    expect(handlers.errors[0]!.code).toBe('no-response');
  });

  it('surfaces a plan-gated run with copy that does not name the model', async () => {
    const h = harness();
    const handlers = recorder();
    const run = h.transport.run(req() as never, handlers);
    await flush();

    h.child().stderr.feed(`Error: Model not in plan: ${MODEL}\n`);
    h.child().emit('close', ExitCode.Error);
    await run;

    expect(handlers.errors).toHaveLength(1);
    expect(handlers.errors[0]!.code).toBe('plan-gated');
    // The stderr keeps the detail for the output channel; the copy does not.
    expect(handlers.errors[0]!.stderr).toContain(MODEL);
    expect(toPresentation(handlers.errors[0]!).message).toBe(
      "Your Command Code plan doesn't include that model.",
    );
  });
});

describe('the advertised id, the prompt id and the session key stay one string', () => {
  it('uses the inverted id for all three across the whole catalog', async () => {
    // The full loop: what the picker advertises -> what the catalog inverts ->
    // what the prompt names -> what keys the session cache. This is the seam
    // that neither branch's own suite covers, because branch 08's suite never
    // builds a prompt and branch 09's never publishes an advertised id.
    const store = new TranscriptStore();
    for (const info of toChatInformation(MODELS, WS)) {
      const model = findModelByChatId(info.id, WS);
      expect(model, `advertised id ${info.id} did not invert`).toBeDefined();

      const build = await buildPrompt(
        [{ name: 'user', role: 1, content: [new LanguageModelTextPart('hi')] }],
        { model: model!.id, cwd: WS, maxChars: 900_000 },
      );
      const named = /<cmdcode-request model="([^"]*)">/.exec(build.text)?.[1];
      expect(named, `prompt for ${model!.id} named another model`).toBe(model!.id);

      store.set(named!, 'session-x');
      expect(store.get(model!.id)).toBe('session-x');
    }
  });
});
