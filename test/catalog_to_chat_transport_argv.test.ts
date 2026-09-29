import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toChatInformation, type TransportCapabilities } from '../src/catalog-to-chat.js';

/** CLI-transport capabilities: no host tool loop, images available. */
const CAPS: TransportCapabilities = Object.freeze({
  toolCalling: false,
  imagesAvailable: true,
});
import {
  DEFAULT_CONTEXT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MODELS,
  findModelByChatId,
  modelsForPlan,
} from '../src/catalog.js';
import { buildArgs, CliTransportImpl, type ChildLike, type SpawnFn } from '../src/cli/process.js';
import { buildPrompt } from '../src/prompt.js';
import { TranscriptStore } from '../src/transcript.js';
import { createLogger, type Logger, type RunRequest, type RunSummary } from '../src/types.js';

import { LanguageModelTextPart } from './vscode-stub.js';

// The advertised-model -> argv chain, across the catalog-to-chat merge
// (issue 08) and the cli-transport merge (issue 09):
//
//   toChatInformation        (branch 08: the id VS Code will hold)
//     -> findModelByChatId   (the inversion)
//     -> RunRequest.model
//     -> buildArgs           (branch 09: the -m element the child receives)
//
// Branch 08's suite asserts the projection against a HARDCODED workspace path
// and stops there. Branch 09's suites assert the argv against a HARDCODED
// model id ('stealth/space-bunny-alpha') and stop there. Neither proves the
// two agree for the SAME model, which is the entire point of the
// workspace-salted id: if the projection mints an id the inversion cannot
// recover, or the inversion recovers a different spelling than the one minted,
// Copilot offers a model whose `cmd -m` argument the CLI rejects.

// ─────────────────────────────────────────────────────────────────────────────
// A spawn seam that records argv without starting a process. The catalog chain
// needs only the argv, and a real child here would be pure latency.

class FakePipe extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): void {}
  feed(_text: string): void {}
}

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new FakePipe();
  readonly stderr = new FakePipe();
  kill(_signal?: NodeJS.Signals | number): boolean {
    return true;
  }
}

const RESOLVED = { command: 'cmd', args: [], source: 'path' as const };

const silentLog: Logger = createLogger(
  { appendLine: () => undefined, show: () => undefined, dispose: () => undefined },
  'error',
);

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** `-m` is the flag `buildArgs` emits; nothing may be inserted between it and its value. */
function modelArgOf(args: readonly string[]): string | undefined {
  const index = args.indexOf('-m');
  return index < 0 ? undefined : args[index + 1];
}

const ignoreHandlers = {
  onTextDelta: (): void => undefined,
  onSessionId: (): void => undefined,
  onError: (): void => undefined,
  onDone: (_summary: RunSummary): void => undefined,
};

function request(model: string, cwd: string): RunRequest {
  return {
    prompt: 'hi',
    model,
    maxTurns: 2,
    resumeSessionId: null,
    cwd,
    timeoutMs: 0,
    readImages: false,
  };
}

interface Captured {
  readonly args: readonly string[];
  readonly shell: boolean;
  readonly env: NodeJS.ProcessEnv;
}

interface Rig {
  readonly transport: CliTransportImpl;
  readonly spawns: Captured[];
  /** Drive one run to a clean close, returning the argv it was spawned with. */
  run(model: string, cwd: string): Promise<Captured>;
}

function rig(): Rig {
  const spawns: Captured[] = [];
  const children: FakeChild[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    children.push(child);
    spawns.push({
      args: [...args],
      shell: options.shell,
      env: options.env,
    });
    // Close on the next tick so `run` always settles: it resolves on the
    // child's `close`, never on a result frame.
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const transport = new CliTransportImpl(async () => RESOLVED, silentLog, spawnFn);
  return {
    transport,
    spawns,
    run: async (model, cwd) => {
      await transport.run(request(model, cwd), ignoreHandlers);
      return spawns[spawns.length - 1]!;
    },
  };
}

const WS_A = '/Users/paranjay/dev/cmdcode-vsc';
const WS_B = '/private/tmp/other workspace';

describe('advertised model -> inverted catalog id -> spawned argv', () => {
  it('passes the catalog id the advertised chat id inverts to, unchanged', async () => {
    const r = rig();
    const chatId = toChatInformation([MODELS[0]!], WS_A, CAPS, 'cmdcode')[0]!.id;
    const resolved = findModelByChatId(chatId, WS_A);

    expect(resolved, `advertised id ${chatId} did not invert`).toBeDefined();

    const captured = await r.run(resolved!.id, WS_A);
    expect(modelArgOf(captured.args), 'the spawned -m argument drifted from the catalog id').toBe(
      resolved!.id,
    );
    expect(modelArgOf(captured.args)).toBe(MODELS[0]!.id);
  });

  it('spawns the exact id for all 82 advertised models, with no normalisation at any hop', async () => {
    // A hop that lowercased, trimmed or re-prefixed would send `cmd -m` an id
    // the CLI does not accept. The catalog's own mixed-case and unprefixed ids
    // are exactly the trap, so all of them are driven.
    const r = rig();
    const advertised = toChatInformation(MODELS, WS_A, CAPS, 'cmdcode');
    expect(advertised).toHaveLength(82);

    for (const info of advertised) {
      const model = findModelByChatId(info.id, WS_A);
      expect(model, `advertised id ${info.id} did not invert in its own workspace`).toBeDefined();

      const captured = await r.run(model!.id, WS_A);
      expect(
        modelArgOf(captured.args),
        `argv for ${model!.id} did not carry the exact catalog id`,
      ).toBe(model!.id);
    }

    expect(r.spawns).toHaveLength(MODELS.length);
  });

  it('keeps a chat id minted in one workspace from selecting a model in another', () => {
    // Two windows on two folders. If the inversion ignored the workspace salt,
    // a selection made in window B would silently run against window A's id.
    const fromA = toChatInformation([MODELS[0]!], WS_A, CAPS, 'cmdcode')[0]!.id;

    expect(findModelByChatId(fromA, WS_A)).toBeDefined();
    expect(findModelByChatId(fromA, WS_B), 'a chat id must not cross workspaces').toBeUndefined();

    // The two workspaces also publish disjoint id sets, so picker ids cannot
    // collide even for the same catalog entry.
    const idsA = new Set(toChatInformation(MODELS, WS_A, CAPS, 'cmdcode').map((i) => i.id));
    for (const info of toChatInformation(MODELS, WS_B, CAPS, 'cmdcode')) {
      expect(idsA.has(info.id), `${info.id} leaked across workspaces`).toBe(false);
    }
  });
});

describe('the advertised id is the id the prompt names', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cmdcode-argv-'));
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('inverts to a model whose exact id appears in both the prompt and the argv', async () => {
    // Three consumers of the model id, one string: the id VS Code hands back,
    // the id rendered into <cmdcode-request model="...">, and the id after -m.
    // A spelling drift in any one of them either breaks resume or sends the
    // CLI an id it rejects.
    const store = new TranscriptStore();
    const r = rig();

    for (const info of toChatInformation(MODELS, WS_A, CAPS, 'cmdcode')) {
      const model = findModelByChatId(info.id, WS_A);
      expect(model, `advertised id ${info.id} did not invert`).toBeDefined();

      const build = await buildPrompt(
        [{ name: 'user', role: 1, content: [new LanguageModelTextPart('hi')] }],
        { model: model!.id, cwd, maxChars: 900_000 },
      );
      const named = /<cmdcode-request model="([^"]*)">/.exec(build.text)?.[1];
      expect(named, `prompt for ${model!.id} did not name its model`).toBe(model!.id);

      const captured = await r.run(model!.id, cwd);
      expect(modelArgOf(captured.args), `argv for ${model!.id} disagreed with the prompt`).toBe(
        model!.id,
      );

      // …and the session cache is keyed by that same id, so resume can hit.
      store.set(named!, 'session-for-this-model');
      expect(store.get(model!.id)).toBe('session-for-this-model');
    }
  });
});

describe('the advertised token budget survives the projection', () => {
  it('advertises an input budget above the output cap for every model', () => {
    // The em-dash entries are the interesting ones: transcribed as 0 in the
    // catalog and published with DEFAULT_CONTEXT_TOKENS. A missing or too-small
    // fallback would offer a model whose window cannot hold its own output.
    const info = toChatInformation(MODELS, WS_A, CAPS, 'cmdcode');
    expect(info).toHaveLength(82);

    for (const [index, entry] of info.entries()) {
      const model = MODELS[index]!;
      expect(entry.maxInputTokens, `${model.id} advertises no input budget`).toBeGreaterThan(0);
      expect(
        entry.maxInputTokens,
        `${model.id} advertises an input budget at or below its output cap`,
      ).toBeGreaterThan(entry.maxOutputTokens);
      expect(
        entry.maxInputTokens,
        `${model.id} over-advertises beyond the catalog or the documented default`,
      ).toBeLessThanOrEqual(Math.max(model.contextWindow, DEFAULT_CONTEXT_TOKENS));
    }

    expect(DEFAULT_CONTEXT_TOKENS).toBe(200_000);
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
  });

  it('publishes a plan slice whose ids all invert, so a tiered picker is selectable', () => {
    // modelsForPlan is what a tier-aware picker would slice with. Every entry
    // it returns must be invertible, or selecting from a filtered list fails.
    for (const tier of ['go', 'goat', 'pro', 'max'] as const) {
      const slice = modelsForPlan(tier);
      expect(slice.length, `plan ${tier} reached no models`).toBeGreaterThan(0);

      for (const entry of toChatInformation(slice, WS_A, CAPS, 'cmdcode')) {
        expect(
          findModelByChatId(entry.id, WS_A),
          `plan ${tier} advertised an id that does not invert`,
        ).toBeDefined();
      }
    }
  });

  it('advertises the CLI transport capabilities: no tools, per-model vision', () => {
    // `toolCalling` is asserted against the projection, not a constant, because
    // it is the flag Copilot's Agent-mode filter reads. False on the CLI path is
    // deliberate and honest: the CLI runs tools in-process and never yields for
    // a host, so true would light a chip that cannot fire. `imageInput` follows
    // the vendor's per-model capability, so the set is mixed by design.
    const entries = toChatInformation(MODELS, WS_A, CAPS, 'cmdcode');
    for (const entry of entries) {
      expect(entry.capabilities.toolCalling, `${entry.id} toolCalling`).toBe(false);
    }
    expect(entries.some((e) => e.capabilities.imageInput)).toBe(true);
    expect(entries.some((e) => !e.capabilities.imageInput)).toBe(true);
  });
});

describe('argv integrity for a promoted model', () => {
  it('passes a prompt full of argv metacharacters as one untouched element', () => {
    // The prompt is the value after -p. A layer that joined argv into a string
    // would let any of these characters terminate the element.
    const hostile = 'a b "c" $HOME `id` ; rm -rf / | tee /tmp/x\nnewline';
    const args = buildArgs(request('stealth/space-bunny-alpha', WS_A).prompt === 'hi'
      ? { ...request('stealth/space-bunny-alpha', WS_A), prompt: hostile }
      : request('stealth/space-bunny-alpha', WS_A));

    const index = args.indexOf('-p');
    expect(index, 'the prompt was not passed with -p').toBeGreaterThanOrEqual(0);
    expect(args[index + 1], 'the prompt was split across argv elements').toBe(hostile);
    expect(args, 'a shell metacharacter escaped into a separate element').toHaveLength(9);
  });

  it('keeps the resume flag first, ahead of the prompt, when a session is cached', () => {
    // Order is load-bearing (AC-06): -r is a leading option, and a resume id
    // spliced after -p would be read as part of the prompt.
    const args = buildArgs({ ...request(MODELS[0]!.id, WS_A), resumeSessionId: 'session-1' });

    expect(args[0]).toBe('-r');
    expect(args[1]).toBe('session-1');
    expect(args.indexOf('-p')).toBeGreaterThan(1);
    // The excluded flags stay absent whatever the request shape.
    for (const forbidden of ['--yolo', '--plan', '--effort', '--permission-mode']) {
      expect(args, `${forbidden} must never be passed`).not.toContain(forbidden);
    }
  });

  it('spawns every run without a shell, with CI forced on', async () => {
    const r = rig();
    const captured = await r.run(MODELS[0]!.id, WS_A);

    // ADR-01: the vendor's auto-installer returns immediately under CI, so a
    // turn must never be able to cause an install.
    expect(captured.shell, 'a run must never be interpreted by a shell').toBe(false);
    expect(captured.env.CI).toBe('1');
    expect(captured.env.NO_COLOR).toBe('1');
    expect(captured.env.FORCE_COLOR).toBe('0');
  });
});
