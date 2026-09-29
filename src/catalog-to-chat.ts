import * as vscode from 'vscode';

import { DEFAULT_CONTEXT_TOKENS, MAX_OUTPUT_TOKENS, chatIdFor } from './catalog.js';
import { ADAPTER_VERSION, type CatalogModel } from './types.js';

// This module exists for exactly one reason: it owns the `vscode` import
// (architecture §3.1) so `catalog.ts` stays data plus pure functions and
// remains importable by a plain vitest run with no extension host and no stub.
//
// The projection is deliberately total, synchronous and I/O-free. The model
// picker is populated on every refresh and must never block on a subprocess, so
// nothing here reads a file, resolves a CLI or awaits anything.

/**
 * What a transport can actually deliver, which is what VS Code's picker reads.
 *
 * These are not one global constant any more. `imageInput` is per-model (the
 * vendor's own catalog decides it) and `toolCalling` is per-transport (only the
 * direct API can host a loop Copilot drives). Claiming either where it is not
 * true is exactly what produced a Tools chip that lit up and never fired, so
 * both are computed per entry now.
 */
export interface TransportCapabilities {
  /**
   * Can this transport hand a tool call to the host for Copilot to execute?
   *
   * `true` only for the direct Provider API. The CLI runs its own tools
   * in-process — it emits `tool_running`, calls `execGuarded`, emits
   * `tool_completed`, and never yields for a host to run one — so its models
   * cannot join VS Code's tool loop even though they can call tools themselves.
   *
   * The gate is real and was read out of the shipped workbench (1.139.1):
   *
   *   uZi: (s, kind) => kind === "agent" ? suitableForAgentMode(s.metadata) : true
   *   suitableForAgentMode: p => (p.capabilities?.agentMode ?? true) && !!p.capabilities?.toolCalling
   *
   * So a `false` here is what keeps these models out of Agent mode, and out of
   * Ask/Chat they still appear. That trade is stated in the README rather than
   * hidden behind a flag that would be a lie.
   */
  readonly toolCalling: boolean;
  /**
   * Whether the transport can read an image at all. The CLI refuses every image
   * in headless mode unless `imageVisionEnabled` is set, so with images off it
   * advertises none; the API accepts image content blocks natively.
   */
  readonly imagesAvailable: boolean;
}

/** Opaque per-family label. VS Code groups by it; it is not a route. */
function familyFor(vendor: string): string {
  return vendor;
}

/**
 * Render catalog entries as VS Code `LanguageModelChatInformation` objects.
 *
 * @param models          catalog slice; the output preserves this order
 * @param workspaceFsPath stable per-workspace salt for the model id (§D2)
 * @param transport       what this transport can deliver
 * @param vendor          the registered vendor id, for grouping
 */
export function toChatInformation(
  models: readonly CatalogModel[],
  workspaceFsPath: string,
  transport: TransportCapabilities,
  vendor: string,
): vscode.LanguageModelChatInformation[] {
  return models.map((model) => ({
    id: chatIdFor(model.id, workspaceFsPath),
    name: model.name,
    family: familyFor(vendor),
    version: ADAPTER_VERSION,
    // The plan tier is a hint for the user, never a gate (§5.2).
    detail: `${model.id} · ${model.minPlan.toUpperCase()} and above`,
    tooltip: model.blurb,
    // `—` transcribes to 0; substitute the CLI's documented default (§4.7).
    maxInputTokens: model.contextWindow > 0 ? model.contextWindow : DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // Per model AND per transport. `imageInput` follows the vendor's own
    // catalog, not the blurb, which disagrees with it in both directions.
    capabilities: {
      imageInput: transport.imagesAvailable && model.vision,
      toolCalling: transport.toolCalling,
    },
  }));
}
