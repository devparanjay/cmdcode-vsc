# Changelog

All notable changes to the Cmd Code VSC extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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
