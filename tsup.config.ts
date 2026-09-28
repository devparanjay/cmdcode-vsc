import { defineConfig } from 'tsup';

// `vscode` is provided by the extension host and must never be bundled.
export default defineConfig({
  entry: ['src/extension.ts'],
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  clean: true,
  treeshake: true,
});
