import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';

import { CliError } from './types.js';

/** Everything the provider learned while rendering one request. */
export interface PromptBuild {
  /** The argv-ready prompt string. */
  readonly text: string;
  /** Characters dropped by truncation, for logging. */
  readonly truncatedChars: number;
  /** Bytes of AGENTS.md included, for logging. 0 when absent. */
  readonly projectInstructionBytes: number;
  /** Non-text content parts skipped, for logging (§D5). */
  readonly droppedNonTextParts: number;
}

/** §4.8: AGENTS.md is the CLI's own memory file; cap it so it cannot eat the window. */
const PROJECT_INSTRUCTIONS_FILE = 'AGENTS.md';
const MAX_PROJECT_INSTRUCTION_BYTES = 64 * 1024;

/**
 * Render VS Code chat messages into a single prompt.
 *
 * @param messages     readonly LanguageModelChatRequestMessage[]
 * @param opts.model   catalog model id, for the inline <model> directive
 * @param opts.cwd     workspace root; AGENTS.md is read from here
 * @param opts.maxChars hard cap on the rendered prompt (argv is 1 MiB; we stay under)
 */
export async function buildPrompt(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  opts: { model: string; cwd: string; maxChars: number },
): Promise<PromptBuild> {
  if (messages.length === 0) {
    throw new CliError('unknown', 'empty request');
  }

  // The LAST message is the live instruction, always. When it is a user message
  // that is the live instruction by definition; when the tail is an assistant
  // message there is no live user turn to find, and promoting the tail anyway
  // keeps the envelope well-formed instead of dropping the request (§4.8).
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex]!;

  let droppedNonTextParts = 0;
  const history: string[] = [];
  for (let i = 0; i < lastIndex; i += 1) {
    const message = messages[i]!;
    const tag = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    const text = extractText(message, () => {
      droppedNonTextParts += 1;
    });
    history.push(`<${tag}>\n${text}\n</${tag}>\n`);
  }

  const nowText = extractText(last, () => {
    droppedNonTextParts += 1;
  });

  const instructions = await readProjectInstructions(opts.cwd);
  const head = renderHead(
    opts.model,
    opts.cwd,
    instructions === null ? null : instructions.text,
  );

  const tail = `</history>\n<user-now>\n${nowText}\n</user-now>\n</cmdcode-request>`;

  let truncatedChars = 0;
  let text: string;
  if (head.length + tail.length + historyChars(history) <= opts.maxChars) {
    text = head + history.join('') + tail;
  } else {
    // Truncation eats the front of <history> only. The request header, the
    // project instructions and the live instruction always survive: dropping
    // any of them would change what the model was asked to do.
    const room = Math.max(opts.maxChars - tail.length - head.length, 0);
    const kept = trimHistory(history, room);
    truncatedChars = historyChars(history) - historyChars(kept);
    text = head + kept.join('') + tail;
  }

  return {
    text,
    truncatedChars,
    projectInstructionBytes: instructions === null ? 0 : instructions.bytes,
    droppedNonTextParts,
  };
}

/**
 * Open the envelope: request element, workspace element, optional project
 * instructions, and the history element. Kept separate from the user-now tail
 * so truncation can only ever eat history.
 */
function renderHead(model: string, cwd: string, instructions: string | null): string {
  const lines: string[] = [
    `<cmdcode-request model="${escapeAttribute(model)}">`,
    `<workspace name="${escapeAttribute(basename(cwd))}" root="${escapeAttribute(cwd)}">`,
  ];
  if (instructions !== null) {
    lines.push(
      `<project-instructions path="${PROJECT_INSTRUCTIONS_FILE}">`,
      instructions,
      '</project-instructions>',
    );
  }
  lines.push('</workspace>', '<history>');
  return `${lines.join('\n')}\n`;
}

/** Bytes and decoded text of AGENTS.md, or null when it is absent or unreadable. */
async function readProjectInstructions(
  cwd: string,
): Promise<{ readonly text: string; readonly bytes: number } | null> {
  let raw: Buffer;
  try {
    raw = await readFile(join(cwd, PROJECT_INSTRUCTIONS_FILE));
  } catch {
    // Absent (or unreadable) project instructions are not an error: most
    // workspaces have no AGENTS.md and the CLI works fine without one.
    return null;
  }
  const bytes = Math.min(raw.byteLength, MAX_PROJECT_INSTRUCTION_BYTES);
  return { text: raw.subarray(0, bytes).toString('utf8'), bytes };
}

/** The text parts of a message, joined by newlines. Non-text parts are dropped. */
function extractText(
  message: vscode.LanguageModelChatRequestMessage,
  onNonTextPart: () => void,
): string {
  const text: string[] = [];
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text.push(part.value);
      continue;
    }
    // v1 has no image support (§D5). Dropped, and counted so the log can say so.
    onNonTextPart();
  }
  return text.join('\n');
}

/** Characters spent on history, entry open tags and close tags included. */
function historyChars(history: readonly string[]): number {
  let total = 0;
  for (const entry of history) {
    total += entry.length;
  }
  return total;
}

/** Keep whole leading entries; drop from the front until the budget is met. */
function trimHistory(history: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]!;
    if (used + entry.length > budget) {
      break;
    }
    kept.unshift(entry);
    used += entry.length;
  }
  return kept;
}

/** Keep the model's own quoting from breaking out of an attribute value. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
