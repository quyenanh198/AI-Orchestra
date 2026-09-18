import * as vscode from 'vscode';
import { AIProvider, ChatChunk, ChatOptions, ChatResponse, Message, ModelInfo, ProviderConfig, RateLimitStatus } from './types';

/** Uses models exposed by VS Code (normally GitHub Copilot) without handling provider tokens. */
export class VSCodeLanguageModelProvider implements AIProvider {
  public readonly id = 'vscode-lm';
  public readonly name = 'GitHub Copilot / VS Code Models';
  public readonly models: ModelInfo[] = [{
    id: 'vscode-lm-auto', name: 'VS Code selected model', provider: this.id,
    maxContextTokens: 128_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier: 'standard',
  }];

  public async signIn(): Promise<string> {
    const session = await vscode.authentication.getSession('github', ['read:user'], {
      createIfNone: { detail: 'AI Orchestra uses your GitHub account to access models exposed by VS Code. The extension does not store the access token.' },
    });
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) throw new Error('GitHub sign-in succeeded, but VS Code exposes no Copilot language models for this account.');
    return session.account.label;
  }

  public async isAvailable(): Promise<boolean> {
    return (await vscode.lm.selectChatModels({ vendor: 'copilot' })).length > 0;
  }

  public getRateLimitStatus(): RateLimitStatus {
    return { requestsRemaining: Infinity, requestsLimit: Infinity, tokensRemaining: Infinity, tokensLimit: Infinity, resetAt: null, isLimited: false };
  }

  public async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResponse> {
    const model = await this.selectModel(options.model);
    const input = this.toVSCodeMessages(messages);
    const inputTokens = await this.countInput(model, input);
    const response = await model.sendRequest(input, { justification: 'Run an AI Orchestra worker assigned by the user.' }, this.cancellation(options.signal));
    let content = '';
    for await (const part of response.text) content += part;
    const outputTokens = await model.countTokens(content);
    return {
      content, model: model.id, provider: this.id, finishReason: 'stop',
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimatedCost: 0 },
    };
  }

  public async *stream(messages: Message[], options: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    const model = await this.selectModel(options.model);
    const response = await model.sendRequest(
      this.toVSCodeMessages(messages),
      { justification: 'Run an AI Orchestra worker assigned by the user.' },
      this.cancellation(options.signal),
    );
    for await (const content of response.text) yield { content, done: false };
    yield { content: '', done: true };
  }

  public configure(_config: ProviderConfig): void {}
  public dispose(): void {}

  private async selectModel(requested?: string): Promise<vscode.LanguageModelChat> {
    const selector = requested && requested !== 'vscode-lm-auto' ? { vendor: 'copilot', id: requested } : { vendor: 'copilot' };
    const models = await vscode.lm.selectChatModels(selector);
    if (!models[0]) throw new Error('No GitHub Copilot language model is available. Sign in from AI Orchestra: Configure Providers.');
    return models[0];
  }

  private toVSCodeMessages(messages: Message[]): vscode.LanguageModelChatMessage[] {
    return messages.map(message => message.role === 'assistant'
      ? vscode.LanguageModelChatMessage.Assistant(message.content)
      : vscode.LanguageModelChatMessage.User(message.role === 'system' ? `SYSTEM INSTRUCTION:\n${message.content}` : message.content));
  }

  private async countInput(model: vscode.LanguageModelChat, messages: vscode.LanguageModelChatMessage[]): Promise<number> {
    const counts = await Promise.all(messages.map(message => model.countTokens(message)));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  private cancellation(signal?: AbortSignal): vscode.CancellationToken | undefined {
    if (!signal) return undefined;
    const source = new vscode.CancellationTokenSource();
    if (signal.aborted) source.cancel();
    else signal.addEventListener('abort', () => source.cancel(), { once: true });
    return source.token;
  }
}
