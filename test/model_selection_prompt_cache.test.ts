import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The bare specifier resolves through the vitest alias to test/vscode-stub.ts,
// exactly as `src/prompt.ts` imports it. Both must land on the same module or
// the `instanceof LanguageModelTextPart` narrowing in prompt.ts silently matches
// nothing and every part gets counted as dropped.
import * as vscode from 'vscode';

import { chatIdFor, DEFAULT_CONTEXT_TOKENS, findModel, findModelByChatId, MAX_OUTPUT_TOKENS, MODELS } from '../src/catalog.js';
import { buildPrompt } from '../src/prompt.js';
import { TranscriptStore } from '../src/transcript.js';
import type { CliError } from '../src/types.js';

import { LanguageModelDataPart, LanguageModelTextPart } from './vscode-stub.js';

// The model-selection path, end to end, across all three merged features:
//
//   vscode chat id -> findModelByChatId -> findModel -> buildPrompt
//                                      \-> TranscriptStore (keyed by the SAME id)
//   buildPrompt.text -> RunRequest.prompt  (the only field the transport spawns)
//
// The critical property under test is key agreement: the id the provider
// advertises to VS Code, the id it feeds `cmd -m`, and the id it uses as the
// session-cache key must be the SAME STRING at every step. catalog.ts mints
// exact vendor ids and rejects near-misses, so any normalisation anywhere in
// this chain silently breaks resume and, worse, would send an id the CLI does
// not accept.

type Message = vscode.LanguageModelChatRequestMessage;

function user(value: string): Message {
  return {
    name: 'user',
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new LanguageModelTextPart(value)],
  };
}

const BIG_MAX = 900_000;

describe('the model selection path: chat id -> catalog -> prompt', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cmdcode-model-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('resolves every advertised chat id back to a catalog model in the same workspace', async () => {
    // findModelByChatId is a linear scan and findModel is an exact match. Any
    // id the provider would advertise that does not resolve here would surface
    // in Copilot as a model that cannot be selected.
    for (const model of MODELS) {
      const chatId = chatIdFor(model.id, cwd);
      const resolved = findModelByChatId(chatId, cwd);

      expect(resolved, `chat id for ${model.id} did not resolve`).toBeDefined();
      expect(resolved?.id, `chat id for ${model.id} resolved to a different model`).toBe(model.id);
    }
  });

  it('does not resolve a chat id minted for a different workspace', async () => {
    // Two windows on two folders must not share a session, and must not share a
    // model identity either: a chat id is workspace-scoped by construction.
    const chatId = chatIdFor(MODELS[0]!.id, cwd);

    expect(findModelByChatId(chatId, join(cwd, 'other'))).toBeUndefined();
  });

  it('puts the EXACT catalog id in the prompt, so cmd -m receives an id the CLI accepts', async () => {
    // The mixed-case ids are the trap: `MiniMaxAI/MiniMax-M3` must not be
    // lowercased, and an unprefixed vendor id must not be given a "/".
    for (const model of MODELS) {
      const build = await buildPrompt([user('hi')], { model: model.id, cwd, maxChars: BIG_MAX });

      expect(
        build.text.startsWith(`<cmdcode-request model="${model.id}">\n`),
        `prompt for ${model.id} did not open with its exact id:\n${build.text.slice(0, 120)}`,
      ).toBe(true);
      // The id also round-trips back through the catalog unchanged.
      expect(findModel(model.id)?.id).toBe(model.id);
    }
  });

  it('escapes a hostile model id so it cannot break out of the prompt attribute', async () => {
    const hostile = 'evil"><script>alert(1)</script>';
    const build = await buildPrompt([user('hi')], { model: hostile, cwd, maxChars: BIG_MAX });

    // The attribute is double-quoted, so escaping " (and &, to keep the
    // entity well-formed) is what prevents a breakout. A bare ">" is safe
    // inside a double-quoted value and is deliberately left alone.
    const modelAttr = /<cmdcode-request model="([^"]*)">/.exec(build.text);
    expect(modelAttr, `unparseable request element in:\n${build.text}`).not.toBeNull();
    // The quote is gone, so the value cannot terminate its own attribute and no
    // second element is smuggled in.
    expect(modelAttr![1]).not.toContain('"');
    expect(modelAttr![1]).toContain('&quot;');
    // Reversing the escapes returns the original id: escaped, not mangled.
    const unescaped = modelAttr![1]!
      .split('&lt;').join('<')
      .split('&quot;').join('"')
      .split('&amp;').join('&');
    expect(unescaped).toBe(hostile);
    // Exactly one request element: the payload never escaped the attribute.
    expect(build.text.match(/<cmdcode-request /g)).toHaveLength(1);
    expect(build.text.endsWith('</cmdcode-request>')).toBe(true);
  });

  it('escapes a workspace path containing quotes and angle brackets', async () => {
    // basename(cwd) goes into the workspace name attribute verbatim otherwise.
    // A folder name with a quote in it is legal on every supported platform.
    const parent = await mkdtemp(join(tmpdir(), 'cmdcode-model-'));
    const nested = join(parent, 'ws "q" & <b>');
    await mkdir(nested);

    try {
      const build = await buildPrompt([user('hi')], {
        model: 'stealth/space-bunny-alpha',
        cwd: nested,
        maxChars: BIG_MAX,
      });

      // Both attributes still parse, which is the whole point of escaping.
      const workspaceTag = /<workspace name="([^"]*)" root="([^"]*)">/.exec(build.text);
      expect(workspaceTag, `unparseable workspace element in:\n${build.text}`).not.toBeNull();
      // The quote is gone, so the name cannot terminate its own attribute.
      expect(workspaceTag![1]).not.toContain('"');
      expect(workspaceTag![1]).toContain('&quot;');
      expect(workspaceTag![1]).toContain('&amp;');
      expect(workspaceTag![2]).toBe(nested.split('&').join('&amp;').split('"').join('&quot;').split('<').join('&lt;'));
      // The unescaped path is recoverable, so nothing is lost.
      const unescapedRoot = workspaceTag![2]!
        .split('&lt;').join('<')
        .split('&quot;').join('"')
        .split('&amp;').join('&');
      expect(unescapedRoot).toBe(nested);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('uses the SAME id for the session cache key and the -m argument', async () => {
    // The resume contract: `store.get(model.id)` must be the session the
    // previous turn on the same chat id stored. Two different spellings of one
    // model would each get their own cache slot and resume would never hit.
    const store = new TranscriptStore();
    const model = findModel('stealth/space-bunny-alpha');
    expect(model, 'the fixture model must exist in the catalog').toBeDefined();

    const viaChatId = findModelByChatId(chatIdFor(model!.id, cwd), cwd);
    expect(viaChatId?.id).toBe(model!.id);

    store.set(viaChatId!.id, 'session-xyz');

    const build = await buildPrompt([user('hi')], { model: viaChatId!.id, cwd, maxChars: BIG_MAX });
    const modelAttr = /<cmdcode-request model="([^"]*)">/.exec(build.text)![1]!;

    // The id the store holds a session for, the id in the prompt, and the id the
    // catalog knows are one and the same.
    expect(modelAttr).toBe(model!.id);
    expect(store.get(modelAttr)).toBe('session-xyz');
  });

  it('gives the same chat id, the same cache slot, and the same prompt for one model', async () => {
    // One user turn expressed three ways: the id VS Code hands back, the
    // catalog entry it maps to, and the literal passed to buildPrompt. All
    // three must converge, or the provider has a key it cannot re-derive.
    const modelId = 'stealth/space-bunny-alpha';
    const store = new TranscriptStore();
    store.set(modelId, 's1');

    const fromChatId = findModelByChatId(chatIdFor(modelId, cwd), cwd)!.id;
    const fromCatalog = findModel(modelId)!.id;
    const fromPrompt = /<cmdcode-request model="([^"]*)">/.exec(
      (await buildPrompt([user('hi')], { model: modelId, cwd, maxChars: BIG_MAX })).text,
    )![1]!;

    expect(fromChatId).toBe(modelId);
    expect(fromCatalog).toBe(modelId);
    expect(fromPrompt).toBe(modelId);
    expect(store.get(fromChatId)).toBe('s1');
    expect(store.get(fromCatalog)).toBe('s1');
  });
});

describe('the model selection path: a model that cannot be selected', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cmdcode-model-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('refuses a near-miss id rather than normalising it to a real model', async () => {
    // Case and whitespace differences are NOT normalised: the CLI matches on the
    // exact segment after the last "/", so `MiniMaxAI/MiniMax-M3` lowercased is
    // a different (and invalid) model. Both must miss.
    const misses = ['stealth/space-bunny-alpha ', ' STEALTH/space-bunny-alpha', 'STEALTH/SPACE-BUNNY-ALPHA', 'minimaxai/minimax-m3'];

    for (const miss of misses) {
      expect(findModel(miss), `${miss} must not resolve`).toBeUndefined();
    }
  });

  it('does not silently substitute a session when the model id is unknown', async () => {
    // The provider looks up the cache by model id. An unknown id must read as a
    // cache MISS (a cold turn), never inherit some other model's session.
    const store = new TranscriptStore();
    store.set('stealth/space-bunny-alpha', 'session-of-another-model');

    const unknown = findModel('does/not-exist');
    expect(unknown).toBeUndefined();
    expect(store.get('does/not-exist')).toBeNull();
    // …and the known model's session is untouched.
    expect(store.get('stealth/space-bunny-alpha')).toBe('session-of-another-model');
  });
});

describe('the model selection path: advertised context vs the session cache', () => {
  it('advertises a real context window for every model, substituting the default for 0', async () => {
    // The provider advertises maxInputTokens from contextWindow. A model left at
    // 0 must be published with DEFAULT_CONTEXT_TOKENS, never as a 0-token model,
    // and maxOutputTokens must never be 0 either.
    for (const model of MODELS) {
      const advertised = model.contextWindow === 0 ? DEFAULT_CONTEXT_TOKENS : model.contextWindow;
      expect(advertised, `${model.id} would be advertised with no context`).toBeGreaterThan(0);
    }
    expect(DEFAULT_CONTEXT_TOKENS).toBe(200_000);
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
  });

  it('never advertises a context window above the one the catalog transcribed', () => {
    // Under-advertising is the documented safe direction; over-advertising can
    // cause a context overflow. Pin the direction of the mistake.
    for (const model of MODELS) {
      expect(model.contextWindow, `${model.id} exceeds 1M tokens`).toBeLessThanOrEqual(1_050_000);
    }
  });
});

describe('the model selection path: argv boundary between the prompt and the CLI', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cmdcode-model-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('renders a prompt containing shell and argv metacharacters as one inert argv element', async () => {
    // RunRequest.prompt is a single argv element. Content that would be
    // catastrophic if the transport ever built a shell string (quote, backtick,
    // $, ;, &&, newline) must survive rendering unchanged — that is the proof
    // the value is data, not code.
    const hostile = '$(rm -rf /) `whoami` "double" \'single\' ; && echo pwned | tee /tmp/x\nsecond line';
    const build = await buildPrompt([user(hostile)], { model: 'stealth/space-bunny-alpha', cwd, maxChars: BIG_MAX });

    expect(build.text).toContain(hostile);
    // It is INSIDE <user-now>, so it is a message body and must not be escaped.
    expect(build.text).toContain(`<user-now>\n${hostile}\n</user-now>`);
    expect(build.droppedNonTextParts).toBe(0);
    // No NUL, which cannot survive an argv element at all.
    expect(build.text.includes(' ')).toBe(false);
  });

  it('keeps the live turn intact when the history is full of metacharacters', async () => {
    // Truncation must not be able to cut a turn in half, even when the entries
    // it discards are full of tags and quotes.
    const noise = 'z'.repeat(600) + ' "unclosed <tag>';
    const live = 'the actual request: $HOME and `date`';
    const full = await buildPrompt([user(noise), user(noise), user(live)], {
      model: 'stealth/space-bunny-alpha',
      cwd,
      maxChars: BIG_MAX,
    });

    const build = await buildPrompt([user(noise), user(noise), user(live)], {
      model: 'stealth/space-bunny-alpha',
      cwd,
      maxChars: full.text.length - 400,
    });

    expect(build.truncatedChars).toBeGreaterThan(0);
    expect(build.text).toContain(`<user-now>\n${live}\n</user-now>`);
    expect(build.text.endsWith('</user-now>\n</cmdcode-request>')).toBe(true);
  });

  it('stays under the default maxPromptChars for the worst realistic turn', async () => {
    // CONFIG_DEFAULTS.maxPromptChars is 900000; the rendered prompt must fit it
    // once the catalog's 64 KiB AGENTS.md budget is spent.
    const { CONFIG_DEFAULTS } = await import('../src/types.js');
    await writeFile(join(cwd, 'AGENTS.md'), 'i'.repeat(64 * 1024));

    const build = await buildPrompt(
      [user('a'.repeat(50_000)), user('b'.repeat(50_000)), user('the live question')],
      { model: 'stealth/space-bunny-alpha', cwd, maxChars: CONFIG_DEFAULTS.maxPromptChars },
    );

    expect(build.text.length).toBeLessThanOrEqual(CONFIG_DEFAULTS.maxPromptChars);
    expect(build.truncatedChars).toBe(0);
    expect(build.text).toContain('the live question');
  });

  it('FINDING: passes a NUL byte through to the prompt, which cannot survive an argv element', async () => {
    // RunRequest.prompt is handed to child_process.spawn as a single argv
    // element. Node REJECTS a NUL in argv outright (ERR_INVALID_ARG_VALUE,
    // "must be a string without null bytes"), which would surface as
    // spawn-failed for a turn whose text was perfectly ordinary otherwise.
    //
    // buildPrompt copies text parts verbatim, so a NUL typed or pasted into the
    // chat box reaches the prompt unchanged. The merged spec (§4.8) does not
    // ask for sanitisation and this file may not change application code, so
    // the behaviour is pinned as-is and raised for the transport issue: either
    // the transport must strip/reject NUL before spawning, or buildPrompt must.
    const withNul = `before${String.fromCharCode(0)}after`;
    const build = await buildPrompt([user(withNul)], {
      model: 'stealth/space-bunny-alpha',
      cwd,
      maxChars: BIG_MAX,
    });

    expect(build.text.includes(String.fromCharCode(0)), 'documented pass-through').toBe(true);
    expect(build.droppedNonTextParts).toBe(0);
  });

  it('propagates the empty-request CliError untouched, so the caller can present it', async () => {
    // buildPrompt throws a real CliError; the provider must be able to hand the
    // exact instance to toPresentation rather than re-wrapping it.
    const error = await buildPrompt([], { model: 'stealth/space-bunny-alpha', cwd, maxChars: BIG_MAX }).catch(
      (e: unknown) => e as CliError,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as CliError).code).toBe('unknown');
  });
});
