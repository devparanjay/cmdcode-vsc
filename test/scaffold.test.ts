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
  readonly main: string;
  readonly license: string;
  readonly engines: Readonly<Record<string, string>>;
  readonly activationEvents: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly contributes: {
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
  'cmdcode.showThinkingPlaceholder': { type: 'boolean', default: true },
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
    expect(manifest.activationEvents).toEqual(['onStartupFinished']);
    // SPDX id; `vsce` validates this field and fails packaging on an unknown value.
    expect(manifest.license).toBe('AGPL-3.0-or-later');
  });

  it('names the vsix file cmdcode.cmd-code-vsc', () => {
    expect(manifest.name).toBe('cmdcode');
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
      expect(contribution.title.startsWith('Cmd Code:')).toBe(true);
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

    expect(stub.window.createOutputChannel('Cmd Code').name).toBe('Cmd Code');
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
