/**
 * `vscode` test stub.
 *
 * `import * as vscode from 'vscode'` is unresolvable outside the extension host,
 * so `vitest.config.ts` aliases the bare specifier to this module. It is the
 * single place the vscode surface is faked: no test or source file may add a
 * shim of its own.
 *
 * Scope: every class and namespace the architecture names — the exported value
 * parts, `EventEmitter`, `Progress`, `Uri`, and the `lm` / `window` / `commands`
 * / `workspace` / `env` namespaces.
 *
 * Everything is inert: nothing here writes to a real terminal, reads the
 * clipboard, or resolves a configuration key against a real settings file. The
 * fakes are minimal, but complete enough that the whole project compiles and
 * tests against them.
 */

// ─── Value parts ─────────────────────────────────────────────────────────────

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelDataPart {
  value: unknown;
  mimeType?: string;

  constructor(value: Uint8Array, mimeType?: string) {
    this.value = value;
    this.mimeType = mimeType;
  }
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (event: T) => unknown) => Disposable;

export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();
  private disposed = false;

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(data: T): void {
    if (this.disposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

// ─── Progress ────────────────────────────────────────────────────────────────

export class Progress<T> {
  report(_value: T): void {}
}

// ─── Uri ─────────────────────────────────────────────────────────────────────

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}

  static file(path: string): Uri {
    return new Uri('file', '', path, '', '');
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (match === null) {
      return Uri.file(value);
    }
    return new Uri(match[1], match[2] ?? '', match[3] ?? '', match[4] ?? '', match[5] ?? '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/+$/, ''), ...segments].join('/');
    return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    const query = this.query === '' ? '' : `?${this.query}`;
    const fragment = this.fragment === '' ? '' : `#${this.fragment}`;
    return `${this.scheme}://${this.authority}${this.path}${query}${fragment}`;
  }
}

// ─── Disposable helpers ──────────────────────────────────────────────────────

export function disposeAll(disposables: Disposable[]): void {
  while (disposables.length > 0) {
    disposables.pop()?.dispose();
  }
}

// ─── window ──────────────────────────────────────────────────────────────────

export interface OutputChannel {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  clear(): void;
  replace(value: string): void;
  dispose(): void;
}

export class MessageItem {
  constructor(public title: string) {}
}

export const window = {
  createOutputChannel(name: string): OutputChannel {
    return {
      name,
      append: () => {},
      appendLine: () => {},
      show: () => {},
      hide: () => {},
      clear: () => {},
      replace: () => {},
      dispose: () => {},
    };
  },
  showErrorMessage(_message: string, ..._items: unknown[]): Promise<undefined> {
    return Promise.resolve(undefined);
  },
  showInformationMessage(_message: string, ..._items: unknown[]): Promise<undefined> {
    return Promise.resolve(undefined);
  },
  showWarningMessage(_message: string, ..._items: unknown[]): Promise<undefined> {
    return Promise.resolve(undefined);
  },
};

// ─── commands ────────────────────────────────────────────────────────────────

export const commands = {
  registerCommand(
    _command: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _callback: (...args: any[]) => unknown,
  ): Disposable {
    return { dispose: () => {} };
  },
  registerTextEditorCommand(
    _command: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _callback: (...args: any[]) => unknown,
  ): Disposable {
    return { dispose: () => {} };
  },
  executeCommand<T>(_command: string, ..._args: unknown[]): Promise<T | undefined> {
    return Promise.resolve(undefined);
  },
  getCommands(): Promise<string[]> {
    return Promise.resolve([]);
  },
};

// ─── workspace ───────────────────────────────────────────────────────────────

export interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined;
  get<T>(section: string, defaultValue: T): T;
  has(section: string): boolean;
  update(section: string, value: unknown): Promise<void>;
}

function configurationOf(values: Readonly<Record<string, unknown>>): WorkspaceConfiguration {
  return {
    get: <T>(section: string, defaultValue?: T): T | undefined => {
      const value = values[section];
      return (value === undefined ? defaultValue : value) as T | undefined;
    },
    has: (section: string): boolean => values[section] !== undefined,
    update: () => Promise.resolve(),
  };
}

export const workspace = {
  getConfiguration(_section?: string): WorkspaceConfiguration {
    return configurationOf({});
  },
  workspaceFolders: undefined as
    | ReadonlyArray<{ uri: Uri; name: string; index: number }>
    | undefined,
  onDidChangeConfiguration: new EventEmitter<unknown>().event,
};

// ─── env ─────────────────────────────────────────────────────────────────────

export const env = {
  clipboard: {
    readText: (): Promise<string> => Promise.resolve(''),
    writeText: (_value: string): Promise<void> => Promise.resolve(),
  },
  appName: 'Visual Studio Code',
  language: 'en',
  machineId: 'test-machine',
  sessionId: 'test-session',
  uiKind: 1,
  remoteName: undefined as string | undefined,
};

// ─── lm ──────────────────────────────────────────────────────────────────────

export const lm = {
  registerLanguageModelChatProvider(
    _vendor: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _provider: any,
  ): Disposable {
    return { dispose: () => {} };
  },
  tools: [] as unknown[],
  invokeTool(): Promise<unknown> {
    return Promise.resolve(undefined);
  },
  onDidChangeChatModels: new EventEmitter<unknown>().event,
};
