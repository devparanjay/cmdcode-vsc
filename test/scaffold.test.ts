import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The bare specifier — resolved by the vitest alias to the stub, exactly as
// `src/prompt.ts`, `src/catalog-to-chat.ts` and `src/chat-provider.ts` do.
// TypeScript still types it from @types/vscode; the runtime assertions below
// use the stub's own declaration so the stub-only shims stay reachable.
import * as vscode from 'vscode';

import * as stub from './vscode-stub.js';

interface Manifest {
  readonly name: string;
  readonly publisher: string;
  readonly displayName: string;
  readonly main: string;
  readonly license: string;
  readonly engines: Readonly<Record<string, string>>;
  readonly activationEvents: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly contributes: {
    readonly languageModelChatProviders: ReadonlyArray<{ vendor: string; displayName: string }>;
    readonly commands: ReadonlyArray<{ command: string; title: string }>;
    readonly configuration: {
      readonly properties: Readonly<Record<string, { type: string; default: unknown }>>;
    };
  };
}

const manifest: Manifest = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
);

/** Architecture §6.1 — the six settings, their types and their defaults. */
const CONFIG_DEFAULTS: Readonly<Record<string, { type: string; default: unknown }>> = {
  'cmdcode.cliPath': { type: 'string', default: '' },
  'cmdcode.maxTurns': { type: 'number', default: 24 },
  'cmdcode.timeoutSeconds': { type: 'number', default: 600 },
  'cmdcode.maxPromptChars': { type: 'number', default: 900_000 },
  'cmdcode.logLevel': { type: 'string', default: 'normal' },
};

const COMMAND_IDS = [
  'cmdcode.showLog',
  'cmdcode.copyDiagnostics',
  'cmdcode.restartProvider',
] as const;

const properties = manifest.contributes.configuration.properties;

describe('extension manifest', () => {
  it('declares the engine, entry point, activation event and license', () => {
    expect(manifest.engines.vscode).toBe('^1.104.0');
    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.activationEvents).toEqual([
      'onStartupFinished',
      'onLanguageModelChatProvider:cmdcode',
    ]);
    // SPDX id; `vsce` validates this field and fails packaging on an unknown value.
    expect(manifest.license).toBe('AGPL-3.0-or-later');
  });

  it('publishes as devparanjay.command-code-provider', () => {
    // The marketplace identity. It is deliberately NOT the vendor id: the
    // provider registers under `cmdcode` (VENDOR_ID) while the extension ships
    // as `command-code-provider`, and the two must never be conflated.
    expect(manifest.publisher).toBe('devparanjay');
    expect(manifest.name).toBe('command-code-provider');
    expect(manifest.displayName).toBe('Command Code Provider');
  });

  it('contributes all six settings with the architecture 6.1 types and defaults', () => {
    for (const [key, expected] of Object.entries(CONFIG_DEFAULTS)) {
      const property = properties[key];
      expect(property, `missing configuration property ${key}`).toBeDefined();
      expect(property.type).toBe(expected.type);
      expect(property.default).toEqual(expected.default);
    }
    // timeoutSeconds is seconds, not milliseconds: 600 s, not 600_000.
    expect(properties['cmdcode.timeoutSeconds'].default).toBe(600);
    expect(Object.keys(properties).sort()).toEqual(Object.keys(CONFIG_DEFAULTS).sort());
  });

  it('contributes the three cmdcode.* commands and no commandcode.* id', () => {
    const ids = manifest.contributes.commands.map((c) => c.command);
    for (const id of COMMAND_IDS) {
      expect(ids).toContain(id);
    }
    expect(ids).toHaveLength(COMMAND_IDS.length);
    for (const contribution of manifest.contributes.commands) {
      expect(contribution.command.startsWith('commandcode.')).toBe(false);
      expect(contribution.title.startsWith('Command Code:')).toBe(true);
    }
  });

  /**
   * The vendor id the manifest declares is the vendor VS Code admits.
   *
   * VS Code holds an allowlist of LM vendors, and only the
   * `contributes.languageModelChatProviders` extension point populates it. A
   * `vscode.lm.registerLanguageModelChatProvider` call for a vendor that is not
   * on that list is rejected by the main process with
   * `Chat model provider uses UNKNOWN vendor <id>.` — so the extension activates,
   * logs success, and registers nothing.
   *
   * Nothing in `src/` can catch that: the id is a string literal compared to
   * nothing, and the failure happens in another process after `activate()`
   * resolves. This test is the only place the two halves meet.
   */
  it('contributes the vendor that VENDOR_ID registers under', async () => {
    const { VENDOR_ID } = await import('../src/types.js');
    const declared = manifest.contributes.languageModelChatProviders.map((p) => p.vendor);

    expect(declared, 'contributes.languageModelChatProviders is missing or empty').toContain(
      VENDOR_ID,
    );
  });

  it('declares exactly one vendor, with a display name', () => {
    const providers = manifest.contributes.languageModelChatProviders;
    expect(providers).toHaveLength(1);
    expect(providers[0].vendor).toBe('cmdcode');
    // The name Copilot Chat renders next to the model list, and the one the
    // picker groups by. The vendor id stays `cmdcode` — renaming the display
    // name must not orphan a model id, which is derived from VENDOR_ID.
    expect(providers[0].displayName).toBe('Command Code');
  });

  it('activates on the vendor event its own contribution generates', () => {
    expect(manifest.activationEvents).toContain('onLanguageModelChatProvider:cmdcode');
  });

  it('keeps the vendor id stable and distinct from the extension name', async () => {
    const { VENDOR_ID } = await import('../src/types.js');
    // VENDOR_ID is hashed into every `cmdc-` model id and is what VS Code keys
    // the provider by, so it is frozen. The marketplace name is free to change
    // and did (cmdcode → command-code-provider, publisher cmdcode → devparanjay);
    // conflating the two is exactly the mistake this test guards.
    expect(VENDOR_ID).toBe('cmdcode');
    expect(manifest.contributes.languageModelChatProviders[0].vendor).toBe(VENDOR_ID);
    expect(manifest.name).not.toBe(VENDOR_ID);
    expect(manifest.contributes.languageModelChatProviders[0].displayName).toBe('Command Code');
  });

  it('keeps the cmdcode.* settings and command namespace', async () => {
    // Renaming the marketplace identity must not renumber the user's settings
    // or their keybindings. These are ours, and they are stable API surface.
    const ids = manifest.contributes.commands.map((c) => c.command);
    for (const id of ['cmdcode.showLog', 'cmdcode.copyDiagnostics', 'cmdcode.restartProvider']) {
      expect(ids, `missing command ${id}`).toContain(id);
    }
    for (const key of Object.keys(manifest.contributes.configuration.properties)) {
      expect(key.startsWith('cmdcode.'), `${key} left the cmdcode.* namespace`).toBe(true);
    }
  });

  it('runs the two typechecks then vitest, in that order', () => {
    const check = manifest.scripts.check;
    expect(check).toContain('tsc -p tsconfig.json --noEmit');
    expect(check).toContain('tsc -p tsconfig.test.json --noEmit');
    expect(check).toContain('vitest run');
    expect(check.indexOf('tsconfig.json')).toBeLessThan(check.indexOf('tsconfig.test.json'));
    expect(check.indexOf('tsconfig.test.json')).toBeLessThan(check.indexOf('vitest run'));
  });
});

describe('vscode test stub', () => {
  it('resolves the bare specifier to the stub', async () => {
    // Fails loudly if vitest.config.ts ever drops the alias.
    const resolved = await import('vscode');
    expect(resolved).toBe(vscode);
    expect(vscode.LanguageModelTextPart).toBe(stub.LanguageModelTextPart);
    expect(vscode.EventEmitter).toBe(stub.EventEmitter);
  });

  it('constructs LanguageModelTextPart with its value', () => {
    const part = new stub.LanguageModelTextPart('hello');
    expect(part).toBeInstanceOf(stub.LanguageModelTextPart);
    expect(part.value).toBe('hello');
  });

  it('fires an EventEmitter and stops after dispose', () => {
    const emitter = new stub.EventEmitter<string>();
    const seen: string[] = [];
    const subscription = emitter.event((value) => seen.push(value));

    emitter.fire('first');
    expect(seen).toEqual(['first']);

    subscription.dispose();
    emitter.fire('second');
    expect(seen).toEqual(['first']);

    emitter.dispose();
    emitter.fire('third');
    expect(seen).toEqual(['first']);
  });

  it('exposes the namespace shims the project registers against', () => {
    expect(new stub.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png').mimeType).toBe(
      'image/png',
    );
    expect(stub.Uri.file('/tmp/ws').fsPath).toBe('/tmp/ws');
    expect(stub.Uri.joinPath(stub.Uri.file('/tmp'), 'AGENTS.md').path).toBe('/tmp/AGENTS.md');

    expect(stub.window.createOutputChannel('Command Code').name).toBe('Command Code');
    expect(stub.commands.registerCommand('cmdcode.showLog', () => {}).dispose).toBeTypeOf(
      'function',
    );
    expect(stub.workspace.getConfiguration('cmdcode').get('maxTurns', 24)).toBe(24);
    expect(stub.lm.registerLanguageModelChatProvider('cmdcode', {}).dispose).toBeTypeOf('function');
    expect(new stub.Progress<string>().report('x')).toBeUndefined();
  });

  it('keeps the clipboard and messages inert', async () => {
    await expect(stub.env.clipboard.writeText('x')).resolves.toBeUndefined();
    await expect(stub.env.clipboard.readText()).resolves.toBe('');
    await expect(stub.window.showErrorMessage('x')).resolves.toBeUndefined();
    await expect(stub.window.showInformationMessage('x')).resolves.toBeUndefined();
  });
});
