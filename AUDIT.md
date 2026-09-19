# AI Orchestra audit and handoff

## Delivered in priority order

### P0 — correctness and secret boundaries

- Aligned budget configuration with the contributed VS Code settings.
- Added atomic request reservations so concurrent agents cannot overspend the same budget.
- Centralized API-key loading in VS Code `SecretStorage`; workers receive only provider invocation capability.
- Added runtime provider fallback, durable tasks, leases, heartbeats, checkpoints and backup handoff.
- Added capability-gated workspace tools. Writes and terminal execution are disabled by default.

### P1 — real multi-agent execution

- Main supervisor creates planner, coder and auditor work in bounded parallelism.
- Reviewer reconciles worker outputs before the supervisor produces the final response.
- Each task stores acceptance criteria, primary/backup owners, token allocation, artifacts and handoff state.
- Low budget, provider failure and expired leases can transfer work to a backup agent.

### P2 — release reliability and observability

- Serialized usage persistence prevents concurrent lost updates.
- Sidebar reports live task state, token usage, spend and remaining budget.
- Unknown cloud models use conservative pricing; local Ollama remains zero-cost.
- ESLint 9 configuration, architecture tests, build and VSIX packaging are operational.
- Added GitHub/Copilot account login through VS Code's built-in authentication and Language Model APIs.
- Added the official Gemini desktop OAuth pattern with loopback callback, state validation and refresh-token storage.

## Remaining roadmap

### P1 next

- Replace source-structure tests with VS Code integration tests using mocked providers, crashes and restarts.
- Add cancellation and idempotency tests for tool calls and handoffs.
- Add an explicit user confirmation flow per write/terminal operation instead of settings-only opt-in.

### P2 next

- Persist conversation history and expose goal/task history in the UI.
- Implement an actual model lock or rename the current “Switch Model” UI, which is only a display preference.
- Read provider `Retry-After` values and use exponential backoff with jitter.
- Refresh model catalog and pricing from a versioned, reviewable source.

### P3 later

- Evaluate additional official account providers when they expose supported third-party inference grants; retain API-key mode for headless use.
- Add task DAG editing, agent profiles, telemetry opt-in and exportable audit logs.
- Reduce the bundled extension size and add CI release gates.

## Operational handoff

Before publishing, run `npm run lint`, `npm test`, `npm run compile`, `npm audit --omit=dev`, and `npm run package`.
Use dedicated provider project/workspace keys with provider-side spend limits. Never use an organization admin key.
Keep workspace writes and terminal execution disabled until a user explicitly enables them for a trusted workspace.

## Full-code audit (2026-09-18, v0.3.7 baseline)

Scope: every file under `src/` (~4,000 lines), the manifest, and the Grok CLI integration. Baseline was clean (`tsc`, 10 tests, 0 npm advisories, 19 `no-explicit-any` warnings), but the 10 tests only grep source text, so they could not have caught any of the runtime issues below. Findings marked **verified** were reproduced with a command, not just read.

### Fixed in this pass (covered by `src/test/audit-fixes.test.ts`)

**Security**
- Workspace `.vscode/settings.json` could flip `tools.allowTerminal`, `tools.allowWorkspaceWrite`, `billing.mode` and `ollama.endpoint` (default `window` scope). A cloned repo could therefore enable agent execution/writes or point prompts at another host, and `billing.mode` set via the command was silently overridden. These four settings are now `scope: machine`, and `capabilities.untrustedWorkspaces.supported = false` is declared explicitly.
- The `execute` tool's allowlist was not a sandbox: `node -e`, `git -c core.sshCommand=...`, `npm exec` and `npx <pkg>` all run arbitrary code. `npx` is removed; `node` may only run a script, `git`/`npm` only a fixed subcommand set, and option injection (`--output`, `--script-shell`, `--prefix`, ...) is rejected (`src/tools/tool-policy.ts`).
- `read_file`/`write_file` had a lexical workspace check only. They now resolve symlinks/junctions, refuse secrets (`.env*`, `.git/config`, keys, `.npmrc`, `.ssh`) for reads, refuse `.git/`, `.vscode/`, `.env*` for writes (an agent could otherwise rewrite the settings that gate it), and cap writes at 1 MiB.
- **Verified:** `execFile` errors embed the full argv, and for chat calls argv contains the whole prompt (including file contents returned by tools). That text was shown in the chat UI, chained into `All providers failed: ...` and written to the output channel. Errors are now reduced to name, exit code and the last stderr lines. The output channel also no longer logs prompt text.
- An unrecognised agent id fell back to the `supervisor` role, so in Restricted mode it inherited the supervisor's model grants; it is now denied.
- `innerHTML` with model ids (which can come from a local Ollama server) in the chat webview replaced by `textContent`; CSP nonce now uses `crypto.randomBytes`.

**Provider/auth correctness**
- **Verified:** `/logged in|chatgpt|api key/i` matches "Not logged in", and treated a Codex *API-key* login (billed per token) as a subscription session, bypassing Subscription-only. Replaced by `classifyCodex`.
- **Grok** (asked about explicitly): `checkStatus` returned `authenticated: true` after any exit-0 `grok models`, so a signed-out CLI showed as available. Antigravity was fail-open the same way (`!/authentication required/`). Both now require non-empty output that does not look like a login prompt (`classifySessionProbe`). The package `@xai-official/grok` was checked on npm (maintainer `xai-security@x.ai`). The Grok CLI is not installed on the audit machine, so its real `models` output when signed out is **unverified**; if it exits 0 with a normal-looking error, add its exact text to `AUTH_HINT` in `src/providers/cli-status.ts`.
- Sidebar showed a green check for "Not authenticated..." (regex matched "authenticated"). Fixed in `src/ui/status-icon.ts`.
- Gemini API-key path sent `system` messages as a user turn, giving two consecutive user turns, which the API rejects, so every supervisor/worker call (system + user) failed on that path. System text now goes to `systemInstruction`; turns are merged/alternated.
- Ollama: streaming parsed each network chunk as whole JSON lines (breaks when an object spans chunks); no timeout on `isAvailable()` although it runs on every routing decision. Both fixed.

**Budget / orchestration**
- `maxDailyTokens` was read from `maxTokensPerSession`, so "Reset Session Budget" could never free anything. New `ai-orchestra.budget.maxTokensPerDay` (default 500,000, a product decision, change if you disagree); `criticalThreshold` is now declared in the manifest.
- Once the daily dollar cap was spent, zero-cost providers (Ollama, subscription CLIs) were blocked too. Zero-cost requests are now exempt from the cost cap only.
- `TaskStore`/`UsageTracker` write chains were poisoned by one failed Memento write (every later write rejected/skipped). Fixed.
- `Orchestrator.executeStream` leaked its budget reservation if the consumer stopped early.
- Goals stayed `active` forever after a worker failure; cancellation triggered pointless backup handoffs. Goals now become `failed`, cancelled tasks fail without handoff.
- `TaskStore` lived in `globalState` and `recoverExpiredLeases` re-ran leased tasks (write/execute-capable), including tasks from another window/workspace whose in-memory copy never sees the owner's heartbeats, against the *current* workspace root. The store is now workspace-scoped and tasks left running by a previous session are marked `failed` on activation instead of silently resumed.
- Chat: a second message while a goal is running is rejected; the webview keeps its context when hidden (results were dropped when the user switched views during a multi-minute goal); `deactivate` now flushes pending writes.

### Behaviour changes to be aware of
- Users who set the four machine-scoped settings in a workspace must move them to User settings.
- Existing tasks in `globalState` are orphaned by the move to workspace storage.
- `execute` no longer accepts `npx`, `node -e`, or arbitrary `git`/`npm` subcommands.
- Codex logged in with an API key is now reported "not authenticated" (with an explanation) rather than available.

### Redesign after the audit: single-executor delegation

The audit's open items #2 and #4 below were resolved by changing the product model to what the extension is for: a main
supervisor that assigns each prompt to **one** subscription/free agent (see README, "Delegation model").

- `MultiAgentSupervisor` (planner + coder + auditor + reviewer + supervisor = 5+ model calls per message, leases,
  heartbeats, backup handoff) and the unused `TaskPlanner` are removed. `DelegationSupervisor` never calls a model; it
  ranks candidates (`agent-ranking.ts`), runs the winner through `Orchestrator` with `strictProvider` (no silent
  substitution) and only tries the next agent if the first fails. Cancellation never falls through to another agent.
- Remaining-limit awareness: `LimitTracker` (soft caps per agent from `ai-orchestra.limits`, plus a cooldown parsed from
  the agent's own rate-limit message, persisted in global state). Subscription CLIs expose no quota API, so the caps are
  user-configured estimates, not readings.
- Shared context window: `ConversationContext` (workspace state) keeps recent turns, a deterministic digest of older
  ones and notes about files already read/written; it is packed within a token budget and re-sent in compact form. The
  chat had no history before; "Clear" now forgets it.
- Credit providers are not candidates at all in Subscription/free mode (the default), not merely blocked at call time.
- The header dropdown and "Switch Model" now pin a real executor (or return to Auto); the status bar no longer shows
  "GPT-4o" by default. `CliAgentProvider.isAvailable()` reuses a 30 s status probe instead of spawning processes on every
  routing decision. `TaskStore` keeps only the newest 50 delegations.
- Behaviour change: settings `agents.maxConcurrent`, `agents.leaseSeconds` and `budget.handoffThreshold` are removed;
  `budget.maxTokensPerTask` now caps one prompt's tool turns.
- The executor runs under the `coder` role, so Restricted-mode model permissions for that role decide which agents it
  may use. Selection is deterministic rules, not an LLM; an LLM-assisted choice for ambiguous prompts would spend quota.

### Windows launch fix

- Cause (verified on Node 22.23 and 24.19): npm installs `codex`/`claude`/`npx`/`npm` as `.cmd` shims and, since the
  CVE-2024-27980 fix, Node refuses to spawn a `.cmd`/`.bat` without a shell (`spawn EINVAL`). A `shell: true` fallback is
  not acceptable because the prompt is arbitrary text and cmd.exe interprets `& | ^ %`.
- Fix (`src/providers/cli-exec.ts`): `resolveLaunch` reads the shim and launches its real target directly with no shell:
  a native `.exe` (Claude Code) or `node script.js` (Codex, npm; `node.exe` next to the shim, then PATH, then VS Code's own
  runtime with `ELECTRON_RUN_AS_NODE`). A shim it cannot understand is refused with a message, never guessed.
  `locateProgram` returns absolute paths, so no bare `npx.cmd` is resolved against the working directory.
- Prompts travel over stdin for Claude (`-p`) and Codex (`exec ... -`), which removes the ~32,000-character Windows
  command-line limit. Grok and Antigravity still take the prompt as an argument, so `provider.maxPromptChars` caps the
  shared context window sent to them (`DelegationSupervisor` honours it).
- Failure text now includes what the CLI printed on stdout (Codex `error`/`turn.failed` events, Claude `is_error` with
  `result` or `errors[]`) and never the argv. This exposed two more bugs, both fixed: Codex's usage-limit message
  ("try again at 6:39 PM") was not recognised as a cooldown, so `LimitTracker` now parses clock times (past time means
  tomorrow); and Claude chat ended in `error_max_turns` because its built-in tools were on with `--max-turns 1`, so it now
  runs with `--tools ""` (the extension executes tools itself).
- Verified on this machine against the real CLIs: `claude`/`codex`/`npx`/`npm --version` launch, status reads "Available",
  a Claude chat returns an answer, and a Codex usage limit is reported and paused. Grok and Antigravity CLIs are not
  installed here, so their launch path is covered by the shim tests only.

### Open findings (not fixed; ordered by priority)
1. ~~Windows `.cmd` shims cannot be spawned (`spawn EINVAL`).~~ Resolved, see "Windows launch fix" below.
2. ~~Every chat message runs a full multi-agent goal, with no history, no cancel and a decorative model selector.~~ Resolved by the delegation redesign above.
3. No per-call user confirmation for agent writes/execution, and tool output is fed back to the model unfenced (prompt-injection path). Settings-only opt-in remains the sole gate.
4. ~~`isAvailable()` spawned 1-3 processes per provider per routing decision.~~ CLI providers now reuse a 30 s status probe.
5. `UsageTracker` stores `daily` and `monthly` copies and, in `globalState`, is last-write-wins across windows; the same applies to `LimitTracker` (global state, so counts from two open windows can overwrite each other). `TaskStore` is now pruned to 50 delegations.
6. Google OAuth loopback: first request to the port wins (any local request can consume the one-shot listener), the server is not closed if `openExternal` throws, and a state mismatch answers "login complete" with HTTP 400.
7. Antigravity "Logout" only launches `agy`; "Login" reinstalls the CLI on every click; the `npx --yes <pkg>` fallback downloads an unpinned package during a chat request.
8. ~~On Windows the `execute` tool cannot run `npm` (needs `.cmd`).~~ Resolved with #1: `execute` resolves `npm` through the same shim launcher.
9. Both sidebar views register the same provider, so each shows the whole tree; `TaskAnalyzer` uses substring keyword matching ("hi" matches "this") on tool-result-heavy context, which biases most agent calls to higher tiers.
10. Hygiene: 19 `no-explicit-any` warnings; dead code (`Settings.getConfig`/`getProviderConfig`, `BudgetManager.getRecommendedModel`, `Orchestrator.executeStream`); `getCheaperAlternative` can suggest an OpenAI model in Subscription mode; Anthropic display names are wrong ("Claude 3.5 Sonnet" for `claude-sonnet-4-...`); the original architecture tests are source-regex checks and should be replaced by behavioural ones like the new file.
