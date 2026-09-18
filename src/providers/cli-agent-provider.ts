import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AIProvider, ChatChunk, ChatOptions, ChatResponse, Message, ModelInfo, ProviderConfig, RateLimitStatus } from './types';

const execFileAsync = promisify(execFile);

type CliKind = 'codex' | 'claude' | 'antigravity';
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

  constructor(private readonly kind: CliKind) {
    this.id = kind === 'codex' ? 'codex-cli' : kind === 'claude' ? 'claude-code' : 'antigravity-cli';
    this.name = kind === 'codex' ? 'OpenAI Codex (ChatGPT login)' : kind === 'claude' ? 'Claude Code (Claude login)' : 'Google Antigravity (Google login)';
    this.models = kind === 'codex'
      ? [{ id: 'codex-default', name: 'Codex account default', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'premium' }]
      : kind === 'claude' ? [
          { id: 'sonnet', name: 'Claude Sonnet (account)', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'standard' },
          { id: 'opus', name: 'Claude Opus (account)', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'premium' },
        ] : [
          { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High', provider: this.id, maxContextTokens: 1_000_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'standard' },
          { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High', provider: this.id, maxContextTokens: 1_000_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'premium' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 via Antigravity', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'standard' },
        ];
  }

  public async isAvailable(): Promise<boolean> {
    return (await this.checkStatus()).authenticated;
  }

  public async checkStatus(): Promise<CliStatus> {
    try {
      const command = await this.resolveCommand(false);
      const versionResult = await execFileAsync(command.executable, [...command.prefix, '--version'], { timeout: 10_000, windowsHide: true });
      const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim().split(/\r?\n/)[0];
      try {
        if (this.kind === 'codex') {
          const { stdout, stderr } = await execFileAsync(command.executable, [...command.prefix, 'login', 'status'], { timeout: 10_000, windowsHide: true });
          const authOutput = `${stdout}\n${stderr}`;
          return { installed: true, authenticated: /logged in|chatgpt|api key/i.test(authOutput), version, accountType: /chatgpt/i.test(authOutput) ? 'ChatGPT' : undefined, executable: command.executable };
        }
        if (this.kind === 'antigravity') {
          const { stdout } = await execFileAsync(command.executable, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '10s'], { timeout: 15_000, windowsHide: true });
          return { installed: true, authenticated: !/authentication required/i.test(stdout), version, accountType: 'Google', executable: command.executable };
        }
        const { stdout } = await execFileAsync(command.executable, [...command.prefix, 'auth', 'status', '--json'], { timeout: 10_000, windowsHide: true });
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
    terminal.sendText(this.kind === 'codex' ? 'codex login' : this.kind === 'claude' ? 'claude auth login --claudeai' : 'agy', true);
  }

  public openInstallTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: `Install ${this.name}` });
    terminal.show();
    terminal.sendText(this.kind === 'codex' ? 'npm install -g @openai/codex' : this.kind === 'claude' ? 'npm install -g @anthropic-ai/claude-code' : process.platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash', true);
  }

  public openLogoutTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: `${this.name} Logout` });
    terminal.show();
    const runner = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    terminal.sendText(this.kind === 'codex' ? `${runner} --yes ${this.packageName()} logout` : this.kind === 'claude' ? `${runner} --yes ${this.packageName()} auth logout` : 'agy', true);
  }

  public getRateLimitStatus(): RateLimitStatus {
    return { requestsRemaining: Infinity, requestsLimit: Infinity, tokensRemaining: Infinity, tokensLimit: Infinity, resetAt: null, isLimited: false };
  }

  public async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResponse> {
    const prompt = messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    return this.kind === 'codex' ? this.runCodex(prompt, cwd, options)
      : this.kind === 'claude' ? this.runClaude(prompt, cwd, options)
      : this.runAntigravity(prompt, cwd, options);
  }

  public async *stream(messages: Message[], options: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    const response = await this.chat(messages, options);
    yield { content: response.content, done: false };
    yield { content: '', done: true };
  }

  public configure(_config: ProviderConfig): void {}
  public dispose(): void {}

  private async runCodex(prompt: string, cwd: string, options: ChatOptions): Promise<ChatResponse> {
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only'];
    if (options.model && options.model !== 'codex-default') args.push('--model', options.model);
    args.push(prompt);
    const command = await this.resolveCommand(true);
    const { stdout } = await execFileAsync(command.executable, [...command.prefix, ...args], { cwd, timeout: 300_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal: options.signal });
    let content = '';
    let inputTokens = 0; let outputTokens = 0;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') content = event.item.text || content;
        if (event.usage) { inputTokens = event.usage.input_tokens || inputTokens; outputTokens = event.usage.output_tokens || outputTokens; }
      } catch { /* JSONL may include non-event diagnostics. */ }
    }
    if (!content) throw new Error('Codex CLI returned no final agent message.');
    return { content, model: options.model || 'codex-default', provider: this.id, finishReason: 'stop', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimatedCost: 0 } };
  }

  private async runClaude(prompt: string, cwd: string, options: ChatOptions): Promise<ChatResponse> {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--max-turns', '1'];
    if (options.model) args.push('--model', options.model);
    const command = await this.resolveCommand(true);
    const { stdout } = await execFileAsync(command.executable, [...command.prefix, ...args], { cwd, timeout: 300_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal: options.signal });
    const data = JSON.parse(stdout) as { result?: string; usage?: { input_tokens?: number; output_tokens?: number }; subtype?: string };
    if (!data.result) throw new Error(`Claude Code returned no result (${data.subtype || 'unknown'}).`);
    const inputTokens = data.usage?.input_tokens || 0; const outputTokens = data.usage?.output_tokens || 0;
    return { content: data.result, model: options.model || 'sonnet', provider: this.id, finishReason: 'stop', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimatedCost: 0 } };
  }

  private async runAntigravity(prompt: string, cwd: string, options: ChatOptions): Promise<ChatResponse> {
    const args = ['-p', prompt, '--output-format', 'json', '--sandbox'];
    if (options.model) args.push('--model', options.model);
    const command = await this.resolveCommand(true);
    const { stdout } = await execFileAsync(command.executable, [...command.prefix, ...args], { cwd, timeout: 300_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal: options.signal });
    const start = stdout.indexOf('{');
    const data = JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as { response?: string; error?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
    if (!data.response) throw new Error(data.error || 'Antigravity returned no response. Complete Google login in an interactive terminal first.');
    const inputTokens = data.usage?.input_tokens || 0; const outputTokens = data.usage?.output_tokens || 0;
    return { content: data.response, model: options.model || 'antigravity-default', provider: this.id, finishReason: 'stop', usage: { inputTokens, outputTokens, totalTokens: data.usage?.total_tokens || inputTokens + outputTokens, estimatedCost: 0 } };
  }

  private async resolveCommand(allowNpx: boolean): Promise<CliCommand> {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
      const binary = this.kind === 'antigravity' ? 'agy' : this.kind;
      const { stdout } = await execFileAsync(locator, [binary], { timeout: 5_000, windowsHide: true });
      const candidates = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const executable = process.platform === 'win32'
        ? candidates.find(value => /\.(?:exe|cmd|bat)$/i.test(value))
        : candidates[0];
      if (executable) return { executable: executable.trim(), prefix: [] };
    } catch { /* Fall back to the official npm package on user-initiated execution. */ }
    const explicit = await this.explicitInstallPath();
    if (explicit) return { executable: explicit, prefix: [] };
    if (!allowNpx || this.kind === 'antigravity') throw new Error(`${this.kind} CLI is not installed or not on PATH.`);
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    return { executable: npx, prefix: ['--yes', this.packageName()] };
  }

  private packageName(): string {
    if (this.kind === 'antigravity') throw new Error('Antigravity uses its native installer, not npm.');
    return this.kind === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  }

  private async explicitInstallPath(): Promise<string | undefined> {
    if (this.kind === 'antigravity') {
      const candidate = process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
        : join(homedir(), '.local', 'bin', 'agy');
      return existsSync(candidate) ? candidate : undefined;
    }
    try {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const { stdout } = await execFileAsync(npm, ['prefix', '-g'], { timeout: 5_000, windowsHide: true });
      const prefix = stdout.trim();
      const candidate = process.platform === 'win32' ? join(prefix, `${this.kind}.cmd`) : join(prefix, 'bin', this.kind);
      return existsSync(candidate) ? candidate : undefined;
    } catch { return undefined; }
  }
}
