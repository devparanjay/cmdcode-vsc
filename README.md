<div align="center">

# Command Code Provider for VS Code

**Use [Command Code](https://commandcode.ai) models inside VS Code and Copilot Chat.**

[![Visual Studio Marketplace](https://img.shields.io/badge/Marketplace-devparanjay.command--code--provider-007ACC?style=flat-square&labelColor=1B1B1F)](https://marketplace.visualstudio.com/items?itemName=devparanjay.command-code-provider)
[![Version](https://img.shields.io/badge/version-0.3.6-007ACC?style=flat-square&labelColor=1B1B1F)](https://marketplace.visualstudio.com/items?itemName=devparanjay.command-code-provider)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square&labelColor=1B1B1F)](./LICENSE)

</div>

> [!IMPORTANT]
> **Independent community project.** This extension is not affiliated with, endorsed by,
> sponsored by, or supported by Command Code. It is a third-party client. See
> [Trademarks and affiliation](#trademarks-and-affiliation).

> [!TIP]
> ### Get full native functionality by enabling the API provider
>
> The extension offers **two** provider groups:
>
> | | **Command Code CLI** | **Command Code API** |
> | --- | --- | --- |
> | Needs | the `command-code` CLI | an API key from [Studio](https://commandcode.ai/studio#api-keys) |
> | Plan | any, including **Go** | **GOAT** or higher |
> | First token | ~3–4 s (CLI cold start) | fast (no process spawn) |
> | **Vision** | ✅ | ✅ |
> | **Copilot tools** | ❌ | ✅ **full support, including browser control** |
>
> **The API provider is off until you give it a key.** Run
> **Command Code: Set API Key**, then reload the window. That is the only
> difference — the models, the catalog, and the settings are shared.
>
> The CLI group cannot run Copilot's tools, and that is a real limitation rather
> than a missing feature: the CLI executes tools in-process and never hands them
> to a host, so Copilot's tool UI and browser control cannot drive it. The API
> passes tool definitions through and lets your client run them, which is the
> loop Copilot drives. On a **Go** plan the API is unavailable by design — the
> vendor's only plan without API access — so the CLI group is the right one for you.
>
> Either group can be turned off independently with
> [`cmdcode.enableCliProvider` / `cmdcode.enableApiProvider`](#settings).

---

## What it does

This extension registers Command Code as a **VS Code language model provider**. Its 82-model
catalog appears in Copilot Chat's model picker alongside Copilot's own models; picking one routes
your prompt to Command Code and streams the answer back. It is a **provider only** — it has no chat
UI of its own, because Copilot Chat is the interface.

- **82 models**, from DeepSeek and Kimi through Claude, GPT and Gemini to the stealth and
  open-source tier. All of them ship inside the extension, so the picker is populated immediately
  and works on a cold cache.
- **Vision** on 62 of the 82. See [Images](#images).
- **Tools**, including browser control and MCP servers, on the [API group](#requirements). VS Code's
  own tools are handed to the model, it requests them, and Copilot runs them.
- **Streaming output**, forwarded to the chat as tokens arrive rather than buffered to the end.
- **Session reuse** on the CLI group, so a follow-up message reuses the conversation prefix.
- **Cancellation that cancels** — stopping a turn sends `SIGTERM`, escalating to `SIGKILL`.
- **Plan-tier guidance** — each picker entry shows the minimum tier it needs.

## Requirements

**VS Code 1.104.0 or newer**, the first release where the `vscode.lm` API is stable.

**For the CLI group**

- The Command Code CLI — `npm i -g command-code`, or set `cmdcode.cliPath`.
- A signed-in account (`cmd login`) on a plan covering the model you pick.

**For the API group**, which is what unlocks tools

- An API key from [Studio](https://commandcode.ai/studio#api-keys). The same key authenticates both
  groups.
- A GOAT-or-higher plan. Go is the only plan without API access, by design.

If the CLI is missing or too old the extension says so once and registers no models for that group,
degrading to an empty picker rather than failing every message. The other group keeps working.

## Quick start

1. **Install** from the Marketplace, or load the `.vsix` with **Extensions: Install from VSIX…**
2. **Sign in**: `cmd login`
3. **Open Copilot Chat**, click the model picker, and expand **Other Models → Command Code CLI**
4. **Pick a model.** The first token takes a few seconds; the answer then streams in.

For Copilot's tools and browser control, run **Command Code: Set API Key**, paste the key, reload the
window, and pick a model under **Command Code API**.

Settings are read once at activation, so **reload the window** after changing one.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `cmdcode.cliPath` | string | `""` | Absolute path to the CLI. Empty resolves `cmd` on `PATH`. |
| `cmdcode.maxTurns` | number | `24` | Agent turns per request, clamped 1–100. |
| `cmdcode.timeoutSeconds` | number | `600` | Wall-clock deadline per request. `0` disables it. |
| `cmdcode.maxPromptChars` | number | `900000` | Cap on rendered prompt size; older history is truncated, the current message never is. |
| `cmdcode.imageSupport` | boolean | `true` | Read images you attach, on vision-capable models. See [Images](#images). |
| `cmdcode.enableCliProvider` | boolean | `true` | Offer the **Command Code CLI** group. Works on every plan. |
| `cmdcode.enableApiProvider` | boolean | `true` | Offer the **Command Code API** group. Needs a key and GOAT or higher. |
| `cmdcode.zeroDataRetention` | boolean | `false` | API only. Enforce zero data retention; narrows which tools may be sent. |
| `cmdcode.logLevel` | enum | `normal` | Output-channel verbosity: `error`, `normal`, `verbose`. |

## Commands

| Command | Description |
| --- | --- |
| **Set API Key** | Store (or clear) your Provider API key in VS Code's `SecretStorage`. |
| **Show Log** | Reveal the output channel — which provider registered, what was sent, why a turn failed. |
| **Copy Diagnostics** | Copy CLI path, version, effective config and the last run's outcome for a bug report. |
| **Refresh Model List** | Re-query the catalog without reloading the window. |

## Images

Attach an image and the model reads it, on the 62 of 82 models that support vision. **On by
default** — set `cmdcode.imageSupport` to `false` to turn it off.

The API sends the image as a normal content block. The CLI writes it to a temporary file and names
that file in the prompt, which is how a headless run reads images; because a headless run cannot
prompt for permission, the extension enables the CLI's vision flag for you — but only on a turn that
actually carries an image, so a text-only conversation never opts into anything.

Two limits come from the vendor, not from this extension: only images from your **most recent**
message are readable, and on the CLI a text-only model may call the CLI's own `VISION` tool as a
side-call to a vision-capable one.

Vision support is read from Command Code's own catalog rather than the model description, because
the two disagree in both directions. A model's picker entry shows a **Vision** chip only when it can
genuinely read images.

## Performance

Expect **~3–4 s to the first token on the CLI group**: each turn spawns one short-lived process
rather than reusing a daemon, so every turn pays Node boot plus the model handshake. The API group
has no process to boot and is as fast as the model and network allow — the single biggest reason to
set an API key.

A turn that outruns `cmdcode.timeoutSeconds` is reported as a timeout rather than retried, since a
retry would double token spend for a latency win you may not want.

## Limitations

These are deliberate and documented, not bugs.

- **The CLI group cannot run *Copilot's* tools.** Command Code models can call tools, and the CLI
  runs them — in-process, never handing them to a host. **Use the API group for Copilot's tools and
  browser control.** Nothing is dropped; the CLI simply uses its own tool set.
- **The models advertise `toolCalling: true` on both groups** so they stay selectable everywhere,
  Agent mode included — VS Code lists only tool-capable models there. On the API group that flag is
  backed by a real loop; on the CLI group it reflects the model's own capability, not Copilot's
  ability to drive it.
- **The API group needs GOAT or higher.** Go has no API access and the server answers
  `403 upgrade_required`. That error is shown verbatim rather than hidden behind a silent fallback,
  because a billing problem should not look like a slower model.
- **Token counting is an estimate** — `characters ÷ 4`, not a real tokenizer, well within ±20%. Exact
  counting would cost a round trip per request.
- **Full history is resent each turn**, so long chats cost more than a persistent server-side session.
- **The catalog is a snapshot** shipping inside the extension, so a vendor-side model change needs a
  new release. See [Keeping the catalog current](#keeping-the-catalog-current).

## Keeping the catalog current

The catalog is transcribed from Command Code's own published reference, so a model that appears,
disappears or changes will not reach the picker until a release is cut.

**If you spot a change, [open an issue using the `catalog-update`
template](https://github.com/devparanjay/cmdcode-vsc/issues/new?template=catalog-update.yml).** It asks
for the model id as Command Code reports it, what the extension currently shows, what Command Code
reports, and both version numbers. A pasted line is the evidence; a description of the symptom is not
enough to change a transcription safely.

## Privacy and security

- **Your Command Code credentials are never touched.** The CLI group holds none — authentication
  belongs to the CLI, which runs in your own environment. The API key, if you set one, lives in
  VS Code's `SecretStorage`, never in `settings.json`, and goes only to `api.commandcode.ai`.
- **The extension never writes to `~/.commandcode/`**, and never flips settings such as
  `autoInstallExtension`.
- **No telemetry**, and your prompt text is never logged — the output channel records only the spawn
  line and the prompt's byte count, so pasting a log into a bug report is safe.
- **Optional zero data retention** (`cmdcode.zeroDataRetention`) forbids prompt training and refuses
  to route through a provider that cannot honour it. The trade is real: under ZDR a request may only
  carry tools your own machine runs, so some tools are dropped and you are told which.
- **Network traffic** goes to `api.commandcode.ai` for the API group, and wherever the CLI itself
  goes for the CLI group — exactly as in a terminal.

## Relationship to the official Command Code extension

Command Code ships its own VS Code extension, and **the two coexist**. The vendor's owns the CLI's
IDE-context channel and does not register a language model provider; this one registers the provider
and touches none of the vendor extension's socket, state or files. They are separate extensions with
separate IDs, share no state, and neither depends on the other.

## Troubleshooting

Start with **Command Code: Show Log** — it records which providers registered, and why any did not.

| Log line | Meaning |
| --- | --- |
| `registered vendor cmdcode (82 models, CLI transport)` | The CLI provider is live. |
| `registered vendor cmdcode-api (no API key yet)` | The API group needs a key. Run **Set API Key** and reload. |
| `vendor cmdcode disabled by cmdcode.enableCliProvider` | You turned that group off. |
| `Command Code: [cli-not-found] …` | Install the CLI with `npm i -g command-code`, or set `cmdcode.cliPath`. |
| `Command Code: [cli-too-old] …` | The CLI lacks `--output-format json`. Update it with `cmd update`. |

- **No models in the picker at all** — reload the window; the catalog is read once at activation.
- **A pinned model does not appear** — model ids changed in 0.3.1 so they no longer depend on the open
  folder, which had made every pin folder-scoped. **Unpin and re-pin once.** Pins from before 0.3.1
  are not recoverable.
- **"Model … is not available on this endpoint."** The server has changed a model's routes since
  0.3.1. Please [open an issue](https://github.com/devparanjay/cmdcode-vsc/issues) with the model id.
- **A model is missing or greyed out** — a model above your plan tier will be rejected, or the
  snapshot has not caught up. [Tell us](#keeping-the-catalog-current).
- **A turn fails** — CLI and API errors are surfaced verbatim rather than retried. **Copy Diagnostics**
  bundles everything needed for a bug report.

## Trademarks and affiliation

**This extension is an independent, community-maintained project. It is not affiliated with,
endorsed by, sponsored by, or supported by Command Code or any of its maintainers.** It is a
third-party client that happens to integrate with a public command-line tool.

- **"Command Code"** and the Command Code logo are trademarks of their respective owner.
- **The model names in the picker** — including names resembling Anthropic, OpenAI, Google, Meta and
  xAI — are the identifiers the Command Code service exposes. They identify which model a request
  routes to and imply no endorsement by the companies that own them.
- **The extension icon** (`media/icon.png`) is built from the official Command Code symbol from
  <https://commandcode.ai/brand>, reproduced unmodified with a "PROVIDER" caption strip beneath it,
  used solely to indicate which service the models come from. No endorsement is implied and the mark
  is not relicensed.
- **Third-party marks.** "VS Code" is a trademark of Microsoft Corporation; GitHub, Copilot and
  ChatGPT of GitHub, Inc. Model names are trademarks of their respective owners. All are used
  descriptively.

**If you represent one of these owners and want a mark or name changed,** please open an issue and it
will be corrected promptly.

## License

Licensed under the **GNU Affero General Public License v3.0 or later** — see [LICENSE](./LICENSE).
Distributed without any warranty.

**Third-party components.** This extension invokes the `command-code` CLI as an external process but
does not bundle it, and has no runtime dependencies beyond Node's standard library. The icon
incorporates the symbol described above, and the model catalog is a transcription of the CLI's own
published reference.

## Links

- **Command Code** — <https://commandcode.ai> · **Docs** — <https://commandcode.ai/docs>
- **Marketplace** —
  <https://marketplace.visualstudio.com/items?itemName=devparanjay.command-code-provider>
- **Source and issues** — <https://github.com/devparanjay/cmdcode-vsc>