import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AIProvider, ChatChunk, ChatOptions, ChatResponse, Message, ModelInfo, ProviderConfig, RateLimitStatus } from './types';
import { classifyCodex, classifySessionProbe, describeCliFailure, extractCliError, parseCliJson } from './cli-status';
import { RunOptions, locateProgram, resolveLaunch, runProcess } from './cli-exec';

type CliKind = 'codex' | 'claude' | 'antigravity' | 'grok';
interface CliCommand { executable: string; prefix: string[]; }
export interface CliStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  accountType?: string;
  executable?: string;
  error?: string;
}

export class CliAgentProvider implements AIProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly models: ModelInfo[];
  /** Grok and Antigravity take the prompt as an argument (Windows caps a command line near 32,000 chars); Claude/Codex use stdin. */
  public readonly maxPromptChars?: number;

  constructor(private readonly kind: CliKind) {
    if (kind === 'grok' || kind === 'antigravity') this.maxPromptChars = process.platform === 'win32' ? 28_000 : 100_000;
    this.id = kind === 'codex' ? 'codex-cli' : kind === 'claude' ? 'claude-code' : kind === 'antigravity' ? 'antigravity-cli' : 'grok-cli';
    this.name = kind === 'codex' ? 'OpenAI Codex (ChatGPT login)' : kind === 'claude' ? 'Claude Code (Claude login)' : kind === 'antigravity' ? 'Google Antigravity (Google login)' : 'Grok Build (xAI account login)';
    this.models = kind === 'codex'
      ? [{ id: 'codex-default', name: 'Codex account default', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'premium' }]
      : kind === 'claude' ? [
          { id: 'sonnet', name: 'Claude Sonnet (account)', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'standard' },
          { id: 'opus', name: 'Claude Opus (account)', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'premium' },
        ] : kind === 'antigravity' ? [
          { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High', provider: this.id, maxContextTokens: 1_000_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'standard' },
          { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High', provider: this.id, maxContextTokens: 1_000_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'premium' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 via Antigravity', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'standard' },
        ] : [{ id: 'grok-build', name: 'Grok Build (account default)', provider: this.id, maxContextTokens: 500_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'premium' }];
  }

  private statusCache?: { at: number; status: CliStatus };

  /** Routing asks every provider on every prompt; spawning 1-3 processes each time is too slow, so reuse a recent probe. */
  public async isAvailable(): Promise<boolean> {
    const cached = this.statusCache;
    if (cached && Date.now() - cached.at < 30_000) return cached.status.authenticated;
    return (await this.checkStatus()).authenticated;
  }

  public async checkStatus(): Promise<CliStatus> {
    const status = await this.probeStatus();
    this.statusCache = { at: Date.now(), status };
    return status;
  }

  private async probeStatus(): Promise<CliStatus> {
    try {
      const command = await this.resolveCommand(false);
      const versionResult = await this.run(command, this.kind === 'grok' ? ['version'] : ['--version'], { timeout: 10_000 });
      const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim().split(/\r?\n/)[0];
      try {
        if (this.kind === 'codex') {
          const { stdout, stderr } = await this.run(command, ['login', 'status'], { timeout: 10_000 });
          const verdict = classifyCodex(`${stdout}\n${stderr}`);
          return { installed: true, version, executable: command.executable, ...verdict };
        }
        if (this.kind === 'antigravity') {
          const { stdout } = await this.run(command, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '10s'], { timeout: 15_000 });
          return { installed: true, version, executable: command.executable, ...classifySessionProbe(stdout, 'Google', this.name) };
        }
        if (this.kind === 'grok') {
          const { stdout } = await this.run(command, ['models'], { timeout: 15_000 });
          return { installed: true, version, executable: command.executable, ...classifySessionProbe(stdout, 'xAI account', this.name) };
        }
        const { stdout } = await this.run(command, ['auth', 'status', '--json'], { timeout: 10_000 });
        const auth = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
        return { installed: true, authenticated: auth.loggedIn === true, version, accountType: auth.subscriptionType || auth.authMethod, executable: command.executable };
      } catch (error) {
        return { installed: true, authenticated: false, version, executable: command.executable, error: error instanceof Error ? error.message : String(error) };
      }
    } catch (error) {
      return { installed: false, authenticated: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  public formatStatus(status: CliStatus): string {
    if (!status.installed) return 'Not installed';
    if (!status.authenticated) return `Not authenticated${status.version ? ` · ${status.version}` : ''}`;
    const details = [status.version, status.accountType].filter(Boolean).join(' · ');
    return `Available${details ? ` · ${details}` : ''}`;
  }

  public openLoginTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: `${this.name} Login` });
    terminal.show();
    if (this.kind === 'antigravity') terminal.sendText(process.platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash', true);
    else terminal.sendText(`npm install -g ${this.packageName()}`, true);
    terminal.sendText(this.kind === 'codex' ? 'codex login' : this.kind === 'claude' ? 'claude auth login --claudeai' : this.kind === 'antigravity' ? 'agy' : 'grok login', true);
  }

  public openInstallTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: `Install ${this.name}` });
    terminal.show();
    terminal.sendText(this.kind === 'codex' ? 'npm install -g @openai/codex' : this.kind === 'claude' ? 'npm install -g @anthropic-ai/claude-code' : this.kind === 'grok' ? 'npm install -g @xai-official/grok' : process.platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash', true);
  }

  public openLogoutTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: `${this.name} Logout` });
    terminal.show();
    const runner = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    terminal.sendText(this.kind === 'codex' ? `${runner} --yes ${this.packageName()} logout` : this.kind === 'claude' ? `${runner} --yes ${this.packageName()} auth logout` : this.kind === 'antigravity' ? 'agy' : 'grok logout', true);
  }

  public getRateLimitStatus(): RateLimitStatus {
    return { requestsRemaining: Infinity, requestsLimit: Infinity, tokensRemaining: Infinity, tokensLimit: Infinity, resetAt: null, isLimited: false };
  }

  public async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResponse> {
    const prompt = messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    return this.kind === 'codex' ? this.runCodex(prompt, cwd, options)
      : this.kind === 'claude' ? this.runClaude(prompt, cwd, options)
      : this.kind === 'antigravity' ? this.runAntigravity(prompt, cwd, options)
      : this.runGrok(prompt, cwd, options);
  }

  public async *stream(messages: Message[], options: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    const response = await this.chat(messages, options);
    yield { content: response.content, done: false };
    yield { content: '', done: true };
  }

  public configure(_config: ProviderConfig): void {}
  public dispose(): void {}

  private async runCodex(prompt: string, cwd: string, options: ChatOptions): Promise<ChatResponse> {
    // "-" makes `codex exec` read the prompt from stdin: no command-line length limit, nothing for a shell to interpret.
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only'];
    if (options.model && options.model !== 'codex-default') args.push('--model', options.model);
    args.push('-');
    const stdout = await this.exec(args, cwd, options.signal, prompt);
    let content = '';
    let inputTokens = 0; let outputTokens = 0;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') content = event.item.text || content;
        if (event.usage) { inputTokens = event.usage.input_tokens || inputTokens; outputTokens = event.usage.output_tokens || outputTokens; }
      } catch { /* JSONL may include non-event diagnostics. */ }
    }
    // Codex reports a usage limit as an `error` event on stdout, not as a message; surface its text so the supervisor can pause this agent.
    if (!content) throw new Error(extractCliError(stdout) || 'Codex CLI returned no final agent message.');
    return { content, model: options.model || 'codex-default', provider: this.id, finishReason: 'stop', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimatedCost: 0 } };
  }

  private async runClaude(prompt: string, cwd: string, options: ChatOptions): Promise<ChatResponse> {
    // `-p` without a value is print mode and reads the prompt from stdin. The extension runs its own tools, so Claude's
    // built-in ones are switched off (`--tools ""`): with them on, a single-turn run ends in error_max_turns as soon as
    // the model reaches for a tool instead of answering.
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--max-turns', '1', '--tools', ''];
    if (options.model) args.push('--model', options.model);
    const stdout = await this.exec(args, cwd, options.signal, prompt);
    const data = parseCliJson<{ result?: string; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number }; subtype?: string; errors?: string[] }>(this.name, stdout);
    if (data.is_error) throw new Error((data.result || data.errors?.join('; ') || `Claude Code failed (${data.subtype || 'unknown'}).`).replace(/\s+/g, ' ').slice(0, 500));
    if (!data.result) throw new Error(`Claude Code returned no result (${data.subtype || 'unknown'}).`);
    const inputTokens = data.usage?.input_tokens || 0; const outputTokens = data.usage?.output_tokens || 0;
    return { content: data.result, model: options.model || 'sonnet', provider: this.id, finishReason: 'stop', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimatedCost: 0 } };
  }

  private async runAntigravity(prompt: string, cwd: string, options: ChatOptions): Promise<ChatResponse> {
    const args = ['-p', prompt, '--output-format', 'json', '--sandbox'];
    if (options.model) args.push('--model', options.model);
    const stdout = await this.exec(args, cwd, options.signal);
    const data = parseCliJson<{ response?: string; error?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }>(this.name, stdout);
    if (!data.response) throw new Error(data.error || 'Antigravity returned no response. Complete Google login in an interactive terminal first.');
    const inputTokens = data.usage?.input_tokens || 0; const outputTokens = data.usage?.output_tokens || 0;
    return { content: data.response, model: options.model || 'antigravity-default', provider: this.id, finishReason: 'stop', usage: { inputTokens, outputTokens, totalTokens: data.usage?.total_tokens || inputTokens + outputTokens, estimatedCost: 0 } };
  }

  private async runGrok(prompt: string, cwd: string, options: ChatOptions): Promise<ChatResponse> {
    const args = ['--no-auto-update', '-p', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--max-turns', '1'];
    if (options.model && options.model !== 'grok-build') args.push('--model', options.model);
    const stdout = await this.exec(args, cwd, options.signal);
    const data = parseCliJson<{ text?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }>(this.name, stdout);
    if (!data.text) throw new Error('Grok Build returned no response. Run grok login first.');
    const inputTokens = data.usage?.input_tokens || 0; const outputTokens = data.usage?.output_tokens || 0;
    return { content: data.text, model: options.model || 'grok-build', provider: this.id, finishReason: 'stop', usage: { inputTokens, outputTokens, totalTokens: data.usage?.total_tokens || inputTokens + outputTokens, estimatedCost: 0 } };
  }

  /** Runs the resolved CLI and rethrows failures without the argv (which would contain the whole prompt). */
  private async exec(args: string[], cwd: string, signal?: AbortSignal, input?: string): Promise<string> {
    const command = await this.resolveCommand(true);
    try {
      const { stdout } = await this.run(command, args, { cwd, timeout: 300_000, signal, input });
      return stdout;
    } catch (error) {
      throw new Error(describeCliFailure(this.name, error));
    }
  }

  /** Every CLI launch goes through here so Windows `.cmd` shims are resolved to their real target instead of spawned (EINVAL). */
  private async run(command: CliCommand, args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
    const launch = await resolveLaunch(command.executable);
    return runProcess({ ...launch, prefix: [...launch.prefix, ...command.prefix] }, args, options);
  }

  private async resolveCommand(allowNpx: boolean): Promise<CliCommand> {
    // Always an absolute path: a bare `npx.cmd` would be resolved by Windows against the workspace directory first.
    const found = await locateProgram(this.kind === 'antigravity' ? 'agy' : this.kind, true);
    if (found) return { executable: found, prefix: [] };
    const explicit = await this.explicitInstallPath();
    if (explicit) return { executable: explicit, prefix: [] };
    if (!allowNpx || this.kind === 'antigravity') throw new Error(`${this.kind} CLI is not installed or not on PATH.`);
    const npx = await locateProgram('npx', true);
    if (!npx) throw new Error(`${this.kind} CLI is not installed and npx was not found on PATH.`);
    return { executable: npx, prefix: ['--yes', this.packageName()] };
  }

  private packageName(): string {
    if (this.kind === 'antigravity') throw new Error('Antigravity uses its native installer, not npm.');
    return this.kind === 'codex' ? '@openai/codex' : this.kind === 'claude' ? '@anthropic-ai/claude-code' : '@xai-official/grok';
  }

  private async explicitInstallPath(): Promise<string | undefined> {
    if (this.kind === 'antigravity') {
      const candidate = process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
        : join(homedir(), '.local', 'bin', 'agy');
      return existsSync(candidate) ? candidate : undefined;
    }
    if (process.platform === 'win32') {
      // npm's default global prefix; avoids spawning `npm.cmd` just to ask for it.
      const candidate = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', `${this.kind}.cmd`);
      return existsSync(candidate) ? candidate : undefined;
    }
    try {
      const { stdout } = await runProcess({ executable: 'npm', prefix: [] }, ['prefix', '-g'], { timeout: 5_000 });
      const candidate = join(stdout.trim(), 'bin', this.kind);
      return existsSync(candidate) ? candidate : undefined;
    } catch { return undefined; }
  }
}
