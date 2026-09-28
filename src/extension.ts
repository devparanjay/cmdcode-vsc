import type * as vscode from 'vscode';

/**
 * Scaffold entry point. The provider registration, configuration read and
 * command wiring land in a later issue; until then activation is a no-op that
 * still exports the two symbols VS Code requires.
 */
export async function activate(_context: vscode.ExtensionContext): Promise<void> {}

export function deactivate(): void {}
