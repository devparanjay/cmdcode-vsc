import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTEXT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MODELS,
  chatIdFor,
  findModel,
  findModelByChatId,
  modelsForPlan,
} from '../src/catalog.js';
import { PLAN_TIER_ORDER } from '../src/types.js';

// No `vscode` import and no stub anywhere in this file: catalog.ts must be
// importable from a plain vitest run (architecture §3.1). The fact that this
// file loads at all is the boundary assertion.

const WS = '/Users/paranjay/dev/cmdcode-vsc';
const EFFORT_VALUES: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CHAT_ID_SHAPE = /^cmdc-[0-9a-f]{12}$/;

/** Ids whose form every other id follows, and the ones that genuinely do not. */
const NAMESPACE_PREFIX = /^(deepseek|moonshotai|z-ai|zai-org|minimaxai|xiaomi|qwen|meituan|stepfun|tencent|nvidia|thinkingmachines|poolside|inclusionai|stealth|google|sakana|meta|xai)\//i;
const UNPREFIXED_IDS: readonly string[] = [
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.4-mini',
];

describe('MODELS shape', () => {
  it('holds exactly 82 entries', () => {
    expect(MODELS).toHaveLength(82);
  });

  it('gives every entry a non-empty id, name and blurb', () => {
    for (const m of MODELS) {
      expect(m.id, 'id').not.toBe('');
      expect(m.name, m.id).not.toBe('');
      expect(m.blurb, m.id).not.toBe('');
    }
  });

  it('has no duplicate id', () => {
    const seen = new Set(MODELS.map((m) => m.id));
    expect(seen.size).toBe(82);
  });

  it('copies the vendor ids exactly: never lowercased, never trimmed', () => {
    // The vendor table mixes cases on purpose (`MiniMaxAI/MiniMax-M3`,
    // `Qwen/Qwen3.8-Omni-Flash`, `zai-org/GLM-5.2-Fast`). `cmd --list-models`
    // prints them lowercased for display, but `-m` is matched on the segment
    // after the last "/", so lowercasing would break `Qwen3.8-27B` → `qwen3.8-27b`
    // and silently resolve a different (or no) model. Verified: the exact
    // mixed-case ids reach the server; the lowercase ones do not.
    for (const id of ['MiniMaxAI/MiniMax-M3', 'Qwen/Qwen3.8-27B', 'zai-org/GLM-5.2-Fast']) {
      expect(MODELS.map((m) => m.id), id).toContain(id);
    }
    for (const m of MODELS) {
      expect(m.id, m.id).toBe(m.id.trim());
      // The only allowed multi-case ids are the vendor's own spelling of the
      // namespace and the model segment; every id is lowercase or vendor-exact.
      expect(/^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$|^[a-z0-9][A-Za-z0-9._:-]*$/.test(m.id), m.id).toBe(
        true,
      );
    }
  });

  it('lists the 19 unprefixed Anthropic/OpenAI ids and prefixes the other 63', () => {
    // `reference/models.md` ships the Anthropic and OpenAI ids with no vendor
    // prefix, and `cmd --list-models` prints them the same way. Prefixing them
    // would be inventing ids, which the source table forbids. Asserted one by
    // one so a transcription slip that added or dropped a prefix fails loudly.
    const unprefixed = MODELS.filter((m) => !m.id.includes('/')).map((m) => m.id);
    expect(unprefixed).toEqual([...UNPREFIXED_IDS]);

    // Every unprefixed id belongs to the two sections that ship bare, and every
    // other id carries a known namespace segment.
    for (const id of UNPREFIXED_IDS) expect(/^(claude-|gpt-)/.test(id), id).toBe(true);
    for (const m of MODELS) {
      if (m.id.includes('/')) expect(NAMESPACE_PREFIX.test(m.id), m.id).toBe(true);
    }
  });
});

describe('MODELS metadata', () => {
  it('restricts every efforts value to the five the CLI documents', () => {
    for (const m of MODELS) {
      for (const e of m.efforts) {
        expect(EFFORT_VALUES, `${m.id} effort ${e}`).toContain(e);
      }
      // `—` transcribes to the empty list, never to a placeholder string.
      for (const e of m.efforts) expect(e, m.id).not.toBe('—');
    }
  });

  it('uses the empty list for entries whose source Efforts column is a dash', () => {
    expect(MODELS.filter((m) => m.efforts.length === 0).length).toBeGreaterThan(0);
    expect(MODELS.find((m) => m.id === 'claude-haiku-4-5-20251001')?.efforts).toEqual([]);
    expect(MODELS.find((m) => m.id === 'zai-org/GLM-5.1')?.efforts).toEqual([]);
  });

  it('gives every entry a minPlan drawn from PLAN_TIER_ORDER', () => {
    for (const m of MODELS) {
      expect(PLAN_TIER_ORDER, m.id).toContain(m.minPlan);
    }
  });

  it('reproduces the observed min-plan distribution: 52 go, 8 goat, 14 pro, 8 max', () => {
    const histogram: Record<string, number> = {};
    for (const m of MODELS) histogram[m.minPlan] = (histogram[m.minPlan] ?? 0) + 1;
    expect(histogram).toEqual({ go: 52, goat: 8, pro: 14, max: 8 });
  });

  it('maps all four source "… and above" strings to the right tier', () => {
    // Spot-check, one row per source string, asserted explicitly so a
    // transcription that shifted a tier by one is caught.
    expect(MODELS.find((m) => m.id === 'deepseek/deepseek-v4-pro')?.minPlan).toBe('go'); // Go and above
    expect(MODELS.find((m) => m.id === 'xiaomi/mimo-v2.6-pro-ultraspeed')?.minPlan).toBe('goat'); // GOAT and above
    expect(MODELS.find((m) => m.id === 'claude-sonnet-5')?.minPlan).toBe('pro'); // Pro and above
    expect(MODELS.find((m) => m.id === 'sakana/fugu-ultra')?.minPlan).toBe('max'); // Max
  });

  it('scales every non-dash Context column by 1000 and leaves exactly 4 at zero', () => {
    const zero = MODELS.filter((m) => m.contextWindow === 0);
    expect(zero.map((m) => m.id)).toEqual([
      'zai-org/GLM-5.1',
      'MiniMaxAI/MiniMax-M2.7',
      'Qwen/Qwen3.6-Max-Preview',
      'Qwen/Qwen3.6-Plus',
    ]);

    for (const m of MODELS) {
      if (m.contextWindow === 0) continue; // the four `—` rows, asserted above
      // Only the seven observed Context values may appear, all ×1000.
      expect(
        [200_000, 256_000, 262_000, 400_000, 500_000, 1_000_000, 1_050_000],
        m.id,
      ).toContain(m.contextWindow);
      expect(m.contextWindow % 1000, m.id).toBe(0);
    }
  });

  it('exports the two token constants', () => {
    // 200_000, not the 128_000 an earlier draft of the plan quoted for the
    // same byok.md:141 row. K = 1000, matching every Context column.
    expect(DEFAULT_CONTEXT_TOKENS).toBe(200_000);
    expect(MAX_OUTPUT_TOKENS).toBe(32_000);
  });
});

describe('findModel', () => {
  it('returns the exact-id entry', () => {
    for (const m of MODELS) {
      expect(findModel(m.id), m.id).toBe(m);
    }
  });

  it('returns undefined for an unknown id', () => {
    expect(findModel('bogus/nonexistent')).toBeUndefined();
    expect(findModel('')).toBeUndefined();
  });

  it('does not normalise the query — a near miss is a miss', () => {
    const [m] = MODELS;
    expect(findModel(m.id.toUpperCase())).not.toBe(m);
    expect(findModel(m.id + ' ')).toBeUndefined();
  });
});

describe('modelsForPlan', () => {
  it('returns the whole catalog at the top tier, in catalog order', () => {
    const forMax = modelsForPlan('max');
    expect(forMax).toHaveLength(82);
    expect(forMax.map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
  });

  it('narrows as the tier drops: go reaches only the 52 Go models', () => {
    // "and above" is cumulative, so a model is reachable by its own tier and
    // every tier above it — not below it.
    expect(modelsForPlan('go')).toHaveLength(52);
    expect(modelsForPlan('go').every((m) => m.minPlan === 'go')).toBe(true);

    const counts = (['go', 'goat', 'pro', 'max'] as const).map((t) => modelsForPlan(t).length);
    expect(counts).toEqual([52, 60, 74, 82]);
  });

  it('preserves catalog order at every tier', () => {
    for (const tier of PLAN_TIER_ORDER) {
      const ids = modelsForPlan(tier).map((m) => m.id);
      const expected = MODELS.filter((m) => PLAN_TIER_ORDER.indexOf(m.minPlan) <= PLAN_TIER_ORDER.indexOf(tier)).map(
        (m) => m.id,
      );
      expect(ids, tier).toEqual(expected);
    }
  });

  it('returns the same entries for every tier at or above a model own tier', () => {
    const gated = MODELS.find((m) => m.minPlan === 'pro')!;
    for (const tier of ['pro', 'max'] as const) {
      expect(modelsForPlan(tier), tier).toContain(gated);
    }
    expect(modelsForPlan('go')).not.toContain(gated);
    expect(modelsForPlan('goat')).not.toContain(gated);
  });
});

describe('chatIdFor', () => {
  it('mints `cmdc-` plus 12 lowercase hex characters', () => {
    for (const m of MODELS) {
      expect(chatIdFor(m.id, WS), m.id).toMatch(CHAT_ID_SHAPE);
    }
  });

  it('is deterministic across calls', () => {
    for (const m of MODELS) {
      expect(chatIdFor(m.id, WS)).toBe(chatIdFor(m.id, WS));
    }
  });

  it('is the same in every workspace, so a pin survives a folder switch', () => {
    // This is the fix for "pinned models do not appear in the picker". VS Code
    // drops any pin whose id is not in the live model cache, so a
    // workspace-derived id made every pin folder-scoped and silently dead. The
    // cwd is carried per request (`RunRequest.cwd`), never in the id, so
    // nothing downstream needed the salt.
    const other = '/Users/paranjay/dev/other-repo';
    for (const m of MODELS) {
      expect(chatIdFor(m.id, other), m.id).toBe(chatIdFor(m.id, WS));
      // And with no workspace open at all, which minted a third set before.
      expect(chatIdFor(m.id, ''), m.id).toBe(chatIdFor(m.id, WS));
    }
  });

  it('distinguishes models within one workspace', () => {
    const ids = MODELS.map((m) => chatIdFor(m.id, WS));
    expect(new Set(ids).size).toBe(82);
  });

  it('cannot be made to collide by moving characters across a boundary', () => {
    // The old scheme hashed `path\0id`; `a\0bc` and `ab\0c` had to differ, so
    // the separator could not be dropped. The id is hashed alone now, so the
    // load-bearing property is simply that distinct ids stay distinct.
    expect(chatIdFor('bc')).not.toBe(chatIdFor('c'));
    expect(chatIdFor('a')).not.toBe(chatIdFor('b'));
  });
});

describe('findModelByChatId', () => {
  it('inverts chatIdFor for all 82 entries', () => {
    for (const m of MODELS) {
      expect(findModelByChatId(chatIdFor(m.id, WS), WS), m.id).toBe(m);
    }
  });

  it('round-trips in a second workspace too', () => {
    const other = '/private/tmp/some other workspace';
    for (const m of MODELS) {
      expect(findModelByChatId(chatIdFor(m.id, other), other)?.id, m.id).toBe(m.id);
    }
  });

  it('resolves an id minted elsewhere, because the id is workspace-independent', () => {
    const [m] = MODELS;
    const other = '/Users/paranjay/dev/other-repo';
    // The inverse of the old behaviour, and the point of the change: a pin made
    // in one folder resolves in another instead of dangling.
    expect(findModelByChatId(chatIdFor(m.id, WS), other)?.id, m.id).toBe(m.id);
  });

  it('returns undefined for a malformed or unknown chat id', () => {
    expect(findModelByChatId('nope', WS)).toBeUndefined();
    expect(findModelByChatId('cmdc-', WS)).toBeUndefined();
    expect(findModelByChatId('', WS)).toBeUndefined();
  });
});

describe('the module boundary', () => {
  /** Read from disk: the import list and the absence of an index are only observable in the source. */
  function catalogSource(): string {
    return readFileSync(resolve(process.cwd(), 'src/catalog.ts'), 'utf8');
  }

  it('imports no vscode — the only imports are node:crypto and ./types.js', () => {
    const source = catalogSource();
    expect(source).not.toMatch(/from\s+['"]vscode['"]/);
    const imports = [...source.matchAll(/^import\s.*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:crypto', './types.js']);
  });

  it('adds no reverse-lookup index over the catalog', () => {
    const source = catalogSource();
    expect(source).not.toMatch(/new Map/);
    expect(source).not.toMatch(/new Set/);
  });
});
