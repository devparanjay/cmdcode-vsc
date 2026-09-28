import * as vscode from 'vscode';

import {
  DEFAULT_CONTEXT_TOKENS,
  MAX_OUTPUT_TOKENS,
  chatIdFor,
} from './catalog.js';
import { ADAPTER_VERSION, type CatalogModel } from './types.js';

// This module exists for exactly one reason: it owns the `vscode` import
// (architecture §3.1) so `catalog.ts` stays data plus pure functions and
// remains importable by a plain vitest run with no extension host and no stub.
//
// The projection is deliberately total, synchronous and I/O-free. The model
// picker is populated on every refresh and must never block on a subprocess, so
// nothing here reads a file, resolves a CLI or awaits anything.

/** Opaque per-API family label. VS Code only groups by it; it is not a route. */
const FAMILY = 'cmdcode';

/**
 * v1 renders text only and never calls tools from the model side (architecture
 * §D5), so both capabilities are declined — advertising them optimistically
 * would make Copilot send parts this adapter drops.
 */
const CAPABILITIES = Object.freeze({ imageInput: false, toolCalling: false });

/**
 * Render catalog entries as VS Code `LanguageModelChatInformation` objects.
 *
 * @param models          catalog slice; the output preserves this order
 * @param workspaceFsPath stable per-workspace salt for the model id (§D2)
 */
export function toChatInformation(
  models: readonly CatalogModel[],
  workspaceFsPath: string,
): vscode.LanguageModelChatInformation[] {
  return models.map((model) => ({
    id: chatIdFor(model.id, workspaceFsPath),
    name: model.name,
    family: FAMILY,
    version: ADAPTER_VERSION,
    // The plan tier is a hint for the user, never a gate (§5.2).
    detail: `${model.id} · ${model.minPlan.toUpperCase()} and above`,
    tooltip: model.blurb,
    // `—` transcribes to 0; substitute the CLI's documented default (§4.7).
    maxInputTokens: model.contextWindow > 0 ? model.contextWindow : DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    capabilities: CAPABILITIES,
  }));
}
