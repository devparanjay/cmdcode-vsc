import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { TranscriptStore } from '../src/transcript.js';

// No `vscode` import and no stub anywhere in this file: transcript.ts is a
// leaf with no seam to fake (AC-6). The `fs` import below reads the module's own
// source to assert it has no imports at all — a test-side concern, not the
// module writing anything.

const SOURCE = readFileSync(resolve(__dirname, '..', 'src', 'transcript.ts'), 'utf8');

/** Fills the store to `capacity` with keys `k0..k{n-1}`, in that order. */
function fill(store: TranscriptStore, capacity: number): void {
  for (let i = 0; i < capacity; i++) {
    store.set(`k${i}`, `s${i}`);
  }
}

describe('TranscriptStore', () => {
  it('returns null for an unknown model id and the stored value after a set', () => {
    const store = new TranscriptStore();

    expect(store.get('stealth/space-bunny-alpha')).toBeNull();
    expect(store.size).toBe(0);

    store.set('stealth/space-bunny-alpha', 'ab4c5b22-0000-4000-8000-000000000000');
    expect(store.get('stealth/space-bunny-alpha')).toBe(
      'ab4c5b22-0000-4000-8000-000000000000',
    );
    expect(store.size).toBe(1);
  });

  it('round-trips distinct keys independently', () => {
    const store = new TranscriptStore();
    store.set('a', 'session-a');
    store.set('b', 'session-b');

    expect(store.get('a')).toBe('session-a');
    expect(store.get('b')).toBe('session-b');
    expect(store.size).toBe(2);
  });

  it('replaces the value on an existing key without growing the map', () => {
    const store = new TranscriptStore();
    store.set('a', 'first');
    store.set('b', 'other');
    expect(store.size).toBe(2);

    store.set('a', 'second');
    expect(store.get('a')).toBe('second');
    // Overwrite, not insert: no 'a (second)' entry, no growth.
    expect(store.size).toBe(2);
  });

  it('evicts the least recently used entry at the default capacity of 32', () => {
    const store = new TranscriptStore();
    fill(store, 32);
    expect(store.size).toBe(32);
    expect(store.get('k0')).toBe('s0');

    // The 33rd distinct key pushes the store over capacity.
    store.set('k32', 's32');
    expect(store.size).toBe(32);
    // k0 was the least recently used, so it is the one that went.
    expect(store.get('k0')).toBeNull();
    expect(store.get('k32')).toBe('s32');
    // Every other key survived.
    for (let i = 1; i < 32; i++) {
      expect(store.get(`k${i}`), `k${i} should have survived`).toBe(`s${i}`);
    }
  });

  it('refreshes recency on re-set, so a key outlives an eviction it would not', () => {
    // The behaviour a naive insertion-ordered map gets wrong: after the
    // refresh, k0 must be evicted *last*, not first.
    const store = new TranscriptStore();
    fill(store, 32);

    // Refresh k0, the least recently used key. Without the refresh this is the
    // next eviction; with it, k0 is now the most recently used.
    store.set('k0', 's0-refreshed');
    expect(store.size).toBe(32);

    // One eviction: k1 is now the LRU, not k0.
    store.set('k32', 's32');
    expect(store.size).toBe(32);
    expect(store.get('k0')).toBe('s0-refreshed');
    expect(store.get('k1')).toBeNull();

    // A refreshed key survives exactly the evictions its recency now buys it.
    const untouched = new TranscriptStore();
    fill(untouched, 32);
    untouched.set('k32', 's32');
    expect(untouched.get('k0'), 'control: unrefreshed k0 is evicted').toBeNull();
  });

  it('evicts strictly by recency order, not by insertion order', () => {
    // Insertion order and use order are deliberately interleaved so a
    // first-in-first-out implementation cannot pass this.
    const store = new TranscriptStore(4);
    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');
    store.set('d', '4');

    store.set('a', '1-refreshed'); // a is now most recent: order is b, c, d, a.
    store.set('e', '5'); // evicts b.
    expect(store.get('b')).toBeNull();

    store.set('d', '4-refreshed'); // order is c, a, e, d.
    store.set('f', '6'); // evicts c, the genuinely least recently used.
    expect(store.get('c')).toBeNull();
    expect(store.get('a')).toBe('1-refreshed');
    expect(store.get('d')).toBe('4-refreshed');
    expect(store.get('e')).toBe('5');
    expect(store.get('f')).toBe('6');
  });

  it('clears every entry and reports zero size afterwards', () => {
    const store = new TranscriptStore();
    store.set('a', 'session-a');
    store.set('b', 'session-b');
    expect(store.size).toBe(2);

    store.clear();

    expect(store.size).toBe(0);
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBeNull();

    // Still usable after a clear: capacity and eviction are unaffected.
    store.set('c', 'session-c');
    expect(store.get('c')).toBe('session-c');
    expect(store.size).toBe(1);
  });

  it('starts empty and never grows past capacity', () => {
    const store = new TranscriptStore();
    expect(store.size).toBe(0);

    for (let i = 0; i < 200; i++) {
      store.set(`model/${i}`, `session/${i}`);
      expect(store.size).toBeLessThanOrEqual(32);
    }
    expect(store.size).toBe(32);
  });

  it('honours a non-default capacity passed to the constructor', () => {
    const store = new TranscriptStore(2);
    store.set('a', '1');
    store.set('b', '2');
    expect(store.size).toBe(2);

    // Third key evicts the LRU, exactly as at the default capacity.
    store.set('c', '3');
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBe('2');
    expect(store.get('c')).toBe('3');
    expect(store.size).toBe(2);

    // And the refresh rule holds at the smaller capacity too.
    store.set('b', '2-refreshed');
    store.set('d', '4');
    expect(store.get('c')).toBeNull();
    expect(store.get('b')).toBe('2-refreshed');
    expect(store.get('d')).toBe('4');
  });

  it('behaves at capacity 1, holding only the most recent key', () => {
    const store = new TranscriptStore(1);
    store.set('a', '1');
    expect(store.size).toBe(1);

    store.set('b', '2');
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBe('2');

    // An overwrite in place must not evict the only entry.
    store.set('b', '2-refreshed');
    expect(store.get('b')).toBe('2-refreshed');
    expect(store.size).toBe(1);
  });

  it('imports nothing and touches no disk or external store', async () => {
    // AC-6. A `vscode` or `node:fs` import is the whole failure mode: the
    // module must be loadable with no alias and no stub.
    //
    // Parsed with the TypeScript compiler rather than grepped, so a module
    // doc comment that *mentions* `vscode` cannot mask (or fake) a real
    // import — only actual syntax counts.
    const sf = ts.createSourceFile(
      'transcript.ts',
      SOURCE,
      ts.ScriptTarget.ES2022,
      /* setParentNodes */ true,
    );
    const specifiers = sf.statements.filter(ts.isImportDeclaration);
    expect(
      specifiers.map((d) => (d.moduleSpecifier as ts.StringLiteral).text),
      'transcript.ts must have no import declarations',
    ).toEqual([]);
    expect(sf.statements.filter(ts.isImportEqualsDeclaration), 'no import =').toHaveLength(0);
    expect(
      SOURCE.match(/require\s*\(/),
      'transcript.ts must not call require()',
    ).toBeNull();

    // No filesystem or external-store surface either, asserted on the source
    // with comments stripped so this file's own prose stays legal.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      'node:fs',
      'writeFile',
      'globalState',
      'workspaceState',
      'fetch',
      'JSON.stringify',
    ]) {
      expect(code, `transcript.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }

    // …and the class is genuinely the only export.
    expect(Object.keys(await import('../src/transcript.js'))).toEqual(['TranscriptStore']);
  });
});
