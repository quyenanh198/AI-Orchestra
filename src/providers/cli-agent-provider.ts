import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AIProvider, ChatChunk, ChatOptions, ChatResponse, Message, ModelInfo, ProviderConfig, RateLimitStatus } from './types';

const execFileAsync = promisify(execFile);

type CliKind = 'codex' | 'claude';

export class CliAgentProvider implements AIProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly models: ModelInfo[];

  constructor(private readonly kind: CliKind) {
    this.id = kind === 'codex' ? 'codex-cli' : 'claude-code';
    this.name = kind === 'codex' ? 'OpenAI Codex (ChatGPT login)' : 'Claude Code (Claude login)';
    this.models = kind === 'codex'
      ? [{ id: 'codex-default', name: 'Codex account default', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'premium' }]
      : [
          { id: 'sonnet', name: 'Claude Sonnet (account)', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'standard' },
          { id: 'opus', name: 'Claude Opus (account)', provider: this.id, maxContextTokens: 200_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'premium' },
        ];
  }

  public async isAvailable(): Promise<boolean> {
    try {
      const executable = await this.resolveExecutable();
      if (this.kind === 'codex') {
        const { stdout } = await execFileAsync(executable, ['login', 'status'], { timeout: 10_000, windowsHide: true });
        return /logged in|chatgpt|api key/i.test(stdout);
      }
      const { stdout } = await execFileAsync(executable, ['auth', 'status', '--json'], { timeout: 10_000, windowsHide: true });
      return JSON.parse(stdout).loggedIn === true;
    } catch { return false; }
  }

  public openLoginTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: `${this.name} Login` });
    terminal.show();
    terminal.sendText(this.kind === 'codex' ? 'codex login' : 'claude auth login --claudeai', true);
  }

  public openInstallTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: `Install ${this.name}` });
    terminal.show();
    terminal.sendText(this.kind === 'codex' ? 'npm install -g @openai/codex' : 'npm install -g @anthropic-ai/claude-code', true);
  }

  public openLogoutTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: `${this.name} Logout` });
    terminal.show();
    terminal.sendText(this.kind === 'codex' ? 'codex logout' : 'claude auth logout', true);
  }

  public getRateLimitStatus(): RateLimitStatus {
    return { requestsRemaining: Infinity, requestsLimit: Infinity, tokensRemaining: Infinity, tokensLimit: Infinity, resetAt: null, isLimited: false };
  }

  public async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResponse> {
    const prompt = messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    return this.kind === 'codex'
      ? this.runCodex(prompt, cwd, options)
      : this.runClaude(prompt, cwd, options);
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
    const { stdout } = await execFileAsync(await this.resolveExecutable(), args, { cwd, timeout: 300_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal: options.signal });
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
    const { stdout } = await execFileAsync(await this.resolveExecutable(), args, { cwd, timeout: 300_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal: options.signal });
    const data = JSON.parse(stdout) as { result?: string; usage?: { input_tokens?: number; output_tokens?: number }; subtype?: string };
    if (!data.result) throw new Error(`Claude Code returned no result (${data.subtype || 'unknown'}).`);
    const inputTokens = data.usage?.input_tokens || 0; const outputTokens = data.usage?.output_tokens || 0;
    return { content: data.result, model: options.model || 'sonnet', provider: this.id, finishReason: 'stop', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimatedCost: 0 } };
  }

  private async resolveExecutable(): Promise<string> {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(locator, [this.kind], { timeout: 5_000, windowsHide: true });
    const executable = stdout.split(/\r?\n/).find(Boolean);
    if (!executable) throw new Error(`${this.kind} CLI is not installed or not on PATH.`);
    return executable.trim();
  }
}
