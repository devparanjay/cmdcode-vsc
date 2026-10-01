# Changelog

All notable changes to the Cmd Code VSC extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.4]

The `/responses` dialect is no longer used by default. Both of the last two
schema defects were in it, and a working reference provider for this same API
does not use it at all.

### Changed

- **Routes prefer `/chat/completions`.** Every model that declares `/responses`
  also declares `/chat/completions`, so coverage is unchanged — 73 of the 82
  catalog models now go there, 9 Claude models go to `/messages`, and
  `/responses` is a fallback for a model that declares it alone.
- **`/chat/completions` messages follow the reference provider's shape**: text is
  the message's `content` as a plain string, an array of parts only when an image
  is present, a tool call rides as `tool_calls`, and a tool result becomes its own
  `role: "tool"` message keyed by `tool_call_id`.
- **No empty content is ever sent.** A message whose parts were all dropped still
  carries a text block, because an empty `content` array is rejected. This is the
  reference provider's guard, adopted after reading it.

### Why

0.3.1, 0.3.2 and 0.3.3 were three schema defects in three releases, all in the
hand-written request path, all in `/responses`. The root cause was the same each
time: a wire format implemented from its name rather than its specification.
The reference provider for this API uses two dialects and lets the vendor SDKs
serialise them, so it has no hand-written content vocabulary to get wrong. This
release adopts its shape for the one route both share.

## [0.3.3]

### Fixed

- **Every API message still failed, with `Invalid input: expected string, received undefined`.**
  The text block's `type` is **per-dialect**: Responses calls it `input_text`, while
  `/chat/completions` and `/messages` both use `text`. Sending `text` to `/responses` left the
  required string unreadable — on every message, with no image and no tools involved.
- **`/responses` image blocks were malformed.** `input_image` takes `image_url` as a bare **string**
  and requires `detail`; the extension was sending `{ image_url: { url } }`, which is the shape
  `/chat/completions` wants and the one route that is not `/responses`.
- **Tool parts are now placed where each route expects them.** They were being emitted as content
  blocks on every dialect. Anthropic wants `tool_use`/`tool_result` inside the message content;
  Responses wants `function_call`/`function_call_output` as **top-level** siblings of the message;
  Chat Completions wants the result as its own `role: "tool"` message keyed by `tool_call_id`.

### Changed

- `test/api-request-body.test.ts` now asserts the per-dialect text type, image shape, and tool
  placement on all three routes. Reverting the text type to `text` fails a test, verified — this
  is the assertion that was missing when 0.3.2 shipped.

### Fixed (test infrastructure)

- `LanguageModelDataPart` in the `vscode` stub exposed its bytes as `value`, while the product
  matches data parts **structurally** on a `data` field. Every image test was therefore passing
  against an empty content array — the same failure mode as the bugs above, in the tests themselves.

## [0.3.2]

### Fixed

- **Every API message failed with `Invalid input: expected object, received undefined`.** Tool
  definitions were sent **flat** — `{ type, name, parameters }` — while the schema wants
  `{ type: "function", function: { name, parameters } }`. A flat definition carries no `function`
  key at all, which the server reads as undefined. The two shapes were inconsistent within the
  same file: tool *calls* were already sent nested, only the definitions were not.
- **Anthropic's tool shape is not OpenAI's.** `/messages` takes tools flat with `input_schema`,
  so the converted definition is reshaped per route rather than sent as-is.
- **`tools` is now omitted when there are none.** Every documented example carries no `tools` key,
  and an empty array is the likeliest trigger for a schema that expects at least one entry.

### Added

- `test/api-request-body.test.ts`, which captures the exact JSON sent on the wire for all three
  routes and asserts the tool shape, the URL, and that no field is `undefined`. Verified against
  the 0.3.1 shape: **8 of its assertions fail** when the definitions are reverted to flat, so this
  cannot regress silently again.
- `LanguageModelToolCallPart` and `LanguageModelToolResultPart` in the `vscode` test stub. The
  provider narrows request content with `instanceof` against them, and without them the check
  evaluates `undefined`.

## [0.3.1]

Three defects reported against 0.3.0, all confirmed against the live API and a live extension host.

### Fixed

- **Models failed with `Model "…" is not available on this endpoint`.** The extension routed on
  "Claude ⇒ `/messages`, else `/responses`", but the API serves **three** route sets, not two.
  `GET /provider/v1/models` — which is public and needs no auth — reports `supported_endpoints`
  per model, and 9 of our 82 serve `/chat/completions` **only**:

      /chat/completions,/responses   67
      /messages                      10
      /chat/completions               9   ← these 400 on /responses

  Routing is now read from a generated table transcribed from the server, with
  `scripts/sync-endpoints.mjs` to refresh it. A `/chat/completions` request builder was added
  too, because that dialect differs structurally: images are `image_url` parts, and a tool result
  is its own `role: "tool"` message rather than a block inside the next turn. The generator also
  caught four wrong rows in the hand-built table — four newer Claude models that the prose rule
  would have misrouted.

- **Pinned models from the CLI group did not appear in the picker.** Two causes, both fixed.
  First, the CLI group advertised `toolCalling: false`, and VS Code's Agent session lists only
  tool-capable models — so a pin could never resolve into the picker. Second, and the deeper
  problem, model ids were `sha256(workspacePath + modelId)`, so they changed with the folder.
  VS Code drops any pin whose id is not in the live model cache, which made every pin
  folder-scoped and silently dead, and left dead ids pinned forever with no way to collect them.
  Ids are now a hash of the model id alone. The per-folder isolation the salt bought was illusory
  anyway: the working directory travels per request (`RunRequest.cwd`), never in the id.

  **Pins made before 0.3.1 must be re-made once.** This is a one-time migration.

- **The extension icon did not load in the details tab.** The README's `<img src="media/icon.png">`
  is a relative path, which resolves against the extension's *installed* directory rather than the
  repo, so it 404s in the webview. It now points at the repository URL. The packaged icon itself
  was always correct — 128×128 RGBA, declared as a `Microsoft.VisualStudio.Services.Icons.Default`
  asset — so this was the README only.

### Changed

- The CLI group now advertises `toolCalling: true`, so its models are selectable in every Copilot
  session. That is a claim about the *model* — Command Code models can call tools — not about
  Copilot driving them, which it still cannot do on that transport. The API group remains where
  Copilot's own tools and browser control actually run, and the README says so plainly.
- The API request is logged with its route before it is sent, so a wrong route is diagnosable from
  the log alone rather than only from the server's error.

## [0.3.0]

A second provider, real tool support, and image support on both paths.

### Added

- **The Command Code Provider API as a second provider group** (`cmdcode-api`, displayed as
  **Command Code API**). It talks to `https://api.commandcode.ai/provider/v1` over HTTPS, so
  there is no process to spawn and the ~3–4 s CLI cold start is gone.
- **Real tool calling on the API group, including browser control and MCP servers.** VS Code's own
  tools arrive in `options.tools` and are sent with the request; a tool the model wants comes back
  as a `LanguageModelToolCallPart` for **Copilot to execute** — this extension never runs a tool
  itself. Results come back on the next turn as `function_call_output`.
- **Image support on both providers**, on by default. The API sends a proper content block; the CLI
  receives a content-addressed staged file that the prompt names, which is how a headless run reads
  an image. The CLI is told to read images without asking (`--config imageVisionEnabled=true`) only
  on a turn that actually contains one, because a headless run has no way to prompt.
- `cmdcode.setApiKey` — **Command Code: Set API Key**. Stores the credential in VS Code's
  `SecretStorage`, never in `settings.json`.
- `cmdcode.imageSupport` (default `true`), `cmdcode.enableCliProvider` (default `true`),
  `cmdcode.enableApiProvider` (default `true`) and `cmdcode.zeroDataRetention` (default `false`).
- A `catalog-update` issue form, so a model that changes upstream is reported with the evidence
  needed to fix it: the model id, what the extension shows, what the CLI reports, and both versions.
- `scripts/sync-capabilities.mjs`, which regenerates the per-model capability flags from the CLI's
  own catalog and reports any drift.

### Changed

- **The providers are now displayed as "Command Code CLI" and "Command Code API"** rather than the
  single "Command Code" group, because they are different capabilities rather than two modes of one.
  Either can be switched off independently.
- **`imageInput` is now advertised per model**, transcribed from the vendor's own capability
  catalog. 62 of the 82 models can read images. The previous blanket `false` was wrong; so would
  have been a blanket `true` — 20 models genuinely cannot.
- **`toolCalling` is now advertised per provider.** It is `true` on the API group, where the loop is
  real, and `false` on the CLI group, where it is not.
- The README documents the two providers, images, the capability table, the plan gate, and how to
  report a catalog change.

### Fixed

- Nothing was dropped silently. Both documented tool constraints are now handled rather than
  discovered: remote `mcp` tools are rewritten to `type: "function"` (the API rejects them because
  the upstream would dial the user's server on Command Code's credential), and under zero data
  retention the tool array is filtered to the documented safe set rather than sent and refused.

### Known

- **The CLI group is hidden in Copilot's Agent session.** VS Code's Agent mode lists only
  tool-capable models, and the CLI path cannot honestly claim that flag — the CLI runs its tools
  in-process and never yields to a host. The models remain available in Ask and Chat. This is the
  same fact as the tool limitation, seen from the picker.
- **A Go-plan user has no API access**, which is the vendor's design: Go is the only plan without
  it. The `403 upgrade_required` is surfaced verbatim rather than hidden behind a silent fallback to
  the CLI, because a billing problem should not look like a slower model.

## [0.2.0]

This release changes the extension's marketplace identity. **The extension ID changes, so it must
be reinstalled — existing installs of `cmdcode.cmdcode` are not upgraded automatically.**

| | Before | After |
| --- | --- | --- |
| Extension ID | `cmdcode.cmdcode` | `devparanjay.command-code-provider` |
| Display name | Command Code | Command Code Provider |
| Publisher | `cmdcode` | `devparanjay` |

### Added

- A rewritten README for the Marketplace and GitHub: a what-it-does summary, requirements,
  quick start, settings and command tables, feature and performance sections, a privacy and
  security section, troubleshooting keyed on real log output, and links.
- **Trademarks and affiliation** section. This is an independent community project, not affiliated
  with, endorsed by, sponsored by or supported by Command Code. It covers the model names, the
  third-party marks, the icon's provenance, and a commitment to act on trademark requests.
- A **license and warranty** section stating AGPL-3.0-or-later and the absence of warranty.
- A new extension icon built from the official Command Code symbol with a `PROVIDER` caption
  strip, generated from the vendor's own `symbol.svg` by `scripts/make_icon.py`. The previous icon
  was unrelated placeholder artwork, and an intermediate hand-transcription of the SVG paths
  produced a broken mark; the script now rasterises the real artwork instead.
- Tests pinning the three-way identity split — marketplace name, provider vendor id, and
  display name — so they cannot be conflated again, and asserting the `cmdcode.*` settings and
  command namespace survives the rename.

### Changed

- Command titles, the output channel, and the log prefix are now `Command Code` rather than
  `Cmd Code`, matching the new display name. **Command ids are unchanged**
  (`cmdcode.showLog`, `cmdcode.copyDiagnostics`, `cmdcode.restartProvider`), so keybindings and
  `settings.json` keep working.
- **Settings are unchanged and still namespaced `cmdcode.*`.** The namespace is independent of
  the publisher, so renaming it would have silently reset every user's configuration.
- The provider still registers under the vendor id `cmdcode` and still displays as **Command Code**
  in the model picker. Only the extension's marketplace identity changed; the provider name the
  user sees is deliberately unaffected.

## [0.1.3]

### Fixed

- Every reply was prefixed with `Working…`. The extension reported a
  `LanguageModelTextPart('Working…')` before the first token to fill the ~3–4 s
  the CLI takes to start, but every part reported to `progress` becomes
  response **content** and cannot be retracted — so the placeholder stayed in
  the transcript permanently:

      Working…Hello! I'm working in the cmdcode-vsc VS Code extension…

  The stable API offers no non-content channel for it. `LanguageModelResponsePart`
  is a closed union of `LanguageModelTextPart | LanguageModelToolResultPart |
  LanguageModelToolCallPart` — all content — and
  `ProvideLanguageModelChatResponseOptions` carries no progress handle. The
  placeholder is removed rather than reworded; Copilot renders its own pending
  state while it waits.

### Removed

- `cmdcode.showThinkingPlaceholder`. It only ever controlled whether a fabricated
  token was prepended to the answer, and the answer should never contain one.
  The setting is gone from the manifest, `CmdCodeConfig`, `CONFIG_DEFAULTS` and
  the README rather than left as a no-op.

### Changed

- The provider now emits nothing before the model's first token. Tests assert
  this directly, including that a silent run produces exactly one part (the
  explanation) and no padding.

## [0.1.2]

### Fixed

- The models now appear in Copilot Chat's model picker. They advertised
  `toolCalling: false`, and VS Code filters the model list for the **Agent**
  session through
  `(m) => (m.capabilities?.agentMode ?? true) && !!m.capabilities?.toolCalling`.
  With the flag false, every one of the 82 models was dropped before the picker
  rendered — so the provider registered fine, the models were listed in the
  Language Models window, and the picker was empty in the mode Copilot opens in.

  `toolCalling` is now `true`. This is a true statement about the models: the
  Command Code CLI executes tools in-process (`tool_running` → `execGuarded` →
  `tool_completed`) and never yields for a host to run one. The extension still
  emits no `LanguageModelToolCallPart` and still ignores `options.tools`, so
  Copilot sends no tool schemas and tool calls do not appear in the chat's tool
  UI. Nothing is dropped — Copilot simply never asks.

  `imageInput` stays `false` and is unchanged: the prompt path renders text
  parts only, so an image part would be discarded. Advertising vision would be a
  lie until `buildPrompt` forwards `LanguageModelDataPart`.

### Changed

- README and the `catalog-to-chat.ts` capability comment now describe what the
  flag does and does not imply, instead of claiming "no tool calling".
- Tests assert `toolCalling: true` against the projection, with the Agent-mode
  filter quoted, so the flag cannot silently regress back to false.

## [0.1.1]

### Fixed

- The extension registered no models in VS Code. It called
  `vscode.lm.registerLanguageModelChatProvider('cmdcode', …)` without declaring
  the `cmdcode` vendor in `contributes.languageModelChatProviders`, and VS Code only
  admits a vendor that its own manifest declares. The call was rejected in the
  extension host with `Chat model provider uses UNKNOWN vendor cmdcode.`, so the
  model picker stayed empty — while the output channel still logged
  `Cmd Code: activated`, because the rejection lands in another process after
  `activate()` resolves. The CLI was found and working throughout; only the
  registration was refused.

### Added

- `contributes.languageModelChatProviders` now declares the `cmdcode` vendor, which
  is what puts Cmd Code's models in the picker and gives the extension its
  marketplace `language-models` tag.
- The `onLanguageModelChatProvider:cmdcode` activation event, which VS Code
  generates from that contribution, alongside `onStartupFinished`.
- A regression test that reads `VENDOR_ID` out of `src/types.ts` and asserts the
  manifest declares it. The manifest and the source were two unconnected string
  literals, so nothing failed until the provider was run inside a real VS Code.
- The `Machine Learning` category, matching the other language model providers.
- The provider now appears in the model picker as **Command Code** rather than
  `Cmd Code`. The vendor id stays `cmdcode`, so no model id changes.
- The extension itself is listed as **Command Code** in the extensions view.
- Concurrent turns no longer orphan a live CLI process. `cancel()` signalled only the
  newest of several overlapping runs, so an earlier run kept streaming into a chat the
  user had navigated away from.
- `cancel()` can no longer deadlock. It waited on the completion promise of the run it
  had just sent `SIGTERM`, so a CLI slow to honour the signal left the caller waiting on
  the process it was trying to stop.
- One run finishing no longer destroys another run's `SIGKILL` escalation, which could
  leak a process permanently whenever the CLI was slow to honour `SIGTERM`.
- The pre-spawn cancel latch is now scoped to a run that has no live child, so a
  cancellation issued during one run no longer suppresses an unrelated later turn.

## [0.1.0]

### Added

- Initial scaffold: extension manifest, TypeScript/vitest/tsup toolchain, and a shared `vscode`
  test stub.
- Declares the `cmdcode` language model vendor, the six `cmdcode.*` settings, and the
  `cmdcode.showLog`, `cmdcode.copyDiagnostics` and `cmdcode.restartProvider` commands.

Provider registration, the model catalog, CLI transport, and the chat provider land in
subsequent releases.
