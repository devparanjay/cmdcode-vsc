// Opt-in sanity check: run the module's own `resolveCli` + `supportsJsonOutput`
// against the Command Code CLI actually installed on this machine.
//
// The vitest suite deliberately spawns no real binary — every executable there
// is a fake. That is the right default (a real probe costs a 0.65 s node boot
// and the vendor's own boot-time write), but it is also how the previous
// argv-echo probe shipped green while returning false for every real install.
// This script is the cheap end-to-end confirmation, run by hand or in CI on a
// machine that has `command-code` installed:
//
//   npm run check:real-cli          → prints the verdict, exits 0
//   no `cmd` on PATH                → prints SKIP, exits 0
//   CLI without the flag            → prints FAIL, exits 1
//
// It is deliberately not part of `npm run check`, which must stay hermetic.
// Run directly with node 24+ (type stripping), or `npx tsx` on anything older.

import { execFileSync } from 'node:child_process';

import { resolveCli, supportsJsonOutput } from '../src/cli/resolve.ts';

const resolved: Awaited<ReturnType<typeof resolveCli>> = await resolveCli(
  process.env.CMDCODE_CLI_PATH,
);

if (resolved === null) {
  console.log('SKIP  no Command Code CLI found (no cmdcode.cliPath, nothing on PATH)');
  process.exit(0);
}

const supported = await supportsJsonOutput(resolved);
let version = '(unavailable)';
try {
  version = execFileSync(resolved.command, [...resolved.args, '--version'], {
    encoding: 'utf8',
    timeout: 5_000,
  }).trim();
} catch {
  // Reporting the version is a nicety; the probe result is the verdict.
}

console.log(`cmd      ${[resolved.command, ...resolved.args].join(' ')}`);
console.log(`source   ${resolved.source}`);
console.log(`version  ${version}`);
console.log(`json     ${supported ? 'supported' : 'NOT supported'}`);

if (!supported) {
  console.error('FAIL  the located CLI does not declare --output-format json');
  process.exit(1);
}
console.log('OK      the located CLI declares --output-format json');
