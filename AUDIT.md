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

- Add provider OAuth where supported; retain API-key mode for headless use.
- Add task DAG editing, agent profiles, telemetry opt-in and exportable audit logs.
- Reduce the bundled extension size and add CI release gates.

## Operational handoff

Before publishing, run `npm run lint`, `npm test`, `npm run compile`, `npm audit --omit=dev`, and `npm run package`.
Use dedicated provider project/workspace keys with provider-side spend limits. Never use an organization admin key.
Keep workspace writes and terminal execution disabled until a user explicitly enables them for a trusted workspace.
