# Changelog

All notable changes to the Cmd Code VSC extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
