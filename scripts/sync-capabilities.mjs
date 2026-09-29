// Regenerates the per-model capability data embedded in src/catalog.ts from the
// Command Code CLI's own static catalog.
//
// WHY THIS EXISTS
// The extension has to advertise `imageInput` per model. The only trustworthy
// source is the CLI's own catalog, which is the data the product branches on:
//
//   modelSupportsVision: m => { const t = findModelById(m)
//     return !t?.inputModalities || t.inputModalities.includes("image") }
//
// The "Best for" prose in models.md is NOT a data source. It disagrees with the
// catalog in both directions: `deepseek/deepseek-v4.1-flash` says "with vision"
// and is vision-capable, while `deepseek/deepseek-v4-pro` says nothing about
// vision and is text-only. A regex over prose would be guessing.
//
// Usage:
//   node scripts/sync-capabilities.mjs            # report only, no writes
//   node scripts/sync-capabilities.mjs --write    # rewrite catalog.ts in place
//
// The CLI path is overridable so this can be run against a different install:
//   CMD_CLI=/path/to/cli.mjs node scripts/sync-capabilities.mjs --write
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has('--write');

const cliPath =
  process.env.CMD_CLI ??
  join(
    homedir(),
    '.nvm/versions/node/v24.13.0/lib/node_modules/command-code/dist/cli.mjs',
  );

let source;
try {
  source = readFileSync(cliPath, 'utf8');
} catch (error) {
  console.error(`Cannot read the CLI bundle at ${cliPath}.`);
  console.error('Set CMD_CLI to the path of command-code/dist/cli.mjs.');
  console.error(String(error));
  process.exit(1);
}

// The catalog is minified into one long line. Each entry opens with
// `NAME:{id:"<x>",inputModalities:[...` and the fields we care about
// (`reasoning:!0`, `reasoningEfforts:[`) follow within the same entry. Entries
// are delimited by the next `id:"` — except the LAST one, which ends with `}}`
// and must not be dropped, so the lookahead also accepts `}}`.
const FIELD = /id:"([^"]+)",inputModalities:\[([^\]]*)\][\s\S]{0,600}?(?=id:"|\}\}|\Z)/g;

const capabilities = new Map();
for (const match of source.matchAll(FIELD)) {
  const [, id, modalities, tail] = match;
  if (capabilities.has(id)) {
    continue;
  }
  capabilities.set(id, {
    vision: modalities.includes('"image"'),
    // Absent `reasoning` is how the catalog expresses "no reasoning"; the only
    // literal false in the bundle is unrelated BYOK code.
    reasoning: /reasoning:!0/.test(tail) || /reasoningEfforts:\[/.test(tail),
  });
}

if (capabilities.size === 0) {
  console.error('Matched no catalog entries — the CLI bundle shape may have changed.');
  console.error('Do not hand-edit catalog.ts instead; fix the pattern and re-run.');
  process.exit(1);
}

const visionCount = [...capabilities.values()].filter((c) => c.vision).length;
console.error(
  `Parsed ${capabilities.size} models from ${cliPath} — ${visionCount} with vision.`,
);

// Cross-check against the extension's own catalog so drift is visible here,
// not only in a test run.
const catalogSrc = readFileSync(new URL('../src/catalog.ts', import.meta.url), 'utf8');
const catalogIds = [...catalogSrc.matchAll(/^\s*id: '([^']+)',/gm)].map((m) => m[1]);
const missing = catalogIds.filter((id) => !capabilities.has(id));
const extra = [...capabilities.keys()].filter((id) => !catalogIds.includes(id));

console.error(`\nExtension catalog: ${catalogIds.length} models.`);
if (missing.length > 0) {
  console.error(`\nNOT in the CLI catalog (${missing.length}) — vision defaults to false:`);
  for (const id of missing) console.error(`  ${id}`);
}
if (extra.length > 0) {
  console.error(`\nIn the CLI catalog but not shipped (${extra.length}) — not added:`);
  for (const id of extra) console.error(`  ${id}`);
}

// Report the prose disagreements that make a regex approach wrong.
const blurbSaysVision = catalogIds.filter((id) => {
  const m = new RegExp(`id: '${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',[\\s\\S]{0,300}?blurb: '[^']*vision`, 'i');
  return m.test(catalogSrc);
});
const mislabelled = blurbSaysVision.filter((id) => !capabilities.get(id)?.vision);
if (mislabelled.length > 0) {
  console.error(
    `\nProse/data disagreements (${mislabelled.length}) — a blurb regex would get these wrong:`,
  );
  for (const id of mislabelled) console.error(`  says vision, catalog says text-only: ${id}`);
}

if (!shouldWrite) {
  console.error('\nDry run. Pass --write to rewrite src/catalog.ts.');
  process.exit(0);
}

// Rewrite: insert the two flags after the `id:` line of every entry.
const updated = catalogSrc.replace(
  /^(\s*id: '[^']+',\n)/gm,
  (line, idLine) => {
    const id = idLine.match(/id: '([^']+)'/)[1];
    const cap = capabilities.get(id);
    if (!cap) {
      return line;
    }
    return `${line}    vision: ${cap.vision},\n    reasoning: ${cap.reasoning},\n`;
  },
);

writeFileSync(new URL('../src/catalog.ts', import.meta.url), updated);
console.error('\nRewrote src/catalog.ts with per-model vision and reasoning.');
