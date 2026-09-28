# Changelog

All notable changes to the Cmd Code VSC extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

### Added

- Initial scaffold: extension manifest, TypeScript/vitest/tsup toolchain, and a shared `vscode`
  test stub.
- Declares the `cmdcode` language model vendor, the six `cmdcode.*` settings, and the
  `cmdcode.showLog`, `cmdcode.copyDiagnostics` and `cmdcode.restartProvider` commands.

Provider registration, the model catalog, CLI transport, and the chat provider land in
subsequent releases.
