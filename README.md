# 🎵 AI Orchestra — Multi-Model AI Orchestrator for VSCode

A powerful VSCode extension that intelligently orchestrates multiple AI models with smart budget management. Stop worrying about hitting rate limits mid-task — AI Orchestra automatically routes your requests to the best available model while keeping costs under control.

## ✨ Features

### 🎯 Smart Model Routing
- **Automatic task analysis** — Detects task complexity (simple/medium/complex) and type (code generation, review, debugging, etc.)
- **Tier-based routing** — Routes simple tasks to cheap models, complex tasks to powerful ones
- **Auto-downgrade** — When budget runs low, automatically switches to cheaper alternatives

### 💰 Budget Management
- **Token & cost tracking** — Real-time tracking per session, day, and month
- **Budget warnings** — Visual warnings at configurable thresholds (default: 80%)
- **Auto-protection** — Blocks requests when budget is exhausted instead of failing silently
- **Cost estimation** — See estimated cost before each request

### 🔄 Multi-Provider Support
| Provider | Models | Type |
|----------|--------|------|
| **OpenAI** | GPT-4o, GPT-4o-mini, o3-mini | Cloud |
| **Anthropic** | Claude Sonnet 4, Claude Opus 4 | Cloud |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash | Cloud |
| **Ollama** | Any local model | Local (Free) |

### 🛡️ Failover & Rate Limit Handling
- Automatic fallback when a provider hits rate limits
- Configurable fallback order
- Ollama as ultimate free fallback

## 🚀 Quick Start

### 1. Install
```bash
# Clone and install
cd ai-orchestra
npm install
npm run compile
```

### 2. Launch in VSCode
Press `F5` to open Extension Development Host.

### 3. Configure API Keys
Run command: **AI Orchestra: Configure Providers**
- Select a provider → Enter your API key
- Keys are stored securely via VSCode's encrypted `secretStorage`

### 4. Start Chatting
Run command: **AI Orchestra: Open Chat** or click the 🤖 icon in the activity bar.

## ⚙️ Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `ai-orchestra.budget.maxTokensPerSession` | `100,000` | Max tokens per session |
| `ai-orchestra.budget.maxTokensPerDay` | `500,000` | Max tokens per day (separate from the session limit) |
| `ai-orchestra.limits` | `{}` | Soft per-agent request caps the supervisor uses when choosing (machine-scoped) |
| `ai-orchestra.context.maxTokens` | `12,000` | Upper bound on the shared context sent to the executor |
| `ai-orchestra.context.recentTurns` | `8` | Turns kept verbatim before being folded into the digest |
| `ai-orchestra.agents.maxToolTurns` | `4` | Model calls the executor may make per prompt while using tools |
| `ai-orchestra.budget.maxCostPerDay` | `$5.00` | Max daily spend (USD) |
| `ai-orchestra.budget.warningThreshold` | `0.8` | Warning at 80% budget |
| `ai-orchestra.routing.preferredProvider` | `auto` | Preferred provider |
| `ai-orchestra.routing.fallbackOrder` | `[vscode-lm, codex-cli, claude-code, antigravity-cli, grok-cli, openai, anthropic, gemini, ollama]` | Fallback priority; credit providers are skipped in subscription-only mode |
| `ai-orchestra.routing.autoDowngrade` | `true` | Auto-switch to cheaper models |
| `ai-orchestra.ollama.endpoint` | `http://localhost:11434` | Ollama server URL (machine-scoped: set it in User settings; a workspace cannot override it) |

`billing.mode`, `tools.allowTerminal`, `tools.allowWorkspaceWrite` and `ollama.endpoint` are **machine-scoped**, so a repository's `.vscode/settings.json` cannot flip them. The extension is disabled in untrusted (Restricted Mode) workspaces.

## 🏗️ Architecture

```
Prompt -> Main supervisor (no model call) -> picks ONE executor agent
            |   by task fit + remaining limit, subscription/free agents only
            +-> shared context (digest + recent turns + workspace notes) -> executor agent
            +-> only if that agent fails/rate-limits: the next-ranked agent

Every provider call -> atomic budget reservation -> credential broker -> provider
                    -> usage commit or reservation release
```

### Key Components
- **Delegation supervisor** — The main agent. Ranks the available agents and hands each prompt to exactly one; it never calls a model itself, so choosing costs no subscription quota
- **Limit tracker** — Estimates each agent's remaining headroom from soft caps you configure (`ai-orchestra.limits`) and pauses an agent that reports a rate limit
- **Conversation context** — The shared context window. Older turns are folded into one-line digest entries, files an agent already read/wrote are kept as notes, so the next agent does not re-read them
- **Task store** — Records each delegation (agent, status, tokens); keeps the newest 50 in workspace state
- **Orchestrator** — Analyzes and routes each bounded provider invocation
- **Task Analyzer** — Classifies task complexity and type
- **Model Router** — Selects best model considering budget & availability
- **Budget Manager** — Tracks usage, enforces limits, emits warnings
- **Provider Registry** — Manages all AI provider connections
- **Credential Broker** — Gives agents invocation capability without revealing API keys
- **Tool Runtime** — Enforces agent capability, workspace scope and user opt-in

## 📁 Project Structure

```
src/
├── providers/          # AI provider implementations
│   ├── types.ts        # Shared interfaces
│   ├── openai-provider.ts
│   ├── anthropic-provider.ts
│   ├── gemini-provider.ts
│   ├── ollama-provider.ts
│   └── provider-registry.ts
├── budget/             # Budget management system
│   ├── budget-manager.ts
│   ├── cost-calculator.ts
│   ├── token-estimator.ts
│   └── usage-tracker.ts
├── orchestrator/       # Task routing & planning
│   ├── orchestrator.ts
│   ├── delegation-supervisor.ts   # picks and runs the single executor agent
│   ├── agent-ranking.ts           # pure fit + headroom policy
│   ├── limit-tracker.ts           # per-agent limits and rate-limit cooldowns
│   ├── task-store.ts
│   ├── task-analyzer.ts
│   └── model-router.ts
├── agents/             # Agent roles, capabilities and durable task types
├── security/           # Credential broker
├── tools/              # Permission-gated workspace and terminal tools
├── ui/                 # User interface
│   ├── chat-panel.ts
│   ├── sidebar-provider.ts
│   └── status-bar.ts
├── config/             # Configuration
│   ├── settings.ts
│   └── pricing.ts
├── commands.ts         # Command handlers
└── extension.ts        # Entry point
```

## 🧪 Development

```bash
# Build
npm run compile

# Watch mode
npm run watch

# Lint
npm run lint

# Package as .vsix
npm run package
```

## Provider authentication and agent permissions

AI Orchestra supports account login only where the provider exposes an official flow. It never asks for an account password.

| Provider | Authentication | Storage | Agent access |
|---|---|---|---|
| GitHub Copilot / VS Code models | VS Code GitHub account + model consent | Managed by VS Code; not copied to extension storage | Invocation through VS Code Language Model API |
| OpenAI Codex | ChatGPT account through official Codex CLI | Managed by Codex CLI; never read by AI Orchestra | Read-only `codex exec` invocation |
| Claude Code | Claude.ai account through official Claude Code CLI | Managed by Claude Code; never read by AI Orchestra | Plan-mode `claude -p` invocation |
| Google Antigravity | Google account through official Antigravity CLI | Managed by Antigravity; never read by AI Orchestra | Sandboxed headless `agy` invocation |
| Grok Build | xAI/Grok account through official Grok Build CLI | Managed by Grok CLI; never read by AI Orchestra | Plan-mode headless `grok -p` invocation |
| OpenAI | API key | VS Code `SecretStorage` | Invocation capability; no raw key |
| Anthropic | API key | VS Code `SecretStorage` | Invocation capability; no raw key |
| Gemini | Google OAuth desktop flow or API key | Refresh token/client secret or API key in VS Code `SecretStorage` | Invocation capability; no raw credential |
| Ollama | None by default | Endpoint in VS Code settings | Configured local endpoint |

### Account login setup

Run **AI Orchestra: Configure Providers**:

1. Select `vscode-lm` to sign in through VS Code's built-in GitHub authentication. VS Code and the model provider show their own consent dialogs. A Copilot plan/model entitlement may be required.
2. Select `codex-cli` → **Install official CLI** if needed → **Login with account**. Complete the official `codex login` browser flow with a ChatGPT account.
3. Select `claude-code` → **Install official CLI** if needed → **Login with account**. Complete `claude auth login --claudeai` with a Claude Pro/Max/Team/Enterprise account supported by Claude Code.
4. Select `antigravity-cli` → **Install official CLI** if needed → **Login with account**. Complete Google sign-in inside `agy`. Gemini CLI account access was retired by Google on June 18, 2026; AI Orchestra therefore uses its supported successor, Antigravity CLI.
5. Select `grok-cli` → **Install official CLI** if needed → **Login with account**. Complete the official `grok login` browser flow with an xAI/Grok account.
6. Select `gemini` → **Sign in with Google OAuth** only for direct Gemini API/project access. Create a Google OAuth client of type **Desktop app**, enable the Generative Language API, configure its consent screen, and provide its client ID, client secret and billing/quota project ID. The browser returns to a random loopback port; this flow is intended for a local desktop extension host.
7. Google OAuth can be revoked with **Sign out Google OAuth**. Selecting **Save API key** switches Gemini back to API-key mode.

The same actions are available without the Command Palette: open the AI Orchestra activity bar, expand **Providers**, and click a provider row. The row opens that provider's login/logout/configuration menu. After an account login, AI Orchestra checks authentication in the background and updates the row to **Authenticated / Available**; **Check authentication** performs the same check immediately.

Codex, Claude Code, Antigravity and Grok Build keep their own account credentials outside AI Orchestra, so their sessions survive VS Code restarts according to each official CLI's policy. AI Orchestra stores only the last successful verification timestamp in VS Code global state, restores a temporary **Previously authenticated · checking…** status at startup, and then revalidates the real CLI session. It never copies or stores those CLI tokens.

The Providers sidebar reports each account CLI's installation, version, authentication, and account/subscription type when available. Click a CLI provider and choose **Check CLI status** for a fresh check and its resolved executable path. For example, an authenticated account may show `Available · codex-cli 0.155.1 · ChatGPT`, while a missing CLI shows `Not installed`.

The direct OpenAI and Anthropic API adapters still use API keys. Account subscriptions are exposed as separate `codex-cli` and `claude-code` providers because their official OAuth credentials are scoped to those clients. AI Orchestra deliberately does not extract or reuse their browser/CLI tokens.

Choosing **Login with account** now installs/updates the selected official CLI before launching its login command. This avoids `codex/claude is not recognized` on a new machine. Provider execution also falls back to the official npm package through `npx` when a global binary cannot be resolved from `PATH`.

### Model permissions

Click **Model Permissions** in the AI Orchestra sidebar, or run **AI Orchestra: Manage Model Permissions**:

- **Open**: every agent role may invoke every configured model.
- **Restricted**: a role is denied by default and may invoke only the selected models. Configure `supervisor`, `planner`, `coder`, `auditor`, `reviewer`, and `tester` separately.

Assignments are stored per VS Code workspace. Enforcement happens before provider invocation, not only in the UI. A denied provider/model is skipped through the normal fallback path; if no permitted model is available, the task fails with an explicit permission error.

### Billing mode

The default is **Subscription / Free only**. AI Orchestra permits account-backed Codex, Claude Code, Google Antigravity, Grok Build, GitHub/VS Code models and local Ollama, while blocking direct OpenAI, Anthropic and Gemini API adapters that may consume credits.

To use API credits, click **Billing Mode** and select **Credit with confirmation**. A modal confirmation is required before every individual credit-backed provider request. Approval is never cached for the goal, session, provider or model; cancelling the modal denies that request.

OpenAI API, Anthropic API and Google Gemini API are hidden from the Providers sidebar, provider picker, model picker and model-permission picker while the default **Subscription / Free only** mode is active. They appear only after **Credit with confirmation** is selected, and the router skips them entirely until then.

### Recommended extensions

Click **Recommended Extensions** in the AI Orchestra sidebar, or run **AI Orchestra: Install Recommended Extensions**. Select one or more integrations and confirm installation:

- **GitHub Copilot** — recommended by default because it directly supplies account-backed VS Code language models to AI Orchestra.
- **Microsoft Foundry Toolkit** — model discovery, evaluation and hosted/local agent tooling.
- **Continue** — open-source AI coding agent and model client.

Nothing is installed automatically. The development workspace also declares the same entries in `.vscode/extensions.json`, so VS Code can show its standard workspace recommendation prompt.

Raw credentials are loaded only by the extension host into provider adapters. Supervisor
and worker agents never receive their values. Removing a key/token clears `SecretStorage`
and the configured in-memory provider client.

The upstream provider decides the account-level scope of each API key. AI Orchestra
uses the key only for model inference APIs, but it cannot reduce a broadly privileged
key by itself. Create a dedicated project key, restrict it in the provider dashboard
where supported, set provider-side spend/rate limits, and do not reuse an owner/admin key.

Tool permissions are independent from provider authentication:

| Capability | Assigned to | User gate |
|---|---|---|
| `provider.invoke` | all agents | configured provider and available budget |
| `workspace.read` | the executor (role `coder`) | workspace scope; secrets such as `.env` are blocked |
| `workspace.write` | the executor | `ai-orchestra.tools.allowWorkspaceWrite=true`; `.git/`, `.vscode/` and `.env*` are never writable |
| `terminal.execute` | the executor | `ai-orchestra.tools.allowTerminal=true` plus a constrained `git`/`npm`/`node` allowlist |
| `task.assign` | supervisor only | never delegated |

## Delegation model

The **supervisor** decides *who* executes; the **executor** is whichever agent it picks. For each prompt:

1. Candidates are the signed-in agents that the executor role may use. In the default **Subscription / Free only**
   mode, credit providers (OpenAI/Anthropic/Gemini API keys) are not candidates at all.
2. An agent with no headroom is skipped: its configured cap is used up, or it recently reported a rate limit.
3. The rest are ranked by fit (an agent of the task's tier wins; a stronger agent is mildly penalised so premium
   quota is kept for hard tasks) and remaining headroom. **Exactly one agent** receives the prompt.
4. The executor gets the shared context, may use its tools for a few turns, and answers. If it fails or reports a
   rate limit, it is paused and the next-ranked agent is tried. Agents never run in parallel.

Pin a specific agent from the chat header or the status bar; **Auto** returns control to the supervisor.
The chat shows which agent ran, why, and how much of its limit is left.

**Limits.** Subscription CLIs do not report remaining quota, so set soft caps you know for your plans, for example
`"ai-orchestra.limits": { "claude-code": { "requests": 40, "windowHours": 5 } }`. AI Orchestra counts the requests it
makes; agents without an entry are treated as unlimited, and any agent that reports a rate limit is paused
automatically.

**Shared context.** Every turn is saved. The most recent turns (`ai-orchestra.context.recentTurns`) are sent
verbatim, older ones become one-line digest entries (no model call is spent compacting them), and files an agent
read or wrote are listed as notes. The total is capped by `ai-orchestra.context.maxTokens` and by half of the chosen
agent's context window. **Clear** in the chat forgets it. The CLIs are stateless per call, so the context is
re-sent in compact form rather than re-derived by the agent.

## 📄 License

MIT
