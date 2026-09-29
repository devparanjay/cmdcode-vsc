import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The bare specifier — the exact same resolution `src/prompt.ts` performs via the
// vitest alias. Both must land on `test/vscode-stub.ts`; if they diverged the
// `instanceof` narrowing below would silently match nothing.
import * as vscode from 'vscode';

import { buildPrompt } from '../src/prompt.js';
import { CliError } from '../src/types.js';

// `LanguageModelDataPart` is stub-only: @types/vscode has no such export, so it
// is reached through the stub module directly. The classes are identical objects
// either way — that is what makes the `instanceof` narrowing below meaningful.
import { LanguageModelDataPart, LanguageModelTextPart } from './vscode-stub.js';

type Message = vscode.LanguageModelChatRequestMessage;

const MODEL = 'stealth/space-bunny-alpha';
const BIG_MAX = 900_000;

function message(role: vscode.LanguageModelChatMessageRole, value: string): Message {
  return { name: role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant', role, content: [new LanguageModelTextPart(value)] };
}

function user(value: string): Message {
  return message(vscode.LanguageModelChatMessageRole.User, value);
}

function assistant(value: string): Message {
  return message(vscode.LanguageModelChatMessageRole.Assistant, value);
}

/**
 * Pull the body of a top-level element out of the rendered envelope. The
 * newline the writer puts after the open tag, and the one before the close
 * tag, are structure rather than content, so both are stripped.
 */
function element(text: string, tag: string): string {
  const open = new RegExp(`<${tag}(?: [^>]*?)?>`);
  const match = open.exec(text);
  expect(match, `no <${tag}> element in:\n${text}`).not.toBeNull();
  const start = match!.index + match![0].length;
  const end = text.indexOf(`</${tag}>`, start);
  expect(end, `unclosed <${tag}> element`).toBeGreaterThan(start);
  return text.slice(start, end).replace(/^\n/, '').replace(/\n$/, '');
}

describe('buildPrompt', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cmdcode-prompt-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('renders the full §4.8 envelope with the model, workspace and empty history', async () => {
    const { text, projectInstructionBytes, droppedNonTextParts, truncatedChars } = await buildPrompt(
      [user('Refactor it to stream.')],
      { model: MODEL, cwd, maxChars: BIG_MAX },
    );

    expect(text).toBe(
      [
        `<cmdcode-request model="${MODEL}">`,
        `<workspace name="${cwd.split('/').pop()}" root="${cwd}">`,
        '</workspace>',
        '<history>',
        '</history>',
        '<user-now>',
        'Refactor it to stream.',
        '</user-now>',
        '</cmdcode-request>',
      ].join('\n'),
    );
    expect(text.endsWith('</cmdcode-request>')).toBe(true);
    expect(projectInstructionBytes).toBe(0);
    expect(droppedNonTextParts).toBe(0);
    expect(truncatedChars).toBe(0);
  });

  it('puts the earlier message in history and the later one in user-now', async () => {
    const { text } = await buildPrompt([user('Explain this function.'), user('Refactor it to stream.')], {
      model: MODEL,
      cwd,
      maxChars: BIG_MAX,
    });

    expect(element(text, 'user-now')).toBe('Refactor it to stream.');
    expect(element(text, 'history')).toBe(['<user>', 'Explain this function.', '</user>'].join('\n'));
  });

  it('preserves role tagging and order across every history entry', async () => {
    const { text } = await buildPrompt(
      [user('first'), assistant('second'), user('third'), assistant('fourth'), user('fifth')],
      { model: MODEL, cwd, maxChars: BIG_MAX },
    );

    const history = element(text, 'history');
    expect(history).toBe(
      [
        '<user>',
        'first',
        '</user>',
        '<assistant>',
        'second',
        '</assistant>',
        '<user>',
        'third',
        '</user>',
        '<assistant>',
        'fourth',
        '</assistant>',
      ].join('\n'),
    );
    expect(element(text, 'user-now')).toBe('fifth');
  });

  it('makes a trailing assistant message the user-now tail', async () => {
    const { text } = await buildPrompt([user('first'), assistant('last')], {
      model: MODEL,
      cwd,
      maxChars: BIG_MAX,
    });

    expect(element(text, 'user-now')).toBe('last');
    expect(element(text, 'history')).toBe(['<user>', 'first', '</user>'].join('\n'));
  });

  it('rejects an empty message list with CliError code unknown', async () => {
    await expect(buildPrompt([], { model: MODEL, cwd, maxChars: BIG_MAX })).rejects.toBeInstanceOf(
      CliError,
    );
    const error = await buildPrompt([], { model: MODEL, cwd, maxChars: BIG_MAX }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('unknown');
  });

  it('renders only text parts and counts the non-text one it skipped', async () => {
    // The stub's LanguageModelTextPart is the SAME class the module narrows
    // against (both import the same module), so the surviving text proves the
    // `instanceof` branch ran rather than matching nothing.
    expect(new LanguageModelTextPart('kept')).toBeInstanceOf(vscode.LanguageModelTextPart);

    const dataPart = new LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png');
    expect(dataPart).not.toBeInstanceOf(vscode.LanguageModelTextPart);

    const { text, droppedNonTextParts } = await buildPrompt(
      [
        {
          name: 'user',
          role: vscode.LanguageModelChatMessageRole.User,
          content: [dataPart, new LanguageModelTextPart('kept')],
        },
      ],
      { model: MODEL, cwd, maxChars: BIG_MAX },
    );

    expect(droppedNonTextParts).toBe(1);
    expect(element(text, 'user-now')).toBe('kept');
    expect(text).not.toContain('image/png');
  });

  it('counts a message that carries no text part at all', async () => {
    const { text, droppedNonTextParts } = await buildPrompt(
      [
        {
          name: 'user',
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new LanguageModelDataPart(new Uint8Array([0]))],
        },
        user('live'),
      ],
      { model: MODEL, cwd, maxChars: BIG_MAX },
    );

    expect(droppedNonTextParts).toBe(1);
    expect(element(text, 'user-now')).toBe('live');
  });

  it('inlines AGENTS.md when it is present', async () => {
    await writeFile(join(cwd, 'AGENTS.md'), 'Always run the tests.\n');

    const { text, projectInstructionBytes } = await buildPrompt([user('hi')], {
      model: MODEL,
      cwd,
      maxChars: BIG_MAX,
    });

    // The file's own trailing newline is content, not structure, so it survives
    // the inline verbatim.
    expect(text).toContain(
      '<project-instructions path="AGENTS.md">\nAlways run the tests.\n\n</project-instructions>',
    );
    expect(element(text, 'user-now')).toBe('hi');
    expect(projectInstructionBytes).toBe('Always run the tests.\n'.length);
  });

  it('omits the project-instructions element when AGENTS.md is absent', async () => {
    const { text, projectInstructionBytes } = await buildPrompt([user('hi')], {
      model: MODEL,
      cwd,
      maxChars: BIG_MAX,
    });

    expect(text).not.toContain('project-instructions');
    expect(projectInstructionBytes).toBe(0);
  });

  it('caps AGENTS.md at 64 KiB and reports the capped byte count', async () => {
    const oversized = 'x'.repeat(64 * 1024 + 5_000);
    await writeFile(join(cwd, 'AGENTS.md'), oversized);

    const { text, projectInstructionBytes } = await buildPrompt([user('hi')], {
      model: MODEL,
      cwd,
      maxChars: BIG_MAX,
    });

    expect(projectInstructionBytes).toBe(64 * 1024);
    const inlined = element(text, 'project-instructions');
    expect(inlined).toBe('x'.repeat(64 * 1024));
  });

  it('inlines an AGENTS.md of exactly 64 KiB uncapped', async () => {
    const exact = 'y'.repeat(64 * 1024);
    await writeFile(join(cwd, 'AGENTS.md'), exact);

    const { projectInstructionBytes } = await buildPrompt([user('hi')], {
      model: MODEL,
      cwd,
      maxChars: BIG_MAX,
    });

    expect(projectInstructionBytes).toBe(64 * 1024);
  });

  it('truncates the front of history but never the user-now tail', async () => {
    const first = 'a'.repeat(400);
    const second = 'b'.repeat(400);
    const live = 'the live instruction';
    const conversation = [user(first), user(second), user(live)];

    const full = await buildPrompt(conversation, { model: MODEL, cwd, maxChars: BIG_MAX });

    // One history entry's worth of slack, so the oldest entry is the one dropped
    // and the newer one still fits.
    const maxChars = full.text.length - 400;
    const build = await buildPrompt(conversation, { model: MODEL, cwd, maxChars });

    expect(build.truncatedChars).toBeGreaterThan(0);
    expect(build.text.length).toBeLessThanOrEqual(maxChars);
    expect(build.text).not.toContain(first);
    expect(build.text).toContain(second);
    expect(element(build.text, 'user-now')).toBe(live);
    expect(build.text.endsWith('</user-now>\n</cmdcode-request>')).toBe(true);
  });

  it('reports truncatedChars as exactly the characters removed from history', async () => {
    const first = 'a'.repeat(400);
    const second = 'b'.repeat(400);
    const live = 'live';
    const conversation = [user(first), user(second), user(live)];

    const untruncated = await buildPrompt(conversation, { model: MODEL, cwd, maxChars: BIG_MAX });
    const build = await buildPrompt(conversation, {
      model: MODEL,
      cwd,
      maxChars: untruncated.text.length - 400,
    });

    const historyChars = (text: string): number => element(text, 'history').length;
    expect(build.truncatedChars).toBe(historyChars(untruncated.text) - historyChars(build.text));
    // Exactly the oldest entry, tag lines included — not a character count of
    // the payload alone.
    expect(build.truncatedChars).toBe(`<user>\n${first}\n</user>\n`.length);
  });

  it('keeps the whole user-now tail when maxChars is smaller than the tail alone', async () => {
    const build = await buildPrompt([user('a'.repeat(500)), user('b'.repeat(500))], {
      model: MODEL,
      cwd,
      maxChars: 10,
    });

    expect(element(build.text, 'user-now')).toBe('b'.repeat(500));
    expect(build.text).toContain('</user-now>\n</cmdcode-request>');
    expect(build.truncatedChars).toBeGreaterThan(0);
  });
});
