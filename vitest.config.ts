const { resolve } = require('node:path');
const { defineConfig } = require('vitest/config');

// Written in CJS because the extension is CommonJS (`main: ./dist/extension.js`)
// and the package deliberately has no `"type": "module"`. A future Vite release
// loads `.ts` configs natively, at which point this can become an ESM default
// export without changing anything else.
module.exports = defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    extensions: ['.ts', '.js'],
    // `import * as vscode from 'vscode'` is unresolvable outside the extension
    // host, so every specifier of that name lands on the test stub. This is a
    // runtime alias only; `tsc` keeps typing `src/` from @types/vscode.
    alias: {
      vscode: resolve(__dirname, 'test/vscode-stub.ts'),
    },
  },
});
