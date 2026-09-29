import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { toChatInformation } from '../src/catalog-to-chat.js';
import {
  DEFAULT_CONTEXT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MODELS,
  chatIdFor,
  findModelByChatId,
} from '../src/catalog.js';
import { ADAPTER_VERSION } from '../src/types.js';

// `src/catalog-to-chat.ts` imports `vscode`, so it can only load because
// `vitest.config.ts` aliases the bare specifier to `test/vscode-stub.ts`
// (architecture §3.1, §7.2). TypeScript still types it from @types/vscode, so
// the return type is the real `LanguageModelChatInformation[]`; at runtime the
// stub is inert and the projection never touches a single value from it.

const WS = '/Users/paranjay/dev/cmdcode-vsc';
const OTHER_WS = '/private/tmp/some other workspace';
const CHAT_ID_SHAPE = /^cmdc-[0-9a-f]{12}$/;

/** The four entries whose source Context column is an em-dash, transcribed as 0. */
const ZERO_CONTEXT_IDS: readonly string[] = [
  'zai-org/GLM-5.1',
  'MiniMaxAI/MiniMax-M2.7',
  'Qwen/Qwen3.6-Max-Preview',
  'Qwen/Qwen3.6-Plus',
];

describe('toChatInformation — shape and size', () => {
  const info = toChatInformation(MODELS, WS);

  it('returns exactly 82 objects, one per catalog entry', () => {
    expect(info).toHaveLength(82);
    expect(MODELS).toHaveLength(82);
  });

  it('is synchronous and returns a plain array, not a promise', () => {
    // AC-01: the model picker is populated inline, so a promise here would be
    // a silent API change. `Array.isArray` is the load-bearing assertion.
    expect(Array.isArray(info)).toBe(true);
    expect(info).not.toBeInstanceOf(Promise);
  });

  it('preserves catalog order', () => {
    // Order is the transcription order of the vendor table; the picker shows it.
    expect(info.map((i) => i.name)).toEqual(MODELS.map((m) => m.name));
  });

  it('returns an empty array for an empty catalog slice', () => {
    expect(toChatInformation([], WS)).toEqual([]);
  });

  it('projects only the models it is given', () => {
    const slice = MODELS.slice(0, 3);
    const projected = toChatInformation(slice, WS);
    expect(projected).toHaveLength(3);
    expect(projected.map((i) => i.id)).toEqual(slice.map((m) => chatIdFor(m.id, WS)));
  });

  it('carries no value sourced from the vscode stub — every field is plain data', () => {
    // Proof that the projection is total and stub-free: the eight API fields
    // are primitives, plus the one nested capabilities literal, and nothing in
    // the result is a class instance, a URI or a namespace value.
    for (const i of info) {
      expect(Object.keys(i).sort(), i.id).toEqual([
        'capabilities',
        'detail',
        'family',
        'id',
        'maxInputTokens',
        'maxOutputTokens',
        'name',
        'tooltip',
        'version',
      ]);
      expect(Object.getPrototypeOf(i), i.id).toBe(Object.prototype);
      for (const [key, value] of Object.entries(i)) {
        if (key === 'capabilities') continue;
        expect(['string', 'number', 'boolean'], `${i.id}.${key}`).toContain(typeof value);
      }
    }
  });

  it('uses vscode only in the return type position — the import is type-only in effect', () => {
    // `import * as vscode from 'vscode'` is retained for the documented §3.1
    // ownership, but every `vscode.` occurrence is a type annotation, so esbuild
    // elides the module and the runtime needs no vscode surface at all. A
    // value-position use (a class, a namespace constant) would show up here.
    const source = readFileSync(resolve(process.cwd(), 'src/catalog-to-chat.ts'), 'utf8');
    const references = new Set(
      [...source.matchAll(/\bvscode\s*\.\s*[A-Za-z_$][\w$]*/g)].map((m) => m[0].replace(/\s+/g, '')),
    );
    expect([...references]).toEqual(['vscode.LanguageModelChatInformation']);
    expect(source).toMatch(/^import \* as vscode from 'vscode';$/m);
  });

  it('declares a plain function, so nothing here can await or spawn', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/catalog-to-chat.ts'), 'utf8');
    const signature = source.slice(source.indexOf('export function toChatInformation'));
    expect(signature).not.toMatch(/\basync\b/);
    expect(signature).not.toMatch(/\bawait\b/);
    expect(signature).not.toMatch(/from\s+['"]node:/);
    expect(signature).not.toMatch(/child_process|\bexec\(|\bspawn\(/);
  });
});

describe('toChatInformation — ids (AC-02)', () => {
  const info = toChatInformation(MODELS, WS);

  it('mints `cmdc-` plus 12 lowercase hex characters for every model', () => {
    for (const m of MODELS) {
      const id = info[MODELS.indexOf(m)].id;
      expect(id, m.id).toMatch(CHAT_ID_SHAPE);
    }
  });

  it('makes no id unique — 82 models, 82 distinct ids', () => {
    const seen = new Set(info.map((i) => i.id));
    expect(seen.size).toBe(82);
  });

  it('is identical across two calls with the same workspace path', () => {
    // The hash is pure, so a second call cannot reshuffle the picker or orphan
    // the sessions a user already has against these ids.
    expect(toChatInformation(MODELS, WS)).toEqual(toChatInformation(MODELS, WS));
  });

  it('salts the id with the workspace path, so another workspace gets a disjoint set', () => {
    const other = toChatInformation(MODELS, OTHER_WS);
    const mine = new Set(info.map((i) => i.id));
    for (const i of other) {
      expect(mine.has(i.id), i.id).toBe(false);
    }
    expect(new Set(other.map((i) => i.id)).size).toBe(82);
  });
});

describe('toChatInformation — the projection is exactly invertible (AC-03)', () => {
  it('inverts every projected id back to its own catalog entry', () => {
    // The hot path of §4.9 step 2: VS Code hands back the id it was given, and
    // the provider must recover the `-m` value. Loop the whole catalog.
    for (const model of MODELS) {
      const [projected] = toChatInformation([model], WS);
      expect(findModelByChatId(projected.id, WS), model.id).toBe(model);
      expect(findModelByChatId(projected.id, WS)?.id, model.id).toBe(model.id);
    }
  });

  it('inverts a whole-catalog projection position by position', () => {
    const info = toChatInformation(MODELS, WS);
    for (const [index, projected] of info.entries()) {
      expect(findModelByChatId(projected.id, WS), MODELS[index].id).toBe(MODELS[index]);
    }
  });

  it('round-trips the ids the model picker actually holds', () => {
    // Same assertion, written the way AC-03 states it, so a change to either
    // `chatIdFor` or the projection is caught here and not only in catalog.test.ts.
    for (const m of MODELS) {
      const [projected] = toChatInformation([m], WS);
      expect(projected.id).toBe(chatIdFor(m.id, WS));
      expect(findModelByChatId(chatIdFor(m.id, WS), WS)?.id, m.id).toBe(m.id);
    }
  });

  it('does not resolve an id minted for another workspace', () => {
    const [mine] = toChatInformation(MODELS, WS);
    expect(findModelByChatId(mine.id, OTHER_WS)).toBeUndefined();
  });
});

describe('toChatInformation — token budgets', () => {
  const info = toChatInformation(MODELS, WS);

  it('advertises the catalog context window verbatim when the catalog states one', () => {
    for (const [index, m] of MODELS.entries()) {
      if (m.contextWindow === 0) continue; // the four em-dash rows, asserted below
      expect(info[index].maxInputTokens, m.id).toBe(m.contextWindow);
    }
  });

  it('substitutes DEFAULT_CONTEXT_TOKENS for exactly the 4 em-dash entries', () => {
    const zero = MODELS.map((m, index) => ({ m, tokens: info[index].maxInputTokens })).filter(
      (row) => row.m.contextWindow === 0,
    );
    expect(zero.map((r) => r.m.id)).toEqual([...ZERO_CONTEXT_IDS]);
    for (const row of zero) {
      expect(row.tokens, row.m.id).toBe(DEFAULT_CONTEXT_TOKENS);
    }
  });

  it('pins DEFAULT_CONTEXT_TOKENS at 200000, not 128000', () => {
    // An earlier revision of the plan quoted 128000 from the same
    // reference/byok.md:141 row. K = 1000, and this value reaches four real
    // models, so it is asserted on both the constant and the projection.
    expect(DEFAULT_CONTEXT_TOKENS).toBe(200_000);
    for (const row of ZERO_CONTEXT_IDS) {
      const m = MODELS.find((model) => model.id === row)!;
      expect(m.contextWindow, row).toBe(0);
      expect(toChatInformation([m], WS)[0].maxInputTokens, row).toBe(200_000);
    }
  });

  it('never advertises a zero input budget', () => {
    for (const i of info) {
      expect(i.maxInputTokens, i.id).toBeGreaterThan(0);
    }
  });

  it('advertises MAX_OUTPUT_TOKENS for every model, the catalog stating no per-model cap', () => {
    expect(MAX_OUTPUT_TOKENS).toBe(32_000);
    for (const i of info) {
      expect(i.maxOutputTokens, i.id).toBe(MAX_OUTPUT_TOKENS);
    }
  });
});

describe('toChatInformation — capabilities (declined for v1)', () => {
  const info = toChatInformation(MODELS, WS);

  it('declares toolCalling false and imageInput false for every model', () => {
    // §D5: v1 renders text only. Advertising either would make Copilot send
    // parts this adapter silently drops.
    for (const i of info) {
      expect(i.capabilities.toolCalling, i.id).toBe(false);
      expect(i.capabilities.imageInput, i.id).toBe(false);
    }
  });

  it('declares no other capability key', () => {
    const shapes = new Set(info.map((i) => Object.keys(i.capabilities).sort().join(',')));
    expect([...shapes]).toEqual(['imageInput,toolCalling']);
  });

  it('cannot be mutated from outside the projection', () => {
    const [first] = info;
    expect(Object.isFrozen(first.capabilities)).toBe(true);
  });
});

describe('toChatInformation — metadata strings', () => {
  // The API types `detail` and `tooltip` as optional, so the projection always
  // setting them is part of what these assertions prove. This local view makes
  // that non-optional, without asserting the absence of a runtime value.
  interface Rendered {
    readonly id: string;
    readonly version: string;
    readonly detail: string;
    readonly tooltip: string;
  }

  /**
   * Project and prove the optional API fields are actually populated. The
   * `expect` calls run on every use, so "always sets detail and tooltip" is
   * asserted rather than assumed behind a non-null assertion.
   */
  function render(ws: string = WS): Rendered[] {
    return toChatInformation(MODELS, ws).map((i) => {
      expect(i.detail, i.id).toBeTypeOf('string');
      expect(i.tooltip, i.id).toBeTypeOf('string');
      return { id: i.id, version: i.version, detail: i.detail!, tooltip: i.tooltip! };
    });
  }

  const info: readonly Rendered[] = render();

  it('reports ADAPTER_VERSION, not a model version, for every model', () => {
    for (const i of info) {
      expect(i.version, i.id).toBe(ADAPTER_VERSION);
    }
    expect(ADAPTER_VERSION).toBe('1.0.0');
  });

  it('uses the opaque family label `cmdcode`', () => {
    expect(new Set(toChatInformation(MODELS, WS).map((i) => i.family))).toEqual(new Set(['cmdcode']));
  });

  it('builds detail as `<catalog id> · <MIN PLAN> and above`', () => {
    for (const [index, m] of MODELS.entries()) {
      expect(info[index].detail, m.id).toBe(`${m.id} · ${m.minPlan.toUpperCase()} and above`);
    }
  });

  it('uppercases the plan tier, and the middot is U+00B7 with one space either side', () => {
    for (const [index, m] of MODELS.entries()) {
      const detail = info[index].detail;
      expect(detail.includes(' · '), m.id).toBe(true);
      expect(detail, m.id).toMatch(new RegExp(` ${m.minPlan.toUpperCase()} and above$`));
    }
    const detail = info[MODELS.findIndex((m) => m.id === 'claude-sonnet-5')].detail;
    expect(detail).toBe('claude-sonnet-5 · PRO and above');
  });

  it('renders all four plan tiers, so no tier is left lowercased', () => {
    const details = MODELS.map((m, index) => info[index].detail);
    for (const tier of ['GO', 'GOAT', 'PRO', 'MAX']) {
      expect(details.some((d) => d.endsWith(` ${tier} and above`)), tier).toBe(true);
    }
  });

  it('uses the catalog blurb verbatim as the tooltip', () => {
    for (const [index, m] of MODELS.entries()) {
      expect(info[index].tooltip, m.id).toBe(m.blurb);
      expect(info[index].tooltip, m.id).not.toBe('');
    }
  });

  it('carries the vendor display name through unchanged', () => {
    for (const [index, m] of MODELS.entries()) {
      expect(toChatInformation([m], WS)[0].name, m.id).toBe(m.name);
    }
  });
});

describe('the module boundary (§3.1)', () => {
  const SRC = resolve(process.cwd(), 'src');

  /** Every `src/` file, so the vscode-import set is observed, not assumed. */
  function sourceFiles(dir: string = SRC): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  function vscodeImporters(): string[] {
    return sourceFiles()
      .filter((file) => /from\s+['"]vscode['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split(/[\\/]/).join('/'))
      .sort();
  }

  it('is one of the modules allowed to import vscode', () => {
    // §3.1 names the owners: the prompt builder, this projection and the chat
    // provider, plus the extension-host-only entry points. A fourth owner would
    // mean another module that only tests against the stub.
    const ALLOWED = [
      'catalog-to-chat.ts',
      'chat-provider.ts',
      'commands.ts',
      'extension.ts',
      'prompt.ts',
    ];
    const importers = vscodeImporters();
    expect(importers).toContain('catalog-to-chat.ts');
    expect(importers).toContain('prompt.ts');
    for (const file of importers) {
      expect(ALLOWED, file).toContain(file);
    }
  });

  it('leaves catalog.ts importable without a stub', () => {
    const importers = vscodeImporters();
    expect(importers).not.toContain('catalog.ts');
    expect(importers).not.toContain('types.ts');
  });
});
