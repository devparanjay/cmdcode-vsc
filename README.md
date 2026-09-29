<div align="center">

<img src="media/icon.png" width="128" height="128" alt="Command Code Provider icon">

# Command Code Provider for VS Code

**Use [Command Code](https://commandcode.ai) models inside VS Code and Copilot Chat.**

[![Visual Studio Marketplace](https://img.shields.io/badge/Marketplace-devparanjay.command--code--provider-007ACC?style=flat-square&labelColor=1B1B1F)](https://marketplace.visualstudio.com/items?itemName=devparanjay.command-code-provider)
[![Version](https://img.shields.io/badge/version-0.2.0-007ACC?style=flat-square&labelColor=1B1B1F)](https://marketplace.visualstudio.com/items?itemName=devparanjay.command-code-provider)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square&labelColor=1B1B1F)](./LICENSE)

</div>

> [!IMPORTANT]
> **Independent community project.** This extension is not affiliated with, endorsed by,
> sponsored by, or supported by Command Code. It is a third-party client. See
> [Trademarks and affiliation](#trademarks-and-affiliation).

---

## What it does

This extension registers Command Code as a **VS Code language model provider**. Once installed,
its 82-model catalog appears in Copilot Chat's model picker alongside Copilot's own models, and
choosing one routes your prompt through the Command Code CLI and streams the answer back.

It is a **provider only** — it has no chat UI of its own. Copilot Chat is the interface.

| | |
| --- | --- |
| **Models** | 82, from DeepSeek and Kimi through Claude, GPT and Gemini to the stealth and open-source tier |
| **Works with** | Copilot Chat, and any other VS Code surface that consumes language models |
| **Requires** | The `command-code` CLI on your `PATH`, and a signed-in Command Code account |
| **Transport** | One short-lived headless CLI invocation per turn |
| **First token** | ~3–4 s (CLI cold start — see [Performance](#performance)) |

## Requirements

- **VS Code 1.104.0 or newer** — the first release where the `vscode.lm` API is stable.
- **The Command Code CLI**, installed with `npm i -g command-code`, or pointed at explicitly
  with the `cmdcode.cliPath` setting.
- **A signed-in Command Code account** (`cmd login`) on a plan that covers the model you pick.
  The catalog marks each model's minimum tier in its picker entry — `GO and above`, `Pro`, `Max`.

If the CLI cannot be found or is too old, the extension says so once and then registers no models.
It degrades to "no Command Code models in the picker" rather than failing on every message.

## Quick start

1. **Install** the extension from the Marketplace, or load the `.vsix` with
   **Extensions: Install from VSIX…**
2. **Sign in to Command Code** in a terminal: `cmd login`
3. **Open Copilot Chat** (`Cmd+Shift+P` → *Copilot Chat*), click the model picker, and expand
   **Other Models → Command Code**
4. **Pick a model and start.** The first token takes a few seconds; the answer then streams in.

If a model does not appear, run **Command Code: Show Log** — it reports which CLI was resolved and
whether it passed the version check.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `cmdcode.cliPath` | string | `""` | Absolute path to the CLI. Empty resolves `cmd` on `PATH`. If the path you set is missing or not executable, resolution falls back to `PATH` — check **Show Log** to see which was chosen. |
| `cmdcode.maxTurns` | number | `24` | Agent turns per request (`--max-turns`), clamped 1–100. |
| `cmdcode.timeoutSeconds` | number | `600` | Wall-clock deadline per request. `0` disables it. |
| `cmdcode.maxPromptChars` | number | `900000` | Cap on rendered prompt size; older history is truncated to fit, the current message never is. |
| `cmdcode.logLevel` | enum | `normal` | Output-channel verbosity: `error`, `normal`, `verbose`. |

> **Settings need a window reload.** They are read once at activation. Run
> **Developer: Reload Window** after changing one.

## Commands

| Command | Description |
| --- | --- |
| **Command Code: Show Log** | Reveal the output channel — which CLI was resolved, what was spawned, and why a turn failed. |
| **Command Code: Copy Diagnostics** | Copy CLI path, version, effective configuration, and the last run's outcome to the clipboard. Paste it into a bug report. |
| **Command Code: Refresh Model List** | Re-query the catalog without reloading the window. |

## Features

- **The full catalog, offline.** All 82 models ship inside the extension. Nothing is fetched at
  activation, so the picker is populated immediately and works on a cold cache.
- **Streaming output.** Tokens are forwarded to the chat as they arrive, in order, one part at a
  time — not buffered until the run finishes.
- **Session reuse.** A follow-up message in the same chat resumes the CLI's own session, so the
  conversation prefix is reused instead of rebuilt.
- **Cancellation that actually cancels.** Stopping a turn sends `SIGTERM` to the live child and
  escalates to `SIGKILL` if it does not comply. No orphaned processes.
- **Plan-tier guidance.** Each model shows its minimum tier (`GO and above`, `Pro`, `Max`) in the
  picker, so you can pick something your plan actually covers.
- **Clean process hygiene.** The CLI is spawned with a restricted environment and no auto-update
  flag; the extension never writes to your `~/.commandcode` configuration.

## Performance

**Expect ~3–4 seconds to the first token.** This is the honest number, and it is a deliberate
trade-off.

Each turn spawns one short-lived CLI process — the vendor's documented headless print mode — rather
than keeping a long-lived daemon. Every turn therefore pays the CLI's cold start: Node boot plus
the model handshake. A whole short turn is usually ~3 seconds, and a follow-up turn within the
same chat is slightly faster because the session prefix is reused.

> **No placeholder text.** Earlier versions emitted a `Working…` part to fill the wait. Every part
> reported to VS Code becomes response *content* and cannot be retracted, so it ended up permanently
> prefixed to the model's reply. The stable API has no non-content channel for it, so it was
> removed rather than reworded. Copilot renders its own pending state while it waits.

If a turn outruns `cmdcode.timeoutSeconds`, it is stopped and reported as a timeout rather than
retried — a retry would double your token spend for a latency win you may not want.

## Limitations

These are known and deliberate, not bugs:

- **Copilot does not orchestrate tool calls.** The models advertise `toolCalling: true` because
  VS Code's **Agent** session hides models that do not, and Command Code models genuinely can call
  tools. But the CLI executes them in-process — it emits `tool_running`, runs the tool, emits
  `tool_completed`, and never yields for a host to run one. So this extension emits no
  `LanguageModelToolCallPart` and ignores `options.tools`: Copilot sends no tool schemas, and a
  model's tool work does not appear in the chat's tool UI. Nothing is silently dropped — Copilot
  simply never asks.
- **No image input.** `imageInput` is `false`: this extension renders text parts into the prompt
  only, so an attached image would be discarded. Several models in the catalog *are* vision-capable;
  this is a limitation of the adapter, not of the models.
- **Token counting is an estimate.** `provideTokenCount` returns `characters ÷ 4`, not a real
  tokenizer. Obtaining one would cost a multi-second CLI round trip, which would make budgeting
  unusable. Treat the number as approximate (well within ±20%).
- **Full history is resent each turn.** The whole conversation is rendered into the prompt every
  time. Long chats cost more tokens than a persistent server-side session would, though the CLI's
  own session cache makes much of that reuse cheap.
- **The catalog is a snapshot.** It ships inside the extension and is not fetched at runtime, so a
  vendor-side model rename needs a new release of this extension.

## Privacy and security

- **Your keys are never touched.** The extension holds no credentials of its own. Authentication
  and plan state belong entirely to the Command Code CLI, which is invoked as a subprocess with
  your own user environment.
- **The extension never writes to `~/.commandcode/`.** It does not create, read or modify your
  Command Code configuration, and never flips settings such as `autoInstallExtension`.
- **No telemetry.** The extension collects nothing and has no analytics.
- **Your prompt is not logged.** The output channel records the spawn line with the prompt's byte
  count, never its text, so pasting the log into a bug report is safe.
- **Network traffic** is whatever the Command Code CLI does on its own behalf, exactly as it would
  in a terminal.

## Relationship to the official Command Code VS Code extension

Command Code ships its own VS Code extension. **The two coexist, and you can have both installed.**

- **The vendor's extension** owns the CLI's IDE-context channel — open file, current selection. It
  does not register a language model provider.
- **This extension** registers the language model provider. It does not touch the vendor
  extension's socket, state, or files.

They are separate extensions with different IDs, share no state, and neither depends on the other.
This one is purely additive: it does not replace, fork or repackage the vendor's, and it writes
nothing to your Command Code configuration.

## Troubleshooting

**No models in the picker.** Run **Command Code: Show Log**. You will see one of:

| Log line | Meaning |
| --- | --- |
| `Command Code: [cli-not-found] …` | The CLI was not found. Install it with `npm i -g command-code`, or set `cmdcode.cliPath`. |
| `Command Code: [cli-too-old] …` | The CLI does not support `--output-format json`. Update it with `cmd update`. |
| `Command Code: CLI resolved to cmd (path)` | Registration succeeded. If the picker is still empty, check you are not in a session type that filters the catalog. |

**Models are listed but a turn fails.** The CLI's own errors are surfaced verbatim. Rate limits
and plan restrictions in particular are the vendor's, and the extension reports them rather than
retrying. **Command Code: Copy Diagnostics** bundles everything needed for a bug report.

**A model is missing or greyed out.** Each entry shows its minimum plan tier. A model above your
tier will be rejected by the CLI.

## Trademarks and affiliation

**This extension is an independent, community-maintained project. It is not affiliated with,
endorsed by, sponsored by, or supported by Command Code or any of its maintainers.** It is a
third-party client that happens to integrate with a public command-line tool. Any product names,
model names, or marks referenced belong to their respective owners and are used here for
identification only.

- **"Command Code"** and the Command Code logo are trademarks of their respective owner. This
  project is not endorsed by or affiliated with that owner.
- **The model names listed in the picker** — including names that resemble Anthropic, OpenAI,
  Google, Meta, xAI and others — are the identifiers the Command Code service exposes. They are
  used to identify the model a request routes to, and imply no relationship with, or endorsement
  by, the companies that own those names.
- **The extension icon** (`media/icon.png`) is built from the official Command Code symbol from
  <https://commandcode.ai/brand>, reproduced unmodified with a "PROVIDER" caption strip added
  beneath it. It is used solely to indicate which service the models come from. No endorsement is
  implied, and the mark is not relicensed.
- **Third-party marks.** "VS Code" and "Visual Studio Code" are trademarks of Microsoft
  Corporation. GitHub, Copilot and ChatGPT are trademarks of GitHub, Inc. MiniMax, Claude,
  DeepSeek, Kimi, GLM, Grok and other model names referenced above are trademarks of their
  respective owners. All are used descriptively, to name the integrations this extension provides.

**If you represent one of these owners and want a mark or name changed,** please open an issue and
it will be corrected promptly.

## License and third-party notices

This extension is licensed under the **GNU Affero General Public License v3.0 or later**. See
[LICENSE](./LICENSE) for the full text.

This program is distributed in the hope that it will be useful, but **without any warranty**; even
the implied warranties of merchantability or fitness for a particular purpose. See the GNU General
Public License for more details.

**Third-party components.** This extension invokes the `command-code` CLI as an external process but
does not bundle it, and it has no runtime dependencies beyond Node's standard library. The
extension icon incorporates the Command Code symbol described above. The model catalog is a
transcription of the CLI's own published model reference.

## Useful links

- **Command Code** — <https://commandcode.ai>
- **Command Code documentation** — <https://commandcode.ai/docs>
- **Install from the Marketplace** —
  <https://marketplace.visualstudio.com/items?itemName=devparanjay.command-code-provider>
- **Source and issues** — <https://github.com/devparanjay/cmdcode-vsc>
