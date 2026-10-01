<div align="center">

# Command Code Provider for VS Code

**Use [Command Code](https://commandcode.ai) models inside VS Code and Copilot Chat.**

[![Visual Studio Marketplace](https://img.shields.io/badge/Marketplace-devparanjay.command--code--provider-007ACC?style=flat-square&labelColor=1B1B1F)](https://marketplace.visualstudio.com/items?itemName=devparanjay.command-code-provider)
[![Version](https://img.shields.io/badge/version-0.3.5-007ACC?style=flat-square&labelColor=1B1B1F)](https://marketplace.visualstudio.com/items?itemName=devparanjay.command-code-provider)
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

This extension registers Command Code as a **VS Code language model provider**. Once installed,
its 82-model catalog appears in Copilot Chat's model picker alongside Copilot's own models, and
choosing one routes your prompt to Command Code and streams the answer back.

It is a **provider only** — it has no chat UI of its own. Copilot Chat is the interface.

| | |
| --- | --- |
| **Models** | 82, from DeepSeek and Kimi through Claude, GPT and Gemini to the stealth and open-source tier |
| **Works with** | Copilot Chat, and any other VS Code surface that consumes language models |
| **Providers** | **Command Code CLI** (any plan) and **Command Code API** (GOAT+) |
| **Vision** | 62 of the 82 models |
| **Tools** | On the API provider, including browser control |

## Requirements

- **VS Code 1.104.0 or newer** — the first release where the `vscode.lm` API is stable.

**For the CLI provider**

- **The Command Code CLI**, installed with `npm i -g command-code`, or pointed at explicitly
  with the `cmdcode.cliPath` setting.
- **A signed-in Command Code account** (`cmd login`) on a plan that covers the model you pick.
  The catalog marks each model's minimum tier in its picker entry — `GO and above`, `Pro`, `Max`.

**For the API provider** (optional, and what unlocks tools)

- **An API key** from [Studio](https://commandcode.ai/studio#api-keys). The same key authenticates
  the CLI and the API.
- **A GOAT-or-higher plan.** Go is the only plan without API access, by design.

If the CLI cannot be found or is too old, the extension says so once and then registers no models
for that provider. It degrades to "no Command Code CLI models in the picker" rather than failing on
every message — and the API provider, if you have configured it, keeps working.

## Quick start

1. **Install** the extension from the Marketplace, or load the `.vsix` with
   **Extensions: Install from VSIX…**
2. **Sign in to Command Code** in a terminal: `cmd login`
3. **Open Copilot Chat** (`Cmd+Shift+P` → *Copilot Chat*), click the model picker, and expand
   **Other Models → Command Code CLI**
4. **Pick a model and start.** The first token takes a few seconds; the answer then streams in.

**To get Copilot's tools and browser control**, run **Command Code: Set API Key**, paste your key,
reload the window, and pick a model under **Command Code API** instead.

If a model does not appear, run **Command Code: Show Log** — it reports which providers registered
and, for the CLI, whether it passed the version check.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `cmdcode.cliPath` | string | `""` | Absolute path to the CLI. Empty resolves `cmd` on `PATH`. If the path you set is missing or not executable, resolution falls back to `PATH` — check **Show Log** to see which was chosen. |
| `cmdcode.maxTurns` | number | `24` | Agent turns per request (`--max-turns`), clamped 1–100. |
| `cmdcode.timeoutSeconds` | number | `600` | Wall-clock deadline per request. `0` disables it. |
| `cmdcode.maxPromptChars` | number | `900000` | Cap on rendered prompt size; older history is truncated to fit, the current message never is. |
| `cmdcode.imageSupport` | boolean | `true` | Read images you attach, on vision-capable models. See [Images](#images). |
| `cmdcode.enableCliProvider` | boolean | `true` | Offer the **Command Code CLI** group. Works on every plan. |
| `cmdcode.enableApiProvider` | boolean | `true` | Offer the **Command Code API** group. Needs a key and GOAT or higher. |
| `cmdcode.zeroDataRetention` | boolean | `false` | API only. Enforce zero data retention; narrows which tools may be sent. |
| `cmdcode.logLevel` | enum | `normal` | Output-channel verbosity: `error`, `normal`, `verbose`. |

> **Settings need a window reload.** They are read once at activation. Run
> **Developer: Reload Window** after changing one.

## Commands

| Command | Description |
| --- | --- |
| **Command Code: Set API Key** | Store (or clear) your Provider API key in VS Code's `SecretStorage`. Needed for the API group. |
| **Command Code: Show Log** | Reveal the output channel — which provider was chosen, what was sent, and why a turn failed. |
| **Command Code: Copy Diagnostics** | Copy CLI path, version, effective configuration, and the last run's outcome to the clipboard. Paste it into a bug report. |
| **Command Code: Refresh Model List** | Re-query the catalog without reloading the window. |

## Images

Attach an image and the model reads it, on the 62 of 82 models that support
vision. **On by default** — set `cmdcode.imageSupport` to `false` to turn it off.

Which models can see images comes from Command Code's own catalog, not from the
model's description: the two disagree, so a guess would be wrong in both
directions. Check a model in **Manage Language Models** — the **Vision** chip is
only shown when the model can actually read images.

The two providers get there differently, which is worth knowing if a read
misbehaves:

- **API** — the image is sent as a normal content block. Nothing to configure.
- **CLI** — the image is written to a temporary file and the prompt names that
  file, which is how the CLI reads images from a headless run. Because a headless
  run cannot ask you for permission, the extension tells it to read images
  automatically (`--config imageVisionEnabled=true`) — but **only on a turn that
  actually contains an image**, so a text-only conversation never opts you into
  anything.

Two limits, both from the vendor rather than this extension:

- Only images from your **most recent** message are readable. Re-attach the one
  you need, or point the model at its file path again.
- On the CLI, a model that cannot see images natively may call the CLI's own
  `VISION` tool, which makes a side-call to a vision-capable model. That is the
  vendor's design and it works, but it costs a little more.

## Features

- **Two providers, pick either.** **Command Code CLI** works on every plan; **Command Code API**
  is faster and is the only one that can run Copilot's tools.
- **Full tool support on the API**, including browser control and MCP servers. VS Code's own
  tools are handed to the model, it requests them, and Copilot runs them.
- **Image support on both**, on the 62 of 82 models that can read images. See [Images](#images).
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

**On the CLI path, expect ~3–4 seconds to the first token.** That is the honest number, and it is
a deliberate trade-off.

Each CLI turn spawns one short-lived process — the vendor's documented headless print mode —
rather than keeping a long-lived daemon. Every turn therefore pays the CLI's cold start: Node boot
plus the model handshake. A whole short turn is usually ~3 seconds, and a follow-up turn within the
same chat is slightly faster because the session prefix is reused.

**The API path has no such cost.** It is a normal HTTPS request with no process to boot, so the
first token arrives as fast as the model and the network allow. If the CLI's cold start bothers you,
that is the single biggest reason to set an API key.

If a turn outruns `cmdcode.timeoutSeconds`, it is stopped and reported as a timeout rather than
retried — a retry would double your token spend for a latency win you may not want.

## Limitations

These are known and deliberate, not bugs:

- **The CLI group cannot run *Copilot's* tools.** Command Code models can call tools, and the
  CLI runs them — but in-process, never handing them to a host. So Copilot's own tools and
  browser control do not run on that group. **Use the API group for those.** Nothing is
  silently dropped: the CLI simply uses its own tool set.
- **Tool calling, generally.** The models advertise `toolCalling: true` on both groups so they
  are selectable in every Copilot session, Agent included — VS Code's Agent mode lists only
  tool-capable models, and with the flag false a pinned model could never reach the picker. On
  the API group that flag is backed by a real loop. On the CLI group it reflects the model's
  own capability, not Copilot's ability to drive it.
- **The API group needs GOAT or higher.** Go is the vendor's only plan without API access, and the
  server answers `403 upgrade_required`. That error is shown to you verbatim rather than hidden
  behind a silent fallback, because a billing problem should not look like a slower model.
- **Token counting is an estimate.** `provideTokenCount` returns `characters ÷ 4`, not a real
  tokenizer. Exact counting would cost a round trip per request, which would make budgeting
  unusable. Treat the number as approximate (well within ±20%).
- **Full history is resent each turn.** The whole conversation is rendered into the prompt every
  time. Long chats cost more tokens than a persistent server-side session would, though the CLI's
  own session cache makes much of that reuse cheap.
- **The catalog is a snapshot.** It ships inside the extension and is not fetched at runtime, so a
  vendor-side model change needs a new release. If you notice one that has not landed, please
  [tell us](#keeping-the-catalog-current) — that report is what the next release is built from.

## Keeping the catalog current

The model catalog is a snapshot transcribed from Command Code's own published reference, so a
model that appears, disappears, or changes will not reach the picker until a new release is cut.

**If you notice a change, please [open an issue using the
`catalog-update` template](https://github.com/devparanjay/cmdcode-vsc/issues/new?template=catalog-update.yml).**
It asks for four things that make a fix verifiable rather than a guess:

- the model id exactly as Command Code reports it (`cmd --list-models`),
- what the extension currently shows for it,
- what Command Code reports — the pasted line is the evidence,
- your plan tier and both version numbers.

A one-line paste is genuinely useful here; a description of the symptom is not enough to change a
transcription safely.

## Privacy and security

- **Your Command Code credentials are never touched.** The CLI group holds no credentials at all —
  authentication and plan state belong to the CLI, which runs as a subprocess in your own
  environment. The API key, if you set one, is stored in VS Code's `SecretStorage`, never in
  `settings.json`, and is sent only to `api.commandcode.ai`.
- **The extension never writes to `~/.commandcode/`.** It does not create, read or modify your
  Command Code configuration, and never flips settings such as `autoInstallExtension`.
- **No telemetry.** The extension collects nothing and has no analytics.
- **Your prompt is not logged.** The output channel records the spawn line with the prompt's byte
  count, never its text, so pasting the log into a bug report is safe.
- **Optional zero data retention.** `cmdcode.zeroDataRetention` sends `x-cmd-zdr: 1` on API
  requests, which forbids prompt training and refuses to route through a provider that cannot
  honour it. The trade is real: under ZDR a request may only carry tools your own machine runs, so
  some tools are dropped and you are told which.
- **Network traffic** goes to `api.commandcode.ai` for the API group, and wherever the Command Code
  CLI itself goes for the CLI group — exactly as it would in a terminal.

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

Start with **Command Code: Show Log** — it records which providers registered, and why any did not.

| Log line | Meaning |
| --- | --- |
| `registered vendor cmdcode (82 models, CLI transport)` | The CLI provider is live. |
| `registered vendor cmdcode-api (no API key yet)` | The API group is offered but has no key. Run **Command Code: Set API Key** and reload. |
| `vendor cmdcode disabled by cmdcode.enableCliProvider` | You turned that group off. |
| `Command Code: [cli-not-found] …` | The CLI was not found. Install it with `npm i -g command-code`, or set `cmdcode.cliPath`. |
| `Command Code: [cli-too-old] …` | The CLI does not support `--output-format json`. Update it with `cmd update`. |

**The models are not in the picker at all.** Reload the window (**Developer: Reload Window**)
after installing or changing a setting — the catalog and capabilities are read once at activation.

**A pinned model does not appear.** Model ids changed in 0.3.1 so that they no longer depend on
which folder is open — a workspace-scoped id made every pin folder-scoped, and VS Code silently
drops a pin whose id it no longer recognises. **Unpin the affected models once and re-pin them.**
Pins made before 0.3.1 are not recoverable.

**Tools do nothing.** Check you are on a model under **Command Code API**. The CLI group runs its
own tools internally, so Copilot's tool UI and browser control stay quiet by design.

**"Model … is not available on this endpoint."** The API serves three different route sets, and
the extension reads them from the server's own model list. If you see this, the server has changed
a model's routes since 0.3.1 — please [open an issue](https://github.com/devparanjay/cmdcode-vsc/issues)
with the model id, and it will be corrected.

**The API group returns `403 upgrade_required`.** Your plan is **Go**, the only plan without API
access. Upgrade to GOAT or higher, or use the CLI group. The error is shown to you verbatim rather
than hidden behind a silent fallback.

**A tool was not sent.** With `cmdcode.zeroDataRetention` on, only tools your own machine runs may
be sent, and anything else is dropped with a warning naming it. Turn ZDR off, or run the MCP server
locally and declare its tools as functions.

**An image is ignored.** Only the most recent message's images are readable — re-attach it. Also
check the model has a **Vision** chip in **Manage Language Models**; text-only models cannot read
images, and the extension will not claim otherwise.

**Models are listed but a turn fails.** The CLI's and the API's own errors are surfaced verbatim.
Rate limits and plan restrictions in particular are the vendor's, and the extension reports them
rather than retrying. **Command Code: Copy Diagnostics** bundles everything needed for a bug report.

**A model is missing or greyed out.** Each entry shows its minimum plan tier. A model above your tier
will be rejected — and if the model itself is new or changed upstream, the catalog snapshot may not
have caught up yet. [Tell us](#keeping-the-catalog-current).

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
