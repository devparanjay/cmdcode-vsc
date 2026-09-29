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
 * Advertised capabilities.
 *
 * `toolCalling: true` is required for a model to appear in Copilot's **Agent**
 * session at all. VS Code filters the model list with
 * `uZi(model, currentModeKind)`, which for `currentModeKind === "agent"`
 * demands `capabilities.toolCalling`; with it false every model in this
 * catalog is dropped before the picker renders. That gate was verified in the
 * shipped workbench (1.139.1), not inferred:
 *
 *   uZi: (s, kind) => kind === "agent" ? suitableForAgentMode(s.metadata) : true
 *   suitableForAgentMode: p => (p.capabilities?.agentMode ?? true) && !!p.capabilities?.toolCalling
 *
 * The flag is a true statement about the model: Command Code models *can* call
 * tools, and the CLI runs them. What this adapter does not do is let Copilot
 * drive them — it never emits `LanguageModelToolCallPart` and never reads
 * `options.tools`, because the CLI executes tools in-process rather than
 * yielding for a host. So Copilot sends no tool schemas, the CLI uses its own,
 * and the chat's tool UI stays quiet. Declining the flag instead would have
 * meant the models are unreachable in Agent mode.
 *
 * `imageInput: false` stays. `buildPrompt` renders text parts only, so an
 * image part would be silently discarded; advertising vision would be a lie
 * until the prompt path forwards `LanguageModelDataPart`.
 */
const CAPABILITIES = Object.freeze({ imageInput: false, toolCalling: true });

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
