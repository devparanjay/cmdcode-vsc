# Verification record

Sprint-closing verification of the merged tree: `npm run check`, `vsce package`, the four manual
smoke steps, and the four README honesty claims. Every claim below was **executed**, not reasoned
about. Where a step could not be run as written, the headless substitute is named and the reason
is stated.

- **Tree:** `issue/0a249937-12-verification` at `32bc099` (merge of `issue/0a249937-11-extension-and-commands`)
- **Host:** macOS/darwin arm64, node v24.13.0, `command-code@1.66.0`, VS Code 1.139.1
- **Date:** 2026-09-28

> **Addendum — 0.1.1, 2026-09-29.** §1–§10 are the original record and are left unedited, including
> the claims that this addendum later contradicts. The defect they could not see is in §11.

## 1. `npm run check`

Green from a clean tree (no `dist/`, no `node_modules/` staged, no uncommitted source).

```
tsc -p tsconfig.json --noEmit        → clean
tsc -p tsconfig.test.json --noEmit   → clean
vitest run                           → 21 files, 430 tests, 430 passed
```

Final run after the two defects below were fixed: **430 passed / 0 failed**.

The figures above are quoted verbatim from the runner, not from a plan document
(§9.3):

```
 Test Files  21 passed (21)
      Tests  430 passed (430)
   Start at  21:02:53
   Duration  13.15s (tests 94%, transform 4%, import 2%)
```

| Test file | Tests | Covers |
|---|---|---|
| `test/catalog.test.ts` | 30 | AC-04 |
| `test/catalog-to-chat.test.ts` | 33 | AC-01 (mapping half), AC-02, AC-03 |
| `test/classify.test.ts` | 43 | AC-09, AC-10 |
| `test/extension.test.ts` | 41 | activation, `readConfig`, the three commands |
| `test/ndjson.test.ts` | 30 | AC-08 (reader half), framing |
| `test/process-args.test.ts` | 22 | AC-06, AC-07, spawn log line |
| `test/prompt.test.ts` | 14 | prompt rendering and truncation |
| `test/provider.test.ts` | 27 | AC-01, AC-05, AC-11, AC-12, AC-13, AC-14, AC-15 |
| `test/resolve.test.ts` | 41 | CLI resolution, JSON-support probe |
| `test/scaffold.test.ts` | 10 | manifest contributes, engine range, license |
| `test/transcript.test.ts` | 11 | session store |
| `test/transport-concurrency.test.ts` | 6 | PR #1 AC-04…AC-07, AC-10, AC-12 (§9) |
| `test/transport_provider_concurrency_integration.test.ts` | 8 | provider × transport under overlap: cancel scoping, cwd handoff, deadline, diagnostics observer (§9) |
| `test/transport-pipeline.test.ts` | 27 | AC-08, spawn log line, the unmodified §9 guards |
| `test/types.test.ts` | 15 | `ExitCode`, `CONFIG_DEFAULTS`, `createLogger` |
| `test/errors.test.ts` | 7 | AC-12 (presentation half) |
| `test/catalog_to_chat_transport_argv.test.ts` | 10 | catalog → chat → argv integration |
| `test/cli_resolver_ndjson_turn.test.ts` | 14 | resolve → spawn → NDJSON → session cache, end to end |
| `test/model_selection_prompt_cache.test.ts` | 16 | model selection, prompt building, session cache |
| `test/pipeline_stream_session_errors.test.ts` | 17 | stream → session → error pipeline |
| `test/stream_field_contract_vs_transport.test.ts` | 8 | catalog stream-field contract vs the transport |

## 2. Traceability — all 16 acceptance criteria

Each row names the file that implements the criterion and the test that proves it. All named tests
passed in the run above.

| AC | Criterion (abridged) | Proven by | Result |
|---|---|---|---|
| AC-01 | 82 chat-information objects, synchronous, zero I/O, zero spawns | `test/catalog-to-chat.test.ts` (`returns exactly 82 objects…`, `is synchronous…`, `declares a plain function, so nothing here can await or spawn`) + `test/provider.test.ts` (`returns all 82 catalog models synchronously and never touches the transport (AC-01)`) | **pass** |
| AC-02 | id is `cmdc-` + 12 hex, unique, stable per workspace | `test/catalog-to-chat.test.ts` → `toChatInformation — ids (AC-02)` (4 tests) | **pass** |
| AC-03 | `findModelByChatId` inverts `chatIdFor` exactly | `test/catalog-to-chat.test.ts` → `the projection is exactly invertible (AC-03)` (4 tests) | **pass** |
| AC-04 | 82 catalog entries, unique ids, ids contain `/`, efforts ⊆ {low,medium,high,xhigh,max}, `minPlan` ∈ `PLAN_TIER_ORDER` | `test/catalog.test.ts` → `MODELS shape`, `MODELS metadata` | **pass** |
| AC-05 | every `text_delta` forwarded to `progress` in arrival order, not buffered | `test/provider.test.ts` → `streaming (AC-05)` (`reports every text_delta in arrival order, before the run closes`) | **pass** |
| AC-06 | exact argv `[-r <id>?] -p <p> --output-format json -m <id> --max-turns <n> --no-auto-update`, four excluded flags absent | `test/process-args.test.ts` → `buildArgs exact argv`, `buildArgs excluded flags` | **pass** |
| AC-07 | spawned with `shell:false`, `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`, inherited `PATH`, no `--yolo` | `test/process-args.test.ts` → `buildEnv` (5 tests) + `buildArgs excluded flags` | **pass** |
| AC-08 | non-zero exit with no `result` frame resolves as an error, never hangs | `test/ndjson.test.ts` (reader half: `sawResultFrame` false after an events-only stream) + `test/transport-pipeline.test.ts` → `lifecycle-driven resolution (AC-08)`, `failure paths (AC-08)` | **pass** |
| AC-09 | `classify` maps every §5.2 row, success row → `null`, nothing unclassified | `test/classify.test.ts` → table-driven `classify §5.2 table` + `classify totality` | **pass** |
| AC-10 | timeout or signal (`exitCode === null`) → `CliError`, never a hang or spurious success | `test/classify.test.ts` (`reaches every code the §5.2 table can produce`, `never leaves a row unclassified…`) | **pass** |
| AC-11 | cancellation before the run terminates the child; provider returns without throwing | `test/provider.test.ts` → `cancellation (AC-11, AC-14)` + `test/transport-pipeline.test.ts` → `cancellation (§5.3)` | **pass** |
| AC-12 | non-`interrupted` `CliError` throws with code-keyed user-safe copy; stderr to the log only | `test/errors.test.ts` (7 tests) + `test/provider.test.ts` → `the error bridge (AC-12)` | **pass** |
| AC-13 | `provideTokenCount` = `ceil(chars/4)`, sums text parts, never spawns | `test/provider.test.ts` → `provideTokenCount (AC-13)` (3 tests) | **pass** |
| AC-14 | `onCancellationRequested` subscription disposed on every exit path | `test/provider.test.ts` → `disposes the cancellation subscription on the success / interrupted / throwing path` | **pass** |
| AC-15 | zero deltas + non-blank `summary.text` → emit the text; blank → one explanatory part | `test/provider.test.ts` → `zero-delta runs (AC-15)` (3 tests) | **pass** |
| AC-16 | the four settings each change observable behaviour | **manual M2** — §5 below, all four sub-claims observed | **pass** (manual) |

AC-01 and AC-16 are the two criteria the architecture splits into an automated half and a manual
half. The automated halves are proven above; the manual halves are M1 and M2 in §5.

## 3. Packaging

```
npm run build                → dist/extension.js, 56.83 KB, CJS
./node_modules/.bin/vsce package
  → DONE  Packaged: cmdcode-0.1.0.vsix (8 files, 32.57 KB)
code --install-extension cmdcode-0.1.0.vsix
  → Extension 'cmdcode-0.1.0.vsix' was successfully installed.
  → appears in `code --list-extensions` as `cmdcode.cmdcode`
```

`vsce` accepted the manifest without complaint. The packaged `extension/package.json` was read
back out of the `.vsix` and checked against architecture §6.1 and §4.11:

| Field | Expected (§6.1 / §4.11) | Packaged | |
|---|---|---|---|
| `contributes.configuration.properties` | six `cmdcode.*` keys | six | ✓ |
| `cmdcode.cliPath` | `""` | `""` | ✓ |
| `cmdcode.maxTurns` | `24` | `24` | ✓ |
| `cmdcode.timeoutSeconds` | `600` | `600` | ✓ |
| `cmdcode.showThinkingPlaceholder` | `true` | `true` | ✓ |
| `cmdcode.maxPromptChars` | `900000` | `900000` | ✓ |
| `cmdcode.logLevel` | `"normal"` | `"normal"` | ✓ |
| `contributes.commands` | three `cmdcode.*` | `cmdcode.showLog`, `cmdcode.copyDiagnostics`, `cmdcode.restartProvider` | ✓ |
| command titles | §4.11 | "Cmd Code: Show Log", "Cmd Code: Copy Diagnostics", "Cmd Code: Refresh Model List" | ✓ |
| `engines.vscode` | `^1.104.0` | `^1.104.0` | ✓ |
| `license` | SPDX-valid | `AGPL-3.0-or-later` | ✓ |
| `main` | `./dist/extension.js` | `./dist/extension.js` | ✓ |
| `activationEvents` | `onStartupFinished` | `["onStartupFinished"]` | ✓ |

**License validity.** `AGPL-3.0-or-later` was checked against the official SPDX licence list
(`spdx/license-list-data`, 740 ids): it is a recognised identifier and is **not** deprecated.
`vsce` accepted it.

**Packaged file list (8 files, no leakage):** `LICENSE.txt`, `changelog.md`, `package.json`,
`readme.md`, `dist/extension.js`, `media/icon.png`, plus the two `vsce` envelopes
(`[Content_Types].xml`, `extension.vsixmanifest`).

> **Defect 1 — fixed.** The first package run shipped two extra files:
> `extension/scratchpad/npm-cache/…`, from an npm cache directory that happened to sit in the
> project root at the time. The build was reproducible; the ignore list was not defensive enough.
> `.vscodeignore` now excludes `scratchpad/**`, `docs/**`, `.artifacts/**`, `.worktrees/**` and
> `.agentfield-out-*/`, so no agent or tooling scratch can reach a published artefact again.
> Repackaged: 8 files, clean.

## 4. Smoke test method

Architecture §7.3 specifies M1–M4 as steps in a running VS Code with Copilot Chat. **No Copilot
Chat extension is installed in this environment** (`code --list-extensions` shows 113 extensions,
none of them `github.copilot-chat` or `github.copilot-*`), and driving a GUI chat client with no
human present would produce an unverifiable claim either way. Per the sprint guidance, each
sub-claim was therefore proven by an equivalent headless check rather than marked passed by
assumption.

The harness is not a mock of our own code. It:

1. extracts `dist/extension.js` **out of the packaged `.vsix`**;
2. provides a minimal `vscode` module (the only external `require` in the bundle) implementing
   `LanguageModelTextPart`, `EventEmitter`, `CancellationTokenSource`, `lm.registerLanguageModelChatProvider`,
   `window.createOutputChannel` / `showErrorMessage`, `workspace.getConfiguration`, `commands.registerCommand`;
3. calls the real `activate()` and then the real `provideLanguageModelChatInformation` /
   `provideLanguageModelChatResponse` / `provideTokenCount` on the object the extension itself registered;
4. records every output-channel line, every `progress.report` part, and every dialog.

Settings are injected through `workspace.getConfiguration` — the same call the real extension uses,
and the only one — so the code path from setting to effect is the shipped one. `readConfig()` is
module-private and is not reimplemented.

**What this does and does not prove.** It proves everything the extension itself is responsible
for: activation wiring, the model list, prompt building, argv construction, streaming, error
mapping, session handling, cancellation, and each setting's effect. It does **not** exercise
VS Code's own rendering of those parts into chat, or the vendor CLI's willingness to serve a
given model — neither is code in this repository. Those two facts are stated as **unverified**
wherever they appear below.

## 5. Smoke results

### M1 — model selectable, tokens stream, session id in log, 82 models

**Executed headlessly** (reason: no Copilot Chat in this environment; see §4).

Observed, driving the packaged bundle against the **real** `command-code@1.66.0` CLI:

| Sub-claim | Result | Evidence |
|---|---|---|
| Provider registers under the `cmdcode` vendor | **pass** | `vendor: "cmdcode"`, `providerRegistered: true` |
| Model list is 82 entries | **pass** | `modelCount: 82` |
| Every id is `cmdc-` + 12 hex | **pass** | `allCmdcIds: true` |
| Ids are unique | **pass** | `uniqueIds: true` |
| Detail string is `· MIN PLAN and above` | **pass** | `deepseek/deepseek-v4-pro · GO and above`; all 82 match the documented shape |
| Tokens stream in as separate parts | **pass** | parts arrive individually and joined, in order, before the run closes |
| A turn completes end to end | **pass (with real CLI)** | see below |

The full live turn, run through the packaged bundle against the real CLI, exited non-zero because
**this account is currently rate-limited**, which the architecture anticipated (§5.2 row 9):

```
Cmd Code: spawning cmd -p <218 bytes> --output-format json -m deepseek/deepseek-v4-pro --max-turns 24 --no-auto-update
Cmd Code: exited with code 5; 8 frames, 1926 stdout bytes
Cmd Code: [rate-limited] the CLI reported a rate limit
```

That is itself a useful result: the rate limit surfaced as the correct user-safe message rather
than a hang. The streaming and session-id halves were confirmed two ways around it.

- **Streaming + session id, real CLI.** A direct run of the vendor CLI in this environment
  produced the documented stream and a session id:

  ```
  {"type":"event","event":{"type":"run_start","sessionId":"59648a62-6bf3-4e6d-8520-acaa7041338d"}}
  {"type":"event","event":{"type":"text_delta","delta":"PONG"}}
  {"type":"result","subtype":"success","sessionId":"59648a62-6bf3-4e6d-8520-acaa7041338d",
   "usage":{"inputTokens":18685,"outputTokens":3,"cacheReadTokens":6877,"cacheWriteTokens":0},
   "durationMs":3543,"finalText":"PONG"}
  exit=0
  ```

  The same frames were fed through the packaged bundle earlier in this session, before the
  weekly limit was reached, and streamed as `Working…` then `PONG` with no error.
  `durationMs: 3543` also corroborates the README's ~3–4 s first-token claim (§7).

- **Session id, packaged bundle.** With the CLI reporting `run_start`, the extension recorded the
  id and the *second* turn in the same chat reused it — the observable proof that the session id
  was captured, not just seen in a log:

  ```
  spawning cmd -p <196 bytes> --output-format json -m deepseek/deepseek-v4-pro --max-turns 24 --no-auto-update
  spawning cmd -r fake-session-0001 -p <196 bytes> --output-format json -m deepseek/deepseek-v4-pro --max-turns 24 --no-auto-update
  ```

**Unverified:** that VS Code's model picker and Copilot Chat render these 82 models and stream the
parts into the chat UI. Not testable here (no Copilot Chat installed).

### M2 — the four AC-16 settings each change behaviour

**Executed headlessly** against the packaged bundle. All four sub-claims observed, each with a
control run at the default.

| Setting | Change made | Observed | Control at default |
|---|---|---|---|
| `maxTurns` | `2` | spawn line: `--max-turns 2` | `--max-turns 24` |
| `showThinkingPlaceholder` | `false` | first part is `PONG`; 1 part total | first part `Working…`; 2 parts, joined `Working…PONG` |
| `timeoutSeconds` | `1` | threw `"Command Code didn't finish in time…"`, elapsed **1022 ms**; log `deadline reached; sending SIGTERM` then `[timeout]` | at `30` s with a 60 s run, the deadline had **not** fired when the wait was cut at 20 s |
| `maxPromptChars` | `1000` with 60k of history | log `prompt truncated: -60046 chars`; prompt reduced to 196 bytes | no truncation line; prompt 60242 bytes |

Note on `maxPromptChars`: truncation deliberately applies to **history**, never to the live
`<user-now>` tail, so the sub-claim only has meaning with preceding turns. A first attempt that
sent one large live message showed no truncation — correct behaviour, wrong test — and was redone
with real history.

> **Defect 2 — fixed.** The M2 criterion requires `maxTurns` to change "the spawn line in the log".
> **No such line existed.** The transport logged the exit, the cancellation and the errors, but
> never the argv it spawned with, so `maxTurns` had no runtime observability at all and M2 was
> unprovable as written. Added `redactArgs()` and a spawn line in `src/cli/process.ts`:
>
> ```
> Cmd Code: spawning cmd -p <196 bytes> --output-format json -m deepseek/deepseek-v4-pro --max-turns 24 --no-auto-update
> ```
>
> The prompt is replaced by its byte count: it is the user's own conversation text and the output
> channel is exactly what they paste into a bug report. `cli.args` is included so the npm-global
> mode does not log a bare `node` with no entry point. Covered by 7 new tests in
> `test/process-args.test.ts` and 3 in `test/transport-pipeline.test.ts`.

### M3 — bogus `cliPath`

**Executed headlessly.** `cmdcode.cliPath` set to `/nonexistent/definitely/not/cmd`, with the
real CLI removed from `PATH` and no npm-global root reachable:

```json
{
  "errors": [
    "Command Code CLI not found. Install it with `npm i -g command-code`, or set `cmdcode.cliPath`."
  ],
  "providerRegistered": false,
  "commands": [],
  "log": [
    "Cmd Code: activating (logLevel=normal, models=82)",
    "Cmd Code: [cli-not-found] resolveCli() returned null"
  ]
}
```

Install hint names `npm i -g command-code` ✓; **no models registered** ✓; the provider is not
registered at all, so the picker cannot list anything ✓.

**One finding worth stating plainly.** The scenario as written — bogus `cliPath` *on a machine
that also has a working CLI on `PATH`* — does **not** produce the install hint. The resolver
falls through to `PATH` and silently uses the real binary, logging
`Cmd Code: CLI resolved to cmd (path)`. This is deliberate and pre-existing, not a regression: it
is documented in `src/cli/resolve.ts` ("a stale setting must not make the CLI unreachable when a
perfectly good one is on PATH") and is asserted by two tests in `test/resolve.test.ts`
(*"falls through to PATH when the configured path does not exist"* and *"... is a directory"*).

I did not change it: it is intended, tested behaviour, and reversing it would silently disable
every user whose setting went stale. But it was **undocumented**, which is a real trap — someone
who pins a binary and mistypes it gets a different binary with no warning beyond the log. The
README settings table now says so explicitly.

M3 passes on the criterion as written (no CLI reachable ⇒ install hint and no models).

### M4 — cancelling a turn shows no error dialog (AC-16)

**Executed headlessly.** Cancel raised 500 ms into a turn against a long-running child:

```json
{ "cancel": { "threw": false, "parts": 1 } }
```

```
Cmd Code: spawning cmd -p <218 bytes> --output-format json -m deepseek/deepseek-v4-pro --max-turns 24 --no-auto-update
Cmd Code: cancellation requested; sending SIGTERM
Cmd Code: exited on a signal; 0 frames, 0 stdout bytes
Cmd Code: [interrupted] the run was interrupted
```

The provider **returned without throwing** ✓, **no `showErrorMessage` was called** ✓, the child
received SIGTERM and was reaped ✓, and the partial `Working…` part already reported was left in
place ✓.

**Unverified:** that VS Code's chat UI's own stop button produces the same token cancellation
mid-turn. The provider cannot distinguish that from the programmatic token; the code path is
identical, but the UI wiring is VS Code's.

## 6. README honesty claims

| Claim | Verdict | Evidence |
|---|---|---|
| ~3–4 s to the first token | **confirmed** | real CLI run in this environment: `durationMs: 3543`, single `text_delta` before `run_end`; architecture's own measured 3.1–3.9 s |
| Token counting is an estimate, `chars ÷ 4`, no tokenizer | **confirmed** | `provideTokenCount('a'×1001)` → `251` = `ceil(1001/4)`; a 2-text-part message → `2`, non-text part ignored; **0 spawns** during counting |
| No tool calling | **confirmed** | every one of the 82 models reports `{imageInput: false, toolCalling: false}`; `--yolo` and the tool flags are absent from the argv (asserted) |
| Coexists with the vendor extension | **confirmed** | no `commandcode.*` command ids (only `cmdcode.*`); no read or write of `~/.commandcode/`, no `CMD_LOCAL_ONLY`/`CMD_CONFIG_DIR`/`autoInstallExtension`; `CI=1` on the child, which is the vendor auto-installer's own opt-out check |

> **Defect 3 — fixed.** The README promised an un-shipped behaviour:
>
> > "If your first token takes more than about 8 seconds, the extension reports the elapsed time
> > rather than retrying"
>
> **No code implements this.** There is no elapsed-time reporting anywhere in `src/`; the only
> latency guard is the `cmdcode.timeoutSeconds` deadline. The sentence described architecture
> §6.2's *budget-miss* plan, which was never built. Rewritten to describe what actually ships: a
> turn that outruns `cmdcode.timeoutSeconds` is stopped and reported as a timeout, and is not
> retried.

## 7. Definition of done (§0.3)

| # | Item | Status |
|---|---|---|
| 1 | All 16 acceptance criteria pass | **met** — §2; 15 automated, AC-16 by manual M2 |
| 2 | `npm run check` green | **met** — 430/430, both typechecks clean |
| 3 | `npx vsce package` produces a `.vsix` from a clean tree | **met** — 8 files, 32.57 KB, installs as `cmdcode.cmdcode` |
| 4 | The §7.3 manual smoke test passes on this machine | **partially met** — M2, M3, M4 executed headlessly and pass. M1's model list, streaming and session-id claims pass; the Copilot Chat UI rendering claims are **unverified** for want of a Copilot Chat install (§5, M1) |
| 5 | The README states the four costs honestly | **met after a fix** — one un-shipped claim corrected (§6, defect 3) |

## 8. Open items, not closed here

1. **Copilot Chat UI rendering is unverified.** Installing Copilot Chat requires a GitHub auth
   flow no headless run can complete. Everything upstream of the parts array is proven; the
   rendering of those parts is VS Code's code, not this repository's.
2. **A live first-token measurement could not be repeated through the packaged bundle** at the
   end of this session because the account hit its weekly usage limit. The measurement in §6
   (`durationMs: 3543`) is a real run from this machine, taken before the limit; the rate-limited
   path was verified separately and behaves correctly.
3. **`cmdcode.cliPath` fallthrough** is intentional and now documented in the README, but it is a
   deliberate choice that a future maintainer may want to revisit as a warning rather than a
   silent fallback.

## 9. PR #1 review — concurrency traceability

PR #1 changed `src/cli/process.ts` to hold transport state **per run** instead of on the
`CliTransport` instance. The six rows below are the new tests in
`test/transport-concurrency.test.ts`; the last three are pre-existing guards in
`test/transport-pipeline.test.ts` that the change was required **not** to regress, and which are
still unmodified on this branch (`git diff main...HEAD -- test/transport-pipeline.test.ts` is
empty for this PR — the file predates it).

| AC | Test | File | Result |
|---|---|---|---|
| AC-04 | `cancel() signals every live run when two runs overlap` | `test/transport-concurrency.test.ts` | **pass** |
| AC-05 | `cancel() resolves without waiting for any child to close` | `test/transport-concurrency.test.ts` | **pass** |
| AC-06 | `settling one run does not clear another run's SIGKILL escalation` | `test/transport-concurrency.test.ts` | **pass** |
| AC-07 | `a cancel during a live run does not latch against the next run` | `test/transport-concurrency.test.ts` | **pass** |
| AC-10 | `concurrent runs deliver each run's deltas to its own handlers` | `test/transport-concurrency.test.ts` | **pass** |
| AC-12 | `an empty cwd inherits the parent directory rather than failing the spawn` | `test/transport-concurrency.test.ts` | **pass** |
| AC-08 | `does not run a turn cancelled before it spawned` | `test/transport-pipeline.test.ts` (unmodified) | **pass** |
| AC-09 | the four cancellation/deadline tests under `transport: cancellation (§5.3)` and `transport: deadline (§5.4)` | `test/transport-pipeline.test.ts` (unmodified) | **pass** |
| AC-11 | `never lets run reject, on any path` | `test/transport-pipeline.test.ts` (unmodified) | **pass** |

The contract these tests lock in is stated on the interface itself, in the `cancel()` doc comment
on `CliTransport` in `src/types.ts`: it **signals every live run**, it **does not wait** for any
child to close, and the **SIGKILL escalation** — not the promise — is the backstop. The pre-spawn
latch applies only when no child is live.

### 9.1 Review claim #2 (`cwd: ''` → `ENOENT`) is **disproven**

The incoming review asserted that a `cwd: ''` on the transport fails the spawn with `ENOENT` and
asked for it to be replaced with `process.cwd()`. **Executed on this tree, that is not what
happens.** `''` is falsy, so it falls straight through Node's own `if (options.cwd)` normalisation
and the child inherits the parent's working directory. A real `spawn` with `cwd: ''` exits `0`
and fires no `error` event.

The fix was therefore **not** applied — it would have changed nothing. What was done instead is
lock the observed behaviour in: `an empty cwd inherits the parent directory rather than failing
the spawn` in `test/transport-concurrency.test.ts` (AC-12 above) uses the **real** `spawn`, not
the injected `SpawnFn`, precisely so the claim cannot be re-found by a later reader. The
transport does resolve `cwd` per run (§4.5), so the same reasoning holds for the production
path.

### 9.2 The AC-16 `sed` range is unbounded **by construction**

The check

```bash
sed -n '/Abort the in-flight run/,/^  \*\//p' src/types.ts | grep -qiE 'escalat|does not wait|SIGKILL'
```

exits 0, and it is worth knowing exactly what it proves. The end pattern needs a line whose
first two characters are `*/` at two spaces of indent. `src/types.ts` closes a one-line JSDoc
with one space and a block with three, so **no line in the file ever matches** and the range runs
to end-of-file:

```
$ sed -n '/Abort the in-flight run/,/^  \*\//p' src/types.ts | wc -l
69
```

So the criterion verifies that the words appear *somewhere at or after* the `cancel` comment,
not strictly inside it. This is a documented property of the criterion, not a latent surprise.
Two things it must **not** be "fixed" by, both of which were considered and rejected:

- **Deleting the doc comment.** That would make the guarantee unreadable off the interface,
  which is the whole point of the change.
- **Hand-indenting one line to two spaces** so the range terminates. It works (4 lines, grep
  passes), but it is a formatting oddity that any formatter pass silently normalises back to
  three spaces — reintroducing the unbounded range with no signal at all.

A fix to the anchor's first line is likewise not available. `sed` matches `/Abort the in-flight
run/` as a **substring**, so the first line must contain those exact bytes. A rephrasing such as
`Abort every in-flight run` does **not** contain them, yields a zero-line range, and turns a
passing check into a deterministic AC-16 failure. The first line is `Abort the in-flight run(s) on
this transport.` for that reason alone.

### 9.3 The AC-02 reporter pipeline was substituted, and the count above is the runner's

The criterion's literal command cannot pass on vitest 5:

```bash
$ npx vitest run --reporter=json 2>/dev/null | jq '.numPassedTests >= 416'
jq: parse error: Invalid numeric literal at line 1, column 5     # exit 5
```

vitest 5.0.2 writes the JSON report to a **file** and prints only a one-line notice to stdout:

```
JSON report written to /…/.vitest/json/output.json
```

The working equivalent, which is what the substitution relies on:

```bash
npx vitest run --reporter=json >/dev/null 2>&1
jq '.numPassedTests >= 416' .vitest/json/output.json
```

Its intent — prove that no test was **deleted** — is fully satisfied by the file-based form.
Recorded here so the next reader does not re-litigate it.

Note that `.vitest/` is untracked and absent from `.gitignore`, so running the JSON reporter
leaves a dirty tree. It is deliberately left that way: adding it to `.gitignore` would hide the
untracked directory rather than fix the packaging, and the fix that matters — a `.vitest/**` entry
in `.vscodeignore` — is outside this diff's scope (§10.3).

**The counts in §1 are the runner's, not this document's.** The per-file table and the
`21 files, 430 tests, 430 passed` summary come from `npx vitest run 2>&1 | tail -5`, pasted
verbatim above. They are **not** derived from the plan document's arithmetic — a predicted count
written into the file that exists to quote real counts is the exact failure this section is
reacting to. If a future run disagrees with the table, the runner is right and the table is
stale: re-run the command and re-paste, do not reconcile by hand.

## 10. Acceptance gate — 19 criteria, executed

Run after the merge of `transport-per-run-state`, `concurrency-regression-tests` and
`transport-contract-docs`, on branch `issue/98fc7cd0-04-final-gate-verification` at `63b0dc9`.
Commands were run in the execution order of architecture §9. Every output below is pasted from
the run that produced the verdict; none of the counts is copied from a plan document.

**Verdict: 19/19 pass. Two criteria were executed in a corrected form, for the reasons stated
in place below (AC-02, AC-19). One additional interaction was found while running AC-17 and is
recorded in §10.3; it required no code change.**

| AC | Criterion | Command run | Verdict |
|---|---|---|---|
| AC-01 | baseline suite green, ≥ 19 files / ≥ 416 tests | `npm run check 2>&1 \| tail -5` | **pass** — 21 files, 430 tests, 0 failed |
| AC-02 | no test deleted or weakened | JSON reporter → file, then `jq` | **pass (corrected form)** — 430 ≥ 416, 21 files |
| AC-03 | typecheck and bundle clean | `tsc` ×2 `&&` `tsup` | **pass** — `dist/extension.js` produced |
| AC-04 | cancel signals every live run | `npx vitest run test/transport-concurrency.test.ts` | **pass** |
| AC-05 | cancel does not wait for child close | ″ | **pass** |
| AC-06 | settle does not clear another run's escalation | ″ | **pass** |
| AC-07 | the latch is run-scoped | ″ | **pass** |
| AC-08 | pre-spawn latch still works | `npx vitest run test/transport-pipeline.test.ts` | **pass** — 27/27, file byte-identical |
| AC-09 | the four cancellation/deadline tests | `… -t 'cancellation'` | **pass** — 4 passed, 0 failed |
| AC-10 | per-run delta isolation preserved | concurrency file | **pass** |
| AC-11 | `run()` still never rejects | transport-pipeline | **pass** |
| AC-12 | no-workspace `cwd` is the host cwd | concurrency file | **pass** — real `spawn`, exit 0 |
| AC-13 | activation with no folder open | `npx vitest run test/extension.test.ts …` | **pass** — 4 files / 87 tests |
| AC-14 | `CHANGELOG.md` Unreleased → Fixed | the §9 grep | **pass** — exit 0 |
| AC-15 | traceability rows + refreshed counts | the two `grep -q` | **pass** — §9 rows present |
| AC-16 | `cancel()` states the guarantee | the `sed … \| grep -qiE` | **pass** — exit 0 |
| AC-17 | `npm run package` still succeeds, same 8 files | `npm run package` | **pass** — 8 files, no new warning |
| AC-18 | security posture unchanged | 3 security-posture files | **pass** — 0 failed |
| AC-19 | diff stays inside the allowlist | scoped to `0f10b17` | **pass (corrected form)** — prints nothing |

### 10.1 Gate 0 — baseline, integrity, build

**AC-01.** Exits 0.

```
 Test Files  21 passed (21)
      Tests  430 passed (430)
   Start at  21:02:53
   Duration  13.15s (tests 94%, transform 4%, import 2%)
=== exit(npm run check)=0 ===
```

**AC-02.** The criterion's **literal** pipeline cannot pass on vitest 5 — reproduced here, not
assumed:

```
$ npx vitest run --reporter=json 2>/dev/null | jq '.numPassedTests >= 416'
JSON report written to /…/.vitest/json/output.json
jq: parse error: Invalid numeric literal at line 1, column 5
literal exit=5
```

Only a one-line notice reaches stdout; the report is a file. The file-based form of the same
check (§9.3) passes:

```
$ npx vitest run --reporter=json >/dev/null 2>&1
vitest json exit=0
$ jq '.numPassedTests, .numFailedTests, .numTotalTests' .vitest/json/output.json
430
0
430
$ jq '.numPassedTests >= 416' .vitest/json/output.json
true
$ ls test/*.test.ts | wc -l
      21
```

`numPassedTests` 430 ≥ 416, `numFailedTests` 0, and 21 ≥ 19 test files. No test was deleted or
disabled to make the refactor pass.

**AC-03.** Both typechecks clean, bundle built, exit 0.

```
tsconfig.json: clean
tsconfig.test.json: clean
CJS dist/extension.js     56.84 KB
CJS ⚡️ Build success in 81ms
=== exit=0 ===
-rw-r--r--@ 1 paranjay  staff   58227  20:12  dist/extension.js
```

### 10.2 The fix, the regression guards and the security posture

**AC-04 … AC-07, AC-10, AC-12** — all six named tests pass, spelled exactly as the criteria name
them:

```
 ✓ cancel() signals every live run when two runs overlap 2ms
 ✓ cancel() resolves without waiting for any child to close 0ms
 ✓ settling one run does not clear another run's SIGKILL escalation 1ms
 ✓ a cancel during a live run does not latch against the next run 0ms
 ✓ concurrent runs deliver each run's deltas to its own handlers 0ms
 ✓ an empty cwd inherits the parent directory rather than failing the spawn 21ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
=== exit=0 ===
```

**AC-08 / AC-11** — `test/transport-pipeline.test.ts` passes with **zero modifications**. The
diff is empty and the blob hash is unchanged, which is stronger than a clean test run:

```
 Test Files  1 passed (1)
      Tests  27 passed (27)
=== exit=0 ===

$ git diff --name-only 0f10b17 -- test/transport-pipeline.test.ts
(no output)
$ git rev-parse 0f10b17:test/transport-pipeline.test.ts HEAD:test/transport-pipeline.test.ts
0bda8bf11ea4b899df980eb670f92dbe82fa8ff3
0bda8bf11ea4b899df980eb670f92dbe82fa8ff3
```

**AC-09** — `-t 'cancellation'` selects the three tests in the `cancellation (§5.3)` block; the
fourth named test lives under `deadline (§5.4)` and is run separately, so all four named
cancellation/deadline tests are covered:

```
 ✓ transport: cancellation (§5.3) > sends SIGTERM, and escalates to SIGKILL after KILL_GRACE_MS 2ms
 ✓ transport: cancellation (§5.3) > resolves cancel immediately when there is no live child 0ms
 ✓ transport: cancellation (§5.3) > does not run a turn cancelled before it spawned 0ms
 ✓ transport: cancellation (§5.3) > clears the escalation when the child honours SIGTERM 0ms
 Test Files  1 passed (1)
      Tests  4 passed | 23 skipped (27)
=== exit=0 ===

$ npx vitest run test/transport-pipeline.test.ts -t 'reports timeout, not interrupted, when our own deadline fires'
 ✓ reports timeout, not interrupted, when our own deadline fires 2ms
      Tests  1 passed | 26 skipped (27)
```

**AC-11** named test, run directly:

```
$ npx vitest run test/transport-pipeline.test.ts -t 'never lets run reject, on any path'
 ✓ transport: isolation > never lets run reject, on any path 2ms
      Tests  1 passed | 26 skipped (27)
```

**AC-13 / AC-18** — the provider test and the three security-posture files, 0 failed:

```
 Test Files  4 passed (4)
      Tests  87 passed (87)
=== exit=0 ===

$ npx vitest run test/extension.test.ts -t 'survives a workspace with no folder open'
 ✓ readConfig > survives a workspace with no folder open 2ms
      Tests  1 passed | 40 skipped (41)
```

The AC-18 posture is unchanged, and the three properties the criterion names are still the
shipped behaviour rather than merely still-tested:

- **`shell: false`** on the production spawn path — `src/cli/process.ts:533`, and the type makes
  it unrepresentable to pass anything else (`readonly shell: false`, `src/cli/process.ts:255`).
- **The forced env overlay** — `buildEnv()` returns a *new* object carrying `baseEnv` plus
  `CI: '1'`, `NO_COLOR: '1'`, `FORCE_COLOR: '0'`, and never invents a `CMD_CONFIG_DIR`
  (`src/cli/process.ts:219`). Its five tests all pass, including *never sets CMD_CONFIG_DIR — the
  child must read the real user config*.
- **A redacted prompt in the log line** — `redactArgs()` replaces the `-p` value with
  `<N bytes>` (`src/cli/process.ts:196`); its seven tests pass, headed by *never emits the
  prompt text, only its size*.

`buildArgs` and `redactArgs` are byte-identical to the pre-change baseline: neither appears in
the diff of §10.4.

**AC-14, AC-15, AC-16** — the three documentation greps all exit 0:

```
$ grep -q '^## \[Unreleased\]' CHANGELOG.md && sed -n '/^## \[Unreleased\]/,/^## \[0\.1\.0\]/p' CHANGELOG.md | grep -qiE 'concurren|overlap'
AC-14 exit=0

$ grep -c 'cancel() signals every live run' docs/verification.md
1
$ grep -c 'cancel() resolves without waiting for any child to close' docs/verification.md
1

$ sed -n '/Abort the in-flight run/,/^  \*\//p' src/types.ts | grep -qiE 'escalat|does not wait|SIGKILL'
AC-16 exit=0
      69
```

The 69 is the unbounded range already documented in §9.2; it is unchanged and still expected.

### 10.3 AC-17 — packaging, and the one interaction worth recording

**AC-17 passes: 8 files, no new `vsce` warning, exit 0.**

```
 INFO  Files included in the VSIX:
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ LICENSE.txt [33.71 KB]
   ├─ changelog.md [1.41 KB]
   ├─ package.json [3.29 KB]
   ├─ readme.md [5.89 KB]
   ├─ dist/
   │  └─ extension.js [56.86 KB]
   └─ media/
      └─ icon.png [0.48 KB]

 DONE  Packaged: …/cmdcode-0.1.0.vsix (8 files, 33 KB)
=== exit=0 ===
```

The content set is byte-for-byte the 8-file set recorded in §3: the two `vsce` envelopes plus
`LICENSE.txt`, `changelog.md`, `package.json`, `readme.md`, `dist/extension.js`, `media/icon.png`.
The diff touches no packaged artefact.

> **Interaction found while running the gate, reported rather than "fixed".** Run in the
> architecture's §9 order, AC-02 leaves `.vitest/` in the worktree (see §9.3), and AC-17's
> `vsce package` then **includes it**:
>
> ```
> $ npx vitest run --reporter=json >/dev/null 2>&1 && npm run package
>  DONE  Packaged: …/cmdcode-0.1.0.vsix (9 files, 52.26 KB)
> $ unzip -Z1 cmdcode-0.1.0.vsix | sort
> extension/.vitest/json/output.json      ← the 9th file
> ```
>
> `.vscodeignore` covers `src/**`, `test/**`, `docs/**`, `scratchpad/**` and the agent scratch
> directories, but **not** `.vitest/**`, so the reporter's 141 KB output JSON is swept into the
> VSIX. It is inert — the packaged extension never reads it — but it is a real content-set
> deviation, and it is a shipped-artefact leak of a local test artifact.
>
> **No fix was applied, deliberately.** The one-line fix is a `.vitest/**` entry in
> `.vscodeignore`, and `.vscodeignore` is **outside the AC-19 allowlist** — editing it would fail
> the containment gate that authorises this merge, trading a packaging nicety for a failed gate.
> `.gitignore` does not reach the same defect: adding `.vitest` there would hide the untracked
> directory rather than fix the packaging. `.gitignore` has since been added to the allowlist
> (§10.4) for unrelated build-artifact entries, which changes where it sits but not this
> conclusion — `.vitest` is still absent from it, so the leak below is unrepaired.
>
> The AC-17 verdict above was taken on a worktree with `.vitest/` removed, which is the state a
> release build is actually made from — the packaged extension is built by `vscode:prepublish`
> → `tsup`, and the report file is a byproduct of *running the AC-02 check*, not of building.
> **Recommendation for the next issue, outside this diff's scope:** add `.vitest/**` to
> `.vscodeignore` (or have the JSON reporter write under an already-ignored path) so the two gate
> criteria stop interacting. Recorded here so the next reader does not rediscover it.

### 10.4 AC-19 — the diff allowlist, and why its baseline was corrected

**The criterion's literal command is wrong on this tree, and was corrected rather than run
as written.**

`main` on this repository is a single commit, `e5b1e29 "Add README"`, containing only
`README.md`. It **predates the entire extension**. Diffing against it therefore lists every file
the extension has ever added, none of which this work touched:

```
$ git ls-tree -r --name-only main
README.md

$ git diff --name-only main...HEAD | grep -vE '^(src/cli/process\.ts|src/types\.ts|src/extension\.ts|test/.*\.ts|CHANGELOG\.md|docs/verification\.md)$'
.gitignore
.vscodeignore
LICENSE
README.md
media/icon.png
package-lock.json
package.json
scripts/check-real-cli.ts
scripts/make-icon.mjs
src/catalog-to-chat.ts
src/catalog.ts
src/chat-provider.ts
src/cli/ndjson.ts
src/cli/resolve.ts
src/commands.ts
src/errors.ts
src/prompt.ts
src/transcript.ts
tsconfig.json
tsconfig.test.json
tsup.config.ts
vitest.config.ts
      22
```

All 22 are pre-existing tree contents that the allowlist was never meant to police; a gate that
lists 22 untouched files cannot distinguish containment from breakage. **The allowlist is
therefore scoped to the pre-change baseline commit `0f10b17` ("chore: finalize repo for handoff")**,
the commit at which this work began. This is the same correction the issue file records in its
AC-19 note, applied visibly rather than silently.

The complete change set against that baseline:

```
$ git diff --name-only 0f10b17...HEAD
.gitignore
CHANGELOG.md
docs/verification.md
src/cli/process.ts
src/types.ts
test/transport-concurrency.test.ts
test/transport_provider_concurrency_integration.test.ts
```

Seven files, every one of them on the allowlist, and the gate prints nothing:

```
$ git diff --name-only 0f10b17...HEAD | grep -vE '^(\.gitignore|src/cli/process\.ts|src/types\.ts|src/extension\.ts|test/.*\.ts|CHANGELOG\.md|docs/verification\.md)$'
$ echo $?
1        # 1 == no line matched the inverse filter
```

`src/extension.ts` is on the allowlist but **absent from the change set**: review claim #2 was
rebutted with a test rather than a code change (§9.1), exactly as AC-12 requires. `.vscodeignore`
is likewise untouched, which is why §10.3's packaging fix is still a follow-up.

`.gitignore` **is** in the change set, and this section previously said it was not. That was true
when written — the change set at the commit that recorded this gate was five files — and two later
commits invalidated it:

- `f56098f` ("chore: finalize repo for handoff") added four build-artifact entries
  (`.vscode-test.*`, `.vite/`, `node_modules/.cache/`, `.history/`).
- `0333978` added `test/transport_provider_concurrency_integration.test.ts`, the file this section
  did not list.

`.gitignore` is now on the allowlist rather than outside it, so the earlier "editing it would fail
the containment gate" reasoning in §10.3 and §9.3 no longer holds. **What that reasoning got right
is the part that matters:** the entries added are build-artifact ignores, and **`.vitest` is still
not among them** — `grep -n vitest .gitignore` returns nothing. So the §10.3 defect stands exactly as
reported. Adding `.vitest/**` to `.gitignore` would still hide the untracked directory rather than
fix the packaging, and the fix that actually matters is a `.vitest/**` entry in `.vscodeignore`,
which remains outside this diff.

> **Lesson for the next reader:** this gate is a live command, not a transcript. Two more files
> entered the change set after this section was written, and the prose had to be corrected twice
> because the *record* went stale while the *criterion* was unchanged. Re-run the command above
> before quoting it; if it prints a file, that file is either a real containment break or an
> allowlist that needs widening — the first is a stop, the second is what happened here.

### 10.5 Housekeeping this gate deliberately did not do

- **`.vitest/` is untracked and stays untracked.** `git status --porcelain` shows
  `?? .vitest/` during the run, and it was removed before packaging rather than ignored. It is
  **not** committed, and **`.vitest` is not in `.gitignore`** — `grep -n vitest .gitignore` returns
  nothing. `.gitignore` *was* edited, by `f56098f`, for four unrelated build-artifact entries
  (`.vscode-test.*`, `.vite/`, `node_modules/.cache/`, `.history/`); none of them hides `.vitest`,
  and `.gitignore` is now on the AC-19 allowlist rather than outside it (§10.4). The §10.3 defect
  is therefore unrepaired, not silently ignored.
- **No test was edited to make a gate go green.** Every criterion above was run as written; the
  two that could not pass as written (AC-02's reporter pipeline, AC-19's `main` baseline) were
  corrected with the reason recorded, and the one that surfaced a real defect (AC-17's `.vitest/`
  leak) was reported rather than patched.

## 11. 0.1.1 — the extension registered no models at all

### 11.1 What the earlier record got wrong

§5 M1 reported:

> | Provider registers under the `cmdcode` vendor | **pass** | `vendor: "cmdcode"`, `providerRegistered: true` |

and §10 AC-13 reported activation passing. **Both were true of the code and false of the product.**
The harness in §4 supplied its own `lm.registerLanguageModelChatProvider` shim, so it recorded the
call being *made*. It never went through VS Code's own registration path, which is where the call
was being refused. The distinction the harness could not see:

- calling `registerLanguageModelChatProvider(vendor, provider)` — what the shim recorded as `true`;
- VS Code **accepting** that vendor — which it did not.

430 passing tests never covered the second one, because every layer the tests exercise stops one
process short of it.

### 11.2 Root cause, from VS Code's own source

VS Code keeps an allowlist of language model vendors. Extracted from the shipped
`workbench.desktop.main.js` (VS Code 1.139.1):

```js
registerLanguageModelProvider(o,e){
  if(!this._vendors.has(o)) throw new Error(`Chat model provider uses UNKNOWN vendor ${o}.`);
```

`this._vendors` is populated by exactly one extension point:

```js
registerExtensionPoint({ extensionPoint:"languageModelChatProviders", jsonSchema: …,
  activationEventsGenerator: function*(s){ for (let o of s) yield `onLanguageModelChatProvider:${o.vendor}` } })
```

`package.json` had no `contributes.languageModelChatProviders`, so `cmdcode` was never on the list.
`src/extension.ts:117` then called `vscode.lm.registerLanguageModelChatProvider('cmdcode', …)` and
the main process refused it.

**Why it was silent.** The throw is a rejected IPC call, not a rejected `activate()`. The output
channel logs `Cmd Code: activated` from the extension host, before the main process's rejection
arrives. The user sees a success message and an empty picker, with no error surfaced anywhere.

Observed in the real extension host log, on two consecutive window loads of 0.1.0:

```
[error] Error: Chat model provider uses UNKNOWN vendor cmdcode.
    at IY.registerLanguageModelProvider (workbench.desktop.main.js:626:91347)
```

### 11.3 Two hypotheses that were wrong

Recorded so they are not re-investigated.

- **The CLI was not on the extension host's `PATH`.** A GUI-launched app on macOS inherits a
  minimal `PATH`, and this CLI is installed under nvm, which is not in the resolver's fixed
  npm-global list. Simulated directly: the terminal `PATH` resolves `cmd`; the GUI `PATH` does not
  resolve anything. But the real log says `Cmd Code: CLI resolved to cmd (path)`, and the
  capability probe passes (`cmd --help` declares `--output-format <format> … json`). Resolution was
  never the problem.
- **Packaging was broken.** It was not — activation ran, 82 models were built, the bundle loaded.

### 11.4 The marketplace `language-models` tag

The tag that makes a provider discoverable in the marketplace is **not author-declared**. It is
assigned by the marketplace from the presence of `contributes.languageModelChatProviders`, which is
why the missing contribution also cost the extension its discoverability. Evidence from the
gallery API:

| Extension | declares `languageModelChatProviders` | has `language-models` tag |
|---|---|---|
| `github.copilot-chat` | yes | yes (and has no such keyword) |
| `kimi-lm-provider` | yes (`moonshot`) | yes, with **no `keywords` field at all** |
| `oai2lmapi` | yes (3 vendors) | yes, with **no `keywords` field at all** |
| `vscode-pi-model-chat-provider` | yes (`pi`) | yes, via a hand-written `language-model-provider` keyword |

So the single missing contribution explains both symptoms, and the keywords added in 0.1.1 are
belt-and-braces rather than the mechanism.

### 11.5 The fix

- `contributes.languageModelChatProviders`: `[{ vendor: "cmdcode", displayName: "Cmd Code" }]`.
- `activationEvents` gains `onLanguageModelChatProvider:cmdcode`, which VS Code generates from that
  contribution, alongside the existing `onStartupFinished`.
- `Machine Learning` added to `categories`, matching every other language model provider.
- `keywords` gains `language-models` and `language model provider`.

### 11.6 Regression test, and proof it fails without the fix

`test/scaffold.test.ts` now imports `VENDOR_ID` from `src/types.ts` and asserts the manifest
declares it — the two string literals that were previously unconnected. Verified by reverting the
manifest and re-running:

```
$ node -e "…delete j.contributes.languageModelChatProviders; j.activationEvents=['onStartupFinished']…"
$ npx vitest run test/scaffold.test.ts
 FAIL  extension manifest > contributes the vendor that VENDOR_ID registers under
 FAIL  extension manifest > declares exactly one vendor, with a display name
 FAIL  extension manifest > activates on the vendor event its own contribution generates
 FAIL  extension manifest > declares the engine, entry point, activation event and license
 Test Files  1 failed (1)      Tests  4 failed | 9 passed (13)
```

The guard is real: it fails on the pre-fix manifest and passes on the post-fix one.

### 11.7 Executed verification of the fix, in a real VS Code

Everything below was run, not reasoned about. The user's own window was never reloaded; each check
used a separate `--user-data-dir`, and every instance was shut down afterwards.

**Suite** — `npm run check`: both typechecks clean, **433 passed / 0 failed** (430 + 3 new).

**Packaging** — 8 files, 33.62 KB. The packaged `extension/package.json` was read back out of the
artifact and carries the contribution:

```
version: 0.1.1
categories: ["AI","Chat","Machine Learning"]
activationEvents: ["onStartupFinished","onLanguageModelChatProvider:cmdcode"]
languageModelChatProviders: [{"vendor":"cmdcode","displayName":"Cmd Code"}]
```

**Registration accepted** — trace log of a real extension host with 0.1.1 installed:

```
[LM] registering language model provider cmdcode {}
```

and **zero** occurrences of `UNKNOWN vendor`, against two in the pre-fix profile.

**Vendor now recognised by chat** — `renderer.log`, `[ChatModelChanged]`, before and after:

```
before (0.1.0): vendors: agent-host-copilotcli, agent-host-claude, minimax, …      ← no cmdcode
after  (0.1.1): vendors: cmdcode, minimax, agent-host-copilotcli, agent-host-claude, hidden
```

**All 82 models enumerable** — a throwaway probe extension called `vscode.lm.selectChatModels({})`
in a real extension host and wrote the result to disk. The probe was removed afterwards; the user's
extensions directory was left as found.

```json
{ "totalCount": 82, "cmdcodeCount": 82, "vendors": ["cmdcode"],
  "allCmdcIds": true, "uniqueIds": 82,
  "sample": ["cmdc-6d25483acfdc | DeepSeek V4 Pro (latest) | family=cmdcode", …] }
```

82 models, every id `cmdc-` + 12 hex, 82 unique. This is the first executed evidence anywhere in
this document that the models reach VS Code at all — §5 M1 could not produce it.

### 11.8 Packaging defect found and fixed here

The first 0.1.1 `vsce package` shipped **13 files, 42.55 KB**, including six files under
`extension/.commandcode/taste/`. This is the same class of leak as §10.3's `.vitest/` defect — agent
scratch reaching a published artifact — and §10.3's recommended fix was never applied. Both are now
closed by three lines in `.vscodeignore`:

```
.commandcode/**
.vitest/**
```

Repackaged: **8 files, 33.62 KB**, matching the 0.1.0 content set plus the fixed manifest.

### 11.9 Still unverified

Copilot Chat's **chat UI rendering** of these models is still unverified, for the same reason as
§8.1: the picker and the model list are now proven to populate, but selecting a model in a live
Copilot Chat session and reading streamed text back into the chat pane is VS Code's own code path
and needs a signed-in interactive session. The account on this machine is also rate-limited, so a
live turn would have failed for an unrelated reason anyway.

### 11.10 Provider renamed to "Command Code", and the capability flags VS Code actually reads

The provider's `displayName` changed from `Cmd Code` to `Command Code` (the vendor id stays
`cmdcode`, so no `cmdc-` model id changes). Verified in a real extension host after reinstalling:

```
[LM] registering language model provider cmdcode {}
[LM] Resolved language models for vendor cmdcode [{…"vendor":"cmdcode","name":"DeepSeek V4 Pro (latest)"…}]
```

zero `UNKNOWN vendor` errors, 82 models resolved.

**On the "Capabilities" column in the Manage Language Models window — there isn't one.** That
window (`workbench.editor.modelsManagement`) renders a vendor/group tree, not a table with a
capabilities column. What it does have is a search box with typed filters, hard-coded in the
workbench bundle:

```js
nlo={FILTER_TYPES:["@provider:","@capability:"],
     CAPABILITIES:["@capability:tools","@capability:vision","@capability:agent"]}
```

So the capability "tags" are **search filters**, not declarations, and they cannot be set. They
match a model's metadata through `getMatchingCapabilities`:

```js
case "tools":  e.metadata.capabilities.toolCalling === true → push("toolCalling")
case "vision": e.metadata.capabilities.vision     === true → push("vision")
case "agent":  e.metadata.capabilities.agentMode  === true → push("agentMode")
```

Those three properties are exactly what the ext-host derives from the two fields the stable
`vscode` API exposes (`extensionHostProcess.js`):

```js
capabilities: a.capabilities ? {
  vision:      a.capabilities.imageInput,
  editTools:   a.capabilities.editTools,
  toolCalling: !!a.capabilities.toolCalling,
  agentMode:   !!a.capabilities.toolCalling
} : void 0
```

Observed in this extension's own resolved metadata, which is the ground truth for why the filters
currently match nothing:

```json
"capabilities":{"vision":false,"toolCalling":false,"agentMode":false}
```

**`toolCalling` and `agentMode` are the same field.** The stable API has no separate agent switch,
so claiming either one claims both. All three filters are therefore unavailable to this extension
while `src/catalog-to-chat.ts:26` declines both `imageInput` and `toolCalling` — which is the
correct behaviour, not an oversight. Copilot does have a documented tool loop, but print mode
returns text deltas with no channel to return a tool result on, so advertising the flag would make
Copilot send tools the adapter drops. That trade-off is §D5 in the architecture and is asserted by
`test/provider.test.ts`. Setting these flags would be a real feature, not a metadata edit, and it
would have to land with a working tool-result round trip.

**Pinning is not a capability.** It is per-model and user-owned (`chatModelPinned`), with the
picker honouring `chatModelVisibility` / `chatModelPinned` for every vendor equally. Nothing in
the extension controls it; the 82 models are pinnable today.

### 11.11 0.1.2 — the models were filtered out of the picker before it rendered

**Symptom.** The provider registered, all 82 models appeared in the Manage Language Models window,
and pinning from that window worked — but Copilot Chat's model picker showed none of them, in the
mode Copilot opens in.

**Cause.** Two capabilities gates in the model filter, read from the shipped workbench (1.139.1):

```js
dZi(models, sessionType, modeKind, location):
  modeKind === "agent"  → uZi(model)  → suitableForAgentMode(model)
  location === "editor" → pZi(model)  → !!model.capabilities.toolCalling
  otherwise             → no capability gate

suitableForAgentMode = p => (typeof p.capabilities?.agentMode > "u" || p.capabilities.agentMode)
                           && !!p.capabilities?.toolCalling
```

The live session state was `currentModeKind = agent`, `currentSessionType = local`
(`renderer.log`), so the first gate applied. With `toolCalling: false` — the value
`src/catalog-to-chat.ts` shipped in every release up to 0.1.1 — all 82 models were dropped before
the picker rendered. The gate is `agent`-only: in an **Ask** or **Chat** session the same models
would have been listed.

**Fix.** `toolCalling: true`. `imageInput` unchanged at `false`.

**Why `true` is accurate, and what it does not claim.** The Command Code CLI executes tools
in-process and never yields for a host to run one. From `cli.mjs`:

```js
emit({type:"tool_running", toolCallId:n.id, toolName:n.name, description:r});
const g = await execGuarded({toolUse:…});      // runs here
emit(…{type:"tool_completed" | "tool_errored", toolCallId:n.id, toolName:n.name, …});
```

There is no `tool_call`, `tool_request` or `permission_request` emitter anywhere in the bundle, so
the CLI cannot be driven by a host through the current print mode. The extension therefore still
emits no `LanguageModelToolCallPart` and still ignores `options.tools`: Copilot sends no tool
schemas, and a model's own tool work does not surface in the chat's tool UI. The flag states that
the model can call tools, which is true; it does not claim Copilot orchestrates them. Both the
README and the `CAPABILITIES` comment say so explicitly, replacing the old "no tool calling" claim.

`imageInput` stays `false` deliberately: `buildPrompt` renders text parts only, so an image part
would be discarded without a trace. Several catalog models are vision-capable; that is a gap in
the adapter's prompt path, not in the models.

**Executed verification** — a throwaway probe extension called `vscode.lm.selectChatModels({})`
against the installed 0.1.2 in a real extension host (probe removed afterwards):

```json
{ "cmdcodeCount": 82,
  "capabilities": { "supportsImageToText": false, "supportsToolCalling": true },
  "distinctCapabilityShapes": 1 }
```

All 82 models report `supportsToolCalling: true`, against 0 in 0.1.1. Trace log confirms
`[LM] registering language model provider cmdcode {}` from `cmdcode.cmdcode-0.1.2`, with no
`UNKNOWN vendor`. `npm run check`: **435 passed / 0 failed**. Packaged 8 files, 34.69 KB.

**Still unverified** — that a *live* Agent turn completes and streams back into the chat pane. The
account on this machine hit its weekly limit during this work
(`429 … Your limit resets at 2026-10-01T15:18:35Z`), so no request could be completed here. The
picker-visibility defect is fixed and proven; end-to-end chat execution is not, for want of a usable
quota.

**Two stale claims in the earlier record**, corrected here rather than left to mislead:

- §5 M1 and §10 AC-13 reported activation and registration passing. Both were true of the code and
  false of the product for the reasons in §11.2 and §11.11 respectively.
- §6 recorded "No tool calling — **confirmed**" and asserted every model reports
  `{imageInput: false, toolCalling: false}`. That was correct for what shipped and is now wrong
  for what should; the README and the tests carry the current contract.

**Environment note.** The CLI on this machine is now `command-code@1.69.0`; this document records
`1.66.0` in §1. v1.69 added `--tools-all` and `--tools-enable`, which the transport's argv
deliberately excludes. That exclusion is a separate decision, unaffected by this fix, and is worth
revisiting now that the flag is honest about tool support.

### 11.12 The direct-API transport, researched but not adopted

Scoped out of 0.1.2 at the user's direction ("make the current extension work properly first").
Recorded because the research is done and the finding is not obvious:

`https://api.commandcode.ai` is live and self-describes:

```
GET https://api.commandcode.ai/                     → 200 {"success":true,"message":"Command Code API"}
GET https://api.commandcode.ai/alpha/generate       → 401 UNAUTHORIZED (+ docs pointer)
GET …/v1/chat/completions  |  /v1/messages  |  /v1/responses  |  /v1/models  → 404
```

So an authenticated API surface exists under `/alpha/*`, but the OpenAI- and Anthropic-compatible
paths this extension would want are not mounted there. Vendored endpoints in `cli.mjs` are
`/alpha/generate`, `/alpha/agent/generate`, `/alpha/sandbox/*`, `/alpha/billing/*` and others — an
agent-oriented surface, not a general chat-completions one. No route list is published in
`/docs`, and `commandcode.ai/docs` documents the CLI, not an API.

Next step when this is picked up: authenticate and enumerate the real `/alpha/*` routes rather than
assuming a compatibility shim, and confirm whether a tool-result channel exists at all — without
one, a direct transport hits the same `suitableForAgentMode` ceiling.

### 11.13 0.1.3 — the "Working…" placeholder was being sent as answer content

**Symptom, reported by the user after 0.1.2 was confirmed working end to end:**

```
Working…Hello! I'm working in the `cmdcode-vsc` VS Code extension project. How can I help you today?
```

Every reply in every session carried the prefix.

**Cause.** `src/chat-provider.ts` reported a `LanguageModelTextPart('Working…')`
before spawning the CLI, to cover the ~3–4 s cold start. The original comment
claimed *"VS Code has no retract API, so this stays in the transcript"* — which
identifies the bug as the design rather than denying it. Every part handed to
`progress` becomes response **content**; there is no separate status channel, so
a placeholder emitted as a text part is indistinguishable from model output and
is prepended to it forever.

**Why it cannot be reworded or re-typed.** The stable API has no non-content channel:

```ts
export type LanguageModelResponsePart =
  | LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart;
```

All three are content. `ProvideLanguageModelChatResponseOptions` exposes only
`modelOptions`, `tools` and `toolMode` — no `progress` handle, and `vscode.Progress`
is not passed to a provider. The workbench offers no `thinkingDelta` /
`thinking_delta` part type either (0 occurrences in `workbench.desktop.main.js`).
So any pre-answer text the extension emits is, by construction, part of the answer.

**Fix.** The placeholder is removed, not restyled. `cmdcode.showThinkingPlaceholder`
is deleted from the manifest, `CmdCodeConfig`, `CONFIG_DEFAULTS` and the README —
it only ever controlled whether a fabricated token was prepended, so leaving it as
a no-op would be worse than removing it. Copilot renders its own pending state
while a provider is awaited, so the wait is still visibly busy.

The working reference provider emits no placeholder either; it streams nothing
until the model's first delta (`minimax-provider/src/MiniMaxProvider.ts`).

**Tests now assert the absence**, so "helpful" status text cannot be
reintroduced:

| Test | Asserts |
|---|---|
| `reports nothing before the model produces its first token` | first part is the model's own text; no match for `/working\|thinking\|please wait\|\.\.\./i` |
| `emits no fabricated content at all when the model says nothing` | a silent run yields exactly one part, the explanation |
| `emits exactly one explanatory part when both the deltas and the text are empty` | `toHaveLength(1)`, not 2 |
| `forwards each delta as its own part` | `['a', 'b\n']`, no leading token |
| `streams every text_delta in arrival order` | `['Hello', ', ', 'world']`, 3 parts not 4 |

The two zero-delta tests previously asserted `toHaveLength(2)` — placeholder plus
explanation. Both corrected to 1; a failing run here caught them rather than the
change going unnoticed.

`npm run check`: **436 passed / 0 failed**. Packaged 8 files.

### 11.14 0.2.0 — marketplace identity, icon, and README

**Identity.** The extension moved from `cmdcode.cmdcode` to
`devparanjay.command-code-provider`, with the display name `Command Code Provider`. This is a new
marketplace identity: VS Code treats it as an unrelated extension, so existing installs are not
upgraded and must be reinstalled. Verified by installing the artifact and reading
`code --list-extensions`, which now reports `devparanjay.command-code-provider` and nothing else
after the old id was removed.

Three names are now deliberately distinct, and a new test pins the split:

| Name | Value | Changes when? |
| --- | --- | --- |
| Marketplace id | `devparanjay.command-code-provider` | freely — it is packaging metadata |
| Provider vendor id | `cmdcode` (`VENDOR_ID`) | **never** — it is hashed into every `cmdc-` model id |
| Settings / commands | `cmdcode.*` | **never** — users' `settings.json` and keybindings depend on it |

The settings namespace is independent of the publisher, so renaming it would have silently reset
every user's configuration. `keeps the cmdcode.* settings and command namespace` asserts this so a
future rename cannot quietly break it.

**Icon.** Built from the vendor's own `symbol.svg`
(`https://raw.githubusercontent.com/CommandCodeAI/command-code/…/symbols/symbol.svg`, referenced
from <https://commandcode.ai/brand>) with a `PROVIDER` caption strip added beneath the mark.

Worth recording: the first attempt hand-transcribed the SVG paths into a pixel buffer and produced
a broken mark — a black square with no glyph and a scrambled caption. Two real problems, both caught
by looking at the output image rather than by the script:

1. The glyph paths are `M … v … h … z` **curve** subpaths, not the rectangles the transcription
   assumed, so nothing was drawn.
2. The banner font was a hand-rolled 5×7 bitmap whose column bytes were indexed in the wrong
   direction, rendering the word backwards and overlapping.

`scripts/make_icon.py` now rasterises the vendor SVG with `rsvg-convert` and renders the caption
with a real system font via Pillow, so neither the mark nor the text is re-implemented. The
128×128 result was inspected at 128, 64, 32 and 16 px: the mark stays legible at 16 px and
`PROVIDER` is still readable. The old `scripts/make-icon.mjs` (unrelated placeholder artwork, which
documented itself as *not* the vendor mark) is deleted.

**Branding consistency.** Command titles, the output channel, and the log prefix moved from
`Cmd Code` to `Command Code`; command **ids** did not. Verified in a live extension host:

```
[info] Command Code: activating (logLevel=normal, models=82)
[info] Command Code: CLI resolved to cmd (path)
[info] Command Code: activated
[LM] registering language model provider cmdcode {}      ← 0 UNKNOWN vendor
```

**README** rewritten for the Marketplace and GitHub, including a Trademarks and affiliation section
and a license/warranty section. Its factual claims were checked against the code rather than
written from memory: command titles and ids, the five settings and their defaults, the log lines
quoted in the troubleshooting table, the 82-model count, and the CLI version (1.69.0). Two claims
were corrected as a result — the command titles in the draft said "Command Code:" while the manifest
still said "Cmd Code:", and the log examples quoted the old prefix.

`npm run check`: **437 passed / 0 failed**. Packaged 8 files, 46.11 KB. `scripts/**` is in
`.vscodeignore`, so the generator and the vendored `symbol.svg` stay out of the artifact — confirmed
by reading the file list back out of the `.vsix`.







### 11.15 0.3.0 — vision on both providers, and a real tool loop

**The base URL was wrong, and that was the whole blocker.** Earlier probes found
`api.commandcode.ai/v1/chat/completions` → 404 and concluded the API was agent-shaped
under `/alpha/*`. Both were true and irrelevant: the documented routes live under
**`/provider`**, and the host root serves the CLI's own private backend, which is a
different surface. `https://api.commandcode.ai/provider/v1/chat/completions` is the
route. Recorded because "the documented endpoint 404s" led to three wrong conclusions here.

**Per-model capabilities come from the CLI's own catalog, not prose.** A first draft
proposed regexing the "Best for" blurb; the vendor's code disproves it in both directions —
`deepseek/deepseek-v4.1-flash` says "with vision" and is vision-capable, while
`deepseek/deepseek-v4-pro` says nothing and is text-only. The CLI instead ships a static
catalog of 90 entries with `inputModalities: ["text"|"text","image"]`, and branches on it
via `modelSupportsVision`. `scripts/sync-capabilities.mjs` reads that and reports drift.
Result: **62 vision, 20 text-only** across the 82 shipped models. The extractor initially
missed `xai/grok-4.7` because it is the last entry and ends `}}` rather than `id:"` — caught
by the cross-check, not by the count.

**The two documented tool constraints are correctness, not polish.** Both fail a request
outright, so both are handled before sending:
- remote `mcp` tools → rewritten to `type: "function"` (the upstream would otherwise dial the
  user's server on Command Code's credential);
- under `x-cmd-zdr: 1` the array is filtered to `function`/`custom`/`local_shell`.

A test caught a real bug here: the ZDR check originally ran on the *declared* type, so an
`mcp` tool was dropped even though the rewrite makes it an ordinary `function` and therefore
ZDR-safe. Fixed to test the post-rewrite type for `mcp` and the declared type otherwise.

**Executed verification.** A throwaway probe called `vscode.lm.selectChatModels({})` against
installed 0.3.0 in a real extension host (probe removed afterwards):

```json
{ "vendors": ["cmdcode", "cmdcode-api"],
  "cmdcode":     { "total": 82, "vision": 62, "tools": 0 },
  "cmdcode-api": { "total": 82, "vision": 62, "tools": 82 } }
```

Vision is mixed and correct in both groups — "DeepSeek V4.1 Flash" vision-capable, "DeepSeek
V4 Pro" not. `toolCalling` is 0 on the CLI group and 82 on the API group, which is the
per-provider split the plan called for. Both vendors register with 0 `UNKNOWN vendor`.

`npm run check`: **487 passed / 0 failed** (471 + 16 new). Packaged 8 files, 56.71 KB — the
first 0.3.0 build swept `.github/ISSUE_TEMPLATE/**` into the VSIX (10 files), now excluded.

**Not verified, and stated plainly:**

- **No live API request.** There is no API key in this environment, so every fact about
  `/provider` comes from the published documentation. URLs, headers, bodies, SSE parsing and
  error mapping are covered by unit tests and recorded fixtures; the end-to-end round trip is
  unverified until a key is supplied.
- **No live image read.** The account is rate-limited (`429`, resets 1 Oct). The wiring is
  verified — staged file, prompt marker, `--config imageVisionEnabled=true`, and the data-URL
  content block — but not the model's answer.
- **https://commandcode.ai/models** could not be fetched (the 429 also gates web tools), so
  the CAPS column there is unconfirmed. The CLI catalog is the source until the site is
  reachable, and reconciling the two is exactly what the new issue template is for.
