import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bare specifier — the same resolution `src/extension.ts` performs via the
// vitest alias. Both land on `test/vscode-stub.ts`; the spies below mutate the
// stub's plain-object namespaces, which is why the stub is a set of exported
// objects rather than frozen bindings.
import * as vscode from 'vscode';

import { registerCommands, lastRunOf, type LastRun } from '../src/commands.js';
import { CmdCodeChatProvider } from '../src/chat-provider.js';
import { MODELS } from '../src/catalog.js';
import { activate, deactivate } from '../src/extension.js';
import { FakeTransport } from './fake-transport.js';
import { TranscriptStore } from '../src/transcript.js';
import {
  CONFIG_DEFAULTS,
  VENDOR_ID,
  type CliTransport,
  type Logger,
  type RunSummary,
} from '../src/types.js';

// The resolver is the only subprocess in the activation path, so it is the only
// thing that must be faked. `vi.mock` replaces the module for every importer,
// and no other module re-exports those symbols.
vi.mock('../src/cli/resolve.js', () => ({
  resolveCli: vi.fn(),
  supportsJsonOutput: vi.fn(),
}));

// Imported after the mock declaration so the mocked bindings are the ones used.
import { resolveCli, supportsJsonOutput, type ResolvedCli } from '../src/cli/resolve.js';

const RESOLVED: ResolvedCli = {
  // A path that does not exist: `copyDiagnostics` probes `<cli> --version`, and
  // ENOENT makes that probe answer from the error path without running anything.
  command: '/nonexistent/cmd',
  args: [],
  source: 'path',
};

const COMMAND_IDS = ['cmdcode.showLog', 'cmdcode.copyDiagnostics', 'cmdcode.restartProvider'];

// ─── Observation ─────────────────────────────────────────────────────────────
// Everything below records what the code under test did. The stub is inert by
// design, so the tests attach spies rather than extending the shared stub: no
// namespace member is missing here, only observability, and a spy cannot leak
// into another file the way a stub mutation would.

interface Recorder {
  readonly providers: string[];
  readonly commands: Map<string, (...args: unknown[]) => unknown>;
  readonly errors: string[];
  readonly infos: string[];
  readonly clipboard: string[];
  readonly channels: { name: string; shown: (boolean | undefined)[] }[];
  readonly subscriptions: { dispose(): void }[];
}

let recorder: Recorder;

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: recorder.subscriptions,
    workspaceState: { get: () => undefined, update: () => Promise.resolve() },
    globalState: { get: () => undefined, update: () => Promise.resolve() },
    extensionPath: '/ext',
    extensionUri: vscode.Uri.file('/ext'),
    environmentVariableCollection: { replace: () => {} },
    asAbsolutePath: (relative: string) => `/ext/${relative}`,
    storageUri: undefined,
    globalStorageUri: vscode.Uri.file('/ext/storage'),
    logUri: vscode.Uri.file('/ext/log'),
    extensionMode: 2,
    secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve(), onDidChange: new vscode.EventEmitter<unknown>().event },
  } as unknown as vscode.ExtensionContext;
}

function silentLogger(): Logger {
  return {
    error: (message: string) => {
      recorder.infos.push(message);
    },
    info: (message: string) => {
      recorder.infos.push(message);
    },
    debug: () => {},
    show: () => {},
  };
}

/** The setting table `workspace.getConfiguration('cmdcode')` will report. */
let settings: Readonly<Record<string, unknown>> = {};

/** Runs a command the extension registered, by id. */
async function runCommand(id: string): Promise<unknown> {
  const callback = recorder.commands.get(id);
  if (callback === undefined) {
    throw new Error(`command ${id} was never registered`);
  }
  return callback();
}

beforeEach(() => {
  recorder = {
    providers: [],
    commands: new Map(),
    errors: [],
    infos: [],
    clipboard: [],
    channels: [],
    subscriptions: [],
  };
  settings = {};

  vi.spyOn(vscode.lm, 'registerLanguageModelChatProvider').mockImplementation((vendor) => {
    recorder.providers.push(vendor);
    return { dispose: () => {} };
  });

  vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, callback) => {
    recorder.commands.set(id, callback as (...args: unknown[]) => unknown);
    return { dispose: () => {} };
  });

  vi.spyOn(vscode.window, 'createOutputChannel').mockImplementation(((name: string) => {
    const entry = { name, shown: [] as (boolean | undefined)[] };
    recorder.channels.push(entry);
    return {
      name,
      append: () => {},
      appendLine: () => {},
      show: (preserveFocus?: boolean) => {
        entry.shown.push(preserveFocus);
      },
      hide: () => {},
      clear: () => {},
      replace: () => {},
      dispose: () => {},
    };
    // The stub's OutputChannel is structurally narrower than @types/vscode's
    // LogOutputChannel; only the members extension.ts calls are needed here.
  }) as unknown as typeof vscode.window.createOutputChannel);

  vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation((message: string) => {
    recorder.errors.push(message);
    return Promise.resolve(undefined);
  });

  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((message: string) => {
    recorder.infos.push(message);
    return Promise.resolve(undefined);
  });

  vi.spyOn(vscode.env.clipboard, 'writeText').mockImplementation((value: string) => {
    recorder.clipboard.push(value);
    return Promise.resolve();
  });

  vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(((section?: string) => {
    if (section !== 'cmdcode') {
      throw new Error(`configuration read from the wrong section: ${String(section)}`);
    }
    return {
      get: <T>(key: string, fallback?: T): T | undefined => {
        const value = settings[key];
        return (value === undefined ? fallback : value) as T | undefined;
      },
      has: (key: string) => settings[key] !== undefined,
      update: () => Promise.resolve(),
    };
    // `inspect` and the scope argument are declared by @types/vscode but unused
    // by readConfig, and absent from the stub; the cast keeps this a spy on the
    // stub rather than a widening of the stub itself.
  }) as unknown as typeof vscode.workspace.getConfiguration);

  vi.mocked(resolveCli).mockReset().mockResolvedValue(RESOLVED);
  vi.mocked(supportsJsonOutput).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setWorkspaceFolders(null);
});

/** The diagnostics bundle, parsed out of the clipboard. */
function lastBundle(): Record<string, unknown> {
  const text = recorder.clipboard.at(-1);
  if (text === undefined) {
    throw new Error('copyDiagnostics wrote nothing to the clipboard');
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * A transport that keeps the outcome `extension.ts`'s `RecordingTransport` keeps,
 * without an activation. `describe()` names a path that exists in neither the
 * filesystem nor the tests' PATH, so the `--version` probe inside
 * `copyDiagnostics` exercises its failure branch deterministically.
 */
function transportWithLastRun(last: LastRun): CliTransport {
  const transport = new FakeTransport() as FakeTransport & { lastRun(): LastRun };
  transport.lastRun = () => last;
  return transport as unknown as CliTransport;
}

/** A provider that records refreshes rather than serving a model list. */
function stubProvider(): CmdCodeChatProvider {
  return { refreshModelInformation: () => {} } as unknown as CmdCodeChatProvider;
}

/**
 * Sets the open workspace folder, or clears it with `null`.
 *
 * @types/vscode declares `workspaceFolders` readonly, and the stub mirrors that
 * by exporting a mutable object property. The cast is the seam between the two
 * descriptions of the same member.
 */
function setWorkspaceFolders(fsPath: string | null): void {
  (
    vscode.workspace as { workspaceFolders?: ReadonlyArray<{ uri: vscode.Uri; name: string; index: number }> }
  ).workspaceFolders =
    fsPath === null
      ? undefined
      : [{ uri: vscode.Uri.file(fsPath), name: 'ws', index: 0 }];
}

// ─── Activation ──────────────────────────────────────────────────────────────

describe('activate', () => {
  it('registers one provider under VENDOR_ID and the three commands', async () => {
    await activate(makeContext());

    expect(recorder.providers).toEqual([VENDOR_ID]);
    expect([...recorder.commands.keys()].sort()).toEqual([...COMMAND_IDS].sort());
    expect(recorder.errors).toEqual([]);
  });

  it('pushes every disposable it creates to context.subscriptions', async () => {
    const context = makeContext();
    await activate(context);

    // 1 channel + 1 provider registration + 3 commands.
    expect(context.subscriptions).toHaveLength(5);
    for (const subscription of context.subscriptions) {
      expect(subscription.dispose).toBeTypeOf('function');
    }
  });

  it('creates the output channel first, so the degraded paths have somewhere to log', async () => {
    vi.mocked(resolveCli).mockResolvedValue(null);
    await activate(makeContext());

    expect(recorder.channels).toHaveLength(1);
    expect(recorder.channels[0].name).toBe('Command Code');
    expect(recorder.subscriptions[0].dispose).toBeTypeOf('function');
  });

  it('reads configuration exactly once, from the cmdcode section', async () => {
    await activate(makeContext());
    expect(vscode.workspace.getConfiguration).toHaveBeenCalledTimes(1);
    expect(vi.mocked(vscode.workspace.getConfiguration).mock.calls[0][0]).toBe('cmdcode');
  });

  it('resolves the CLI before probing it, passing the configured path through', async () => {
    settings = { cliPath: '/opt/cmd' };
    await activate(makeContext());

    expect(vi.mocked(resolveCli).mock.calls[0][0]).toBe('/opt/cmd');
    expect(vi.mocked(supportsJsonOutput).mock.calls[0][0]).toBe(RESOLVED);
  });

  it('probes with the resolved CLI, never with a path, when cliPath is empty', async () => {
    await activate(makeContext());
    // An empty cliPath means auto-resolve, so the resolver is called undefined.
    expect(vi.mocked(resolveCli).mock.calls[0][0]).toBeUndefined();
  });

  it('deactivate is a no-op that does not throw', () => {
    expect(() => {
      deactivate();
    }).not.toThrow();
  });
});

// ─── The two degraded paths — the point of the issue ────────────────────────

describe('activate when resolveCli returns null', () => {
  it('shows the install hint, registers nothing, and does not throw', async () => {
    vi.mocked(resolveCli).mockResolvedValue(null);

    await expect(activate(makeContext())).resolves.toBeUndefined();

    expect(recorder.errors).toEqual([
      'Command Code CLI not found. Install it with `npm i -g command-code`, or set `cmdcode.cliPath`.',
    ]);
    // The negative assertion: a provider whose every request fails is worse
    // than no provider at all.
    expect(recorder.providers).toEqual([]);
    expect(recorder.commands.size).toBe(0);
  });

  it('does not capability-probe, because there is nothing to probe', async () => {
    vi.mocked(resolveCli).mockResolvedValue(null);
    await activate(makeContext());
    expect(supportsJsonOutput).not.toHaveBeenCalled();
  });
});

describe('activate when the JSON capability probe fails', () => {
  it('shows the too-old message, registers nothing, and does not throw', async () => {
    vi.mocked(supportsJsonOutput).mockResolvedValue(false);

    await expect(activate(makeContext())).resolves.toBeUndefined();

    expect(recorder.errors).toEqual([
      'This Command Code CLI is too old. Update it with `npm i -g command-code@latest`.',
    ]);
    expect(recorder.providers).toEqual([]);
    expect(recorder.commands.size).toBe(0);
  });
});

describe('activate resilience', () => {
  it('degrades to cli-not-found when the resolver throws', async () => {
    vi.mocked(resolveCli).mockRejectedValue(new Error('EACCES'));
    await expect(activate(makeContext())).resolves.toBeUndefined();
    expect(recorder.providers).toEqual([]);
    expect(recorder.errors[0]).toContain('Command Code CLI not found');
  });

  it('degrades to cli-too-old when the probe throws', async () => {
    vi.mocked(supportsJsonOutput).mockRejectedValue(new Error('spawn failed'));
    await expect(activate(makeContext())).resolves.toBeUndefined();
    expect(recorder.providers).toEqual([]);
    expect(recorder.errors[0]).toContain('too old');
  });
});

// ─── readConfig clamps (architecture 6.1) ────────────────────────────────────

/**
 * Each row is one raw settings table; the assertion is on the `config` object
 * the diagnostics bundle reports, i.e. the exact `CmdCodeConfig` that reached
 * the provider. Reading it through the clipboard rather than exporting
 * `readConfig` keeps the function private, as §4.11 requires.
 */
const CLAMP_TABLE: ReadonlyArray<{
  readonly name: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly expected: Partial<typeof CONFIG_DEFAULTS>;
}> = [
  {
    name: 'an empty table yields the documented defaults',
    settings: {},
    expected: { ...CONFIG_DEFAULTS },
  },
  {
    name: 'maxTurns below 1 clamps up to 1',
    settings: { maxTurns: -5 },
    expected: { maxTurns: 1 },
  },
  {
    name: 'maxTurns of 0 clamps up to 1, not down to 0',
    settings: { maxTurns: 0 },
    expected: { maxTurns: 1 },
  },
  {
    name: 'maxTurns rounds before clamping',
    settings: { maxTurns: 24.4 },
    expected: { maxTurns: 24 },
  },
  {
    name: 'maxTurns above 100 clamps down to 100',
    settings: { maxTurns: 10_000 },
    expected: { maxTurns: 100 },
  },
  {
    name: 'a non-finite maxTurns falls back to the default',
    settings: { maxTurns: Number.NaN },
    expected: { maxTurns: CONFIG_DEFAULTS.maxTurns },
  },
  {
    name: 'a null maxTurns is non-numeric and falls back',
    settings: { maxTurns: null },
    expected: { maxTurns: CONFIG_DEFAULTS.maxTurns },
  },
  {
    name: 'timeoutSeconds is converted to milliseconds',
    settings: { timeoutSeconds: 30 },
    expected: { timeoutMs: 30_000 },
  },
  {
    name: 'timeoutSeconds of 0 is the "no deadline" sentinel and stays 0',
    settings: { timeoutSeconds: 0 },
    expected: { timeoutMs: 0 },
  },
  {
    name: 'a negative timeoutSeconds clamps to 0, not to a negative deadline',
    settings: { timeoutSeconds: -30 },
    expected: { timeoutMs: 0 },
  },
  {
    name: 'a non-finite timeoutSeconds falls back to the default',
    settings: { timeoutSeconds: Number.POSITIVE_INFINITY },
    expected: { timeoutMs: CONFIG_DEFAULTS.timeoutMs },
  },
  {
    name: 'maxPromptChars below 1000 clamps up, so the envelope survives',
    settings: { maxPromptChars: 0 },
    expected: { maxPromptChars: 1_000 },
  },
  {
    name: 'maxPromptChars just under the floor clamps to the floor',
    settings: { maxPromptChars: 999 },
    expected: { maxPromptChars: 1_000 },
  },
  {
    name: 'a non-finite maxPromptChars falls back to the default',
    settings: { maxPromptChars: Number.NaN },
    expected: { maxPromptChars: CONFIG_DEFAULTS.maxPromptChars },
  },
  {
    name: 'cliPath is trimmed so a pasted newline still resolves',
    settings: { cliPath: '  /usr/local/bin/cmd\n' },
    expected: { cliPath: '/usr/local/bin/cmd' },
  },
  {
    name: 'a whitespace-only cliPath reads as auto-resolve',
    settings: { cliPath: '   ' },
    expected: { cliPath: '' },
  },
  {
    name: 'the log level passes through unclamped',
    settings: { logLevel: 'verbose' },
    expected: { logLevel: 'verbose' },
  },
];

describe('readConfig', () => {
  for (const row of CLAMP_TABLE) {
    it(row.name, async () => {
      settings = row.settings;
      await activate(makeContext());
      await runCommand('cmdcode.copyDiagnostics');

      const config = lastBundle()['config'] as Record<string, unknown>;
      for (const [key, value] of Object.entries(row.expected)) {
        expect(config[key], `${key} of ${row.name}`).toEqual(value);
      }
    });
  }

  it('applies the clamps at the single getConfiguration call site, and nowhere else', async () => {
    settings = { maxTurns: 9_999, timeoutSeconds: -1, maxPromptChars: 10 };
    await activate(makeContext());
    await runCommand('cmdcode.copyDiagnostics');

    expect(vscode.workspace.getConfiguration).toHaveBeenCalledTimes(1);
    const config = lastBundle()['config'] as Record<string, unknown>;
    expect(config['maxTurns']).toBe(100);
    expect(config['timeoutMs']).toBe(0);
    expect(config['maxPromptChars']).toBe(1_000);
  });

  it('survives a workspace with no folder open', async () => {
    setWorkspaceFolders(null);
    await expect(activate(makeContext())).resolves.toBeUndefined();
    expect(recorder.providers).toEqual([VENDOR_ID]);
  });
});

// ─── Commands ────────────────────────────────────────────────────────────────

describe('cmdcode.showLog', () => {
  it('reveals the channel without stealing editor focus', async () => {
    await activate(makeContext());
    await runCommand('cmdcode.showLog');

    expect(recorder.channels).toHaveLength(1);
    expect(recorder.channels[0].shown).toEqual([true]);
  });
});

describe('cmdcode.copyDiagnostics', () => {
  it('writes the resolved CLI, the version, the config, the catalog length and the last run', async () => {
    const summary: RunSummary = {
      sessionId: 'ab4c5b22-7d1e-4f0a-9c3b-5e6d7a8b9c01',
      text: 'PONG',
      usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 3060,
      stopReason: 'end_turn',
    };
    const transport = transportWithLastRun({ summary, errorCode: null });

    registerCommands(
      makeContext(),
      stubProvider(),
      transport,
      silentLogger(),
      vscode.window.createOutputChannel('Command Code'),
      RESOLVED,
      CONFIG_DEFAULTS,
    );
    await runCommand('cmdcode.copyDiagnostics');

    const bundle = lastBundle();
    // The resolved CLI, as the transport reports it via `describe()`.
    expect(bundle['cli']).toBe('fake');
    // The version probe targets the resolved command with `--version`; that path
    // does not exist, so the probe reports the failure instead of throwing.
    expect(String(bundle['version'])).toMatch(/^unknown \(/);
    // The whole CmdCodeConfig, verbatim, so a bug report carries the values the
    // extension was actually running with.
    expect(bundle['config']).toEqual(CONFIG_DEFAULTS);
    expect(bundle['models']).toBe(MODELS.length);
    expect(bundle['lastRun']).toEqual({
      sessionId: summary.sessionId,
      usage: summary.usage,
      durationMs: summary.durationMs,
    });
    expect(bundle['lastError']).toBeNull();
  });

  it('confirms with an information message after writing the clipboard', async () => {
    await activate(makeContext());
    recorder.infos.length = 0;

    await runCommand('cmdcode.copyDiagnostics');

    expect(recorder.clipboard).toHaveLength(1);
    expect(recorder.infos).toContain('Command Code diagnostics copied.');
  });

  it('reports the last CliError code, and no run, when the last run failed', async () => {
    await activate(makeContext());
    registerCommands(
      makeContext(),
      stubProvider(),
      transportWithLastRun({ summary: null, errorCode: 'rate-limited' }),
      silentLogger(),
      vscode.window.createOutputChannel('Command Code'),
      RESOLVED,
      CONFIG_DEFAULTS,
    );
    await runCommand('cmdcode.copyDiagnostics');

    const bundle = lastBundle();
    expect(bundle['lastError']).toBe('rate-limited');
    expect(bundle['lastRun']).toBeNull();
  });

  it('reports an absent run rather than a fabricated one when nothing has run', async () => {
    await activate(makeContext());
    await runCommand('cmdcode.copyDiagnostics');

    const bundle = lastBundle();
    expect(bundle['lastRun']).toBeNull();
    expect(bundle['lastError']).toBeNull();
  });
});

describe('lastRunOf', () => {
  it('reads the recorded outcome when the transport keeps one', () => {
    const summary: RunSummary = {
      sessionId: 'sess-1',
      text: 'PONG',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1,
      stopReason: null,
    };
    const transport = transportWithLastRun({ summary, errorCode: null });
    expect(lastRunOf(transport)).toEqual({ summary, errorCode: null });
  });

  it('reports an empty outcome for a transport that keeps none', () => {
    expect(lastRunOf(new FakeTransport())).toEqual({ summary: null, errorCode: null });
  });
});

describe('cmdcode.restartProvider', () => {
  it('fires the change event so VS Code re-queries, without reloading anything', async () => {
    // A real provider, so the assertion is on the event VS Code actually
    // subscribes to rather than on a spy standing in for it.
    const transport = new FakeTransport();
    const provider = new CmdCodeChatProvider(
      MODELS,
      transport,
      new TranscriptStore(),
      silentLogger(),
      '/Users/paranjay/dev/cmdcode-vsc',
      CONFIG_DEFAULTS,
    );

    let fired = 0;
    const subscription = provider.onDidChangeLanguageModelChatInformation?.(() => {
      fired += 1;
    });

    registerCommands(
      makeContext(),
      provider,
      transport,
      silentLogger(),
      vscode.window.createOutputChannel('Command Code'),
      RESOLVED,
      CONFIG_DEFAULTS,
    );

    await runCommand('cmdcode.restartProvider');
    expect(fired).toBe(1);

    // A re-query, not a reload: no request was run and nothing was re-read.
    expect(transport.requests).toEqual([]);
    expect(transport.describeCount).toBe(0);
    expect(recorder.clipboard).toEqual([]);
    subscription?.dispose();
  });
});

describe('command namespace', () => {
  it('uses cmdcode.* ids and never collides with the vendor commandcode.* namespace', async () => {
    await activate(makeContext());
    for (const id of recorder.commands.keys()) {
      expect(id.startsWith('cmdcode.')).toBe(true);
      expect(id.startsWith('commandcode.')).toBe(false);
    }
  });

  it('pushes each command registration to context.subscriptions', async () => {
    const context = makeContext();
    await activate(context);
    expect(context.subscriptions).toHaveLength(5);
  });
});
