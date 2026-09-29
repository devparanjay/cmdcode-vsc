# Cmd Code VSC

Use [Command Code](https://commandcode.ai) as a **Language Model Provider** in Visual Studio
Code, so any AI feature that consumes language models — Copilot Chat in particular — can be
driven by a Command Code model.

The extension registers the `cmdcode` vendor with `vscode.lm` and exposes Command Code's model
catalog to the VS Code model picker. When you pick a Cmd Code model in Copilot Chat, the
extension runs one headless Command Code CLI invocation and streams the answer back into the
chat as text.

## What this is (and is not)

This extension is a **Language Model Provider only**. It is deliberately small:

- No chat UI of its own — VS Code's own clients (Copilot Chat) are the UI.
- **No tool calling.** Every model advertises `toolCalling: false`, and requests that offer
  tools have them ignored. See [Limitations](#limitations).
- No IDE-context forwarding. That is the separate vendor extension's job — see
  [Relationship to the official extension](#relationship-to-the-official-extension).

## Requirements

- VS Code **1.104.0 or newer** (the first release where the `vscode.lm` API is stable).
- The Command Code CLI on your `PATH`, installed with `npm i -g command-code`, or an explicit
  path in the `cmdcode.cliPath` setting.
- A signed-in Command Code account (`cmd login`) on a plan that covers the model you pick.

If the CLI cannot be found or is too old to support `--output-format json`, the extension says so
once and then registers no models — it degrades to "no Cmd Code models in the picker" rather than
failing on every request.

## Performance: expect ~3–4 seconds to the first token

This is the honest number, and it is a deliberate trade-off.

The extension spawns one short-lived CLI process per turn (the CLI's documented headless print
mode) rather than keeping a long-lived daemon. That means every turn pays the CLI's cold start.
Measured on a typical machine:

- **~3–4 seconds** from sending a request to the first streamed token (Node boot plus the model
  handshake).
- A whole short turn is usually ~3 seconds; a resumed turn within the same chat reuses a cached
  prefix and can be slightly faster.

To make the wait feel less empty, the extension emits a short placeholder part and then streams
the answer token by token as it arrives, so you see progress instead of a spinner. If a turn
outruns `cmdcode.timeoutSeconds`, it is stopped and reported as a timeout rather than retried — a
retry would double your token spend for a latency win you may not want.

## Limitations (please read)

These are known and intentional for v1, not bugs:

- **Token counting is an estimate.** The `provideTokenCount` VS Code API returns a rough
  `characters ÷ 4` figure. It does **not** run a real tokenizer, because obtaining one costs a
  multi-second CLI round trip that would make budgeting unusable. Treat the number as approximate
  (well within ±20%), never exact.
- **No tool calling.** A Cmd Code model cannot call VS Code tools in this version. The CLI does
  have its own tool system, but print mode offers no documented way to feed a tool result back
  into a run, so advertising the capability would mean dropping tool calls silently. The extension
  declines up front instead.
- **Full history is resent each turn.** The extension renders the whole conversation into the
  prompt every turn, so long chats cost more tokens than a persistent session would. The CLI's
  own session cache makes much of that reuse cheap, but the cost is real.
- **Settings need a window reload.** `cmdcode.*` settings are read once when the extension
  activates. After changing one, run **Developer: Reload Window** for it to take effect.
- **The model catalog is a snapshot.** The catalog ships inside the extension; it is not fetched at
  runtime. A vendor-side model rename needs a new extension release.

## Relationship to the official extension

Command Code already ships and auto-installs its own VS Code extension,
`commandcode.commandcode-vscode`. **The two coexist, and you can (and usually will) have both
installed.**

- `commandcode.commandcode-vscode` (the vendor's) owns the CLI's IDE-context IPC channel. It does
  not register a Language Model Provider.
- `cmdcode.cmd-code-vsc` (this extension) registers the Language Model Provider. It does not touch
  the vendor extension's socket or state.

They are separate extensions with different ids, share no state, and neither depends on the
other. This extension is additive — it does not replace, fork, or repackage the vendor's, and it
never writes to the Command Code config or its opt-out keys.

## Settings

| Setting | Type | Default | Effect |
|---|---|---|---|
| `cmdcode.cliPath` | string | `""` | Absolute path to the CLI. Empty resolves `cmd` on `PATH`. If the path you set is missing or not executable, resolution falls back to `PATH` — check **Cmd Code: Show Log** to see which one was actually chosen. |
| `cmdcode.maxTurns` | number | `24` | Agent turns per request (`--max-turns`), clamped 1–100. |
| `cmdcode.timeoutSeconds` | number | `600` | Wall-clock deadline per request. `0` disables it. |
| `cmdcode.showThinkingPlaceholder` | boolean | `true` | Show a placeholder while the CLI starts. |
| `cmdcode.maxPromptChars` | number | `900000` | Cap on rendered prompt size; history is truncated to fit. |
| `cmdcode.logLevel` | enum | `normal` | Output-channel verbosity: `error`, `normal`, `verbose`. |

## Commands

- **Cmd Code: Show Log** — reveal the "Cmd Code" output channel.
- **Cmd Code: Copy Diagnostics** — copy CLI path, version, effective config, and the last run's
  outcome to the clipboard. Paste it into a bug report.
- **Cmd Code: Refresh Model List** — re-query the model list without reloading the window.

## Building from source

```sh
npm install
npm run check   # typecheck src + tests, then run the test suite
npm run build   # bundle to dist/extension.js (CommonJS)
npx vsce package
```

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
