import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, ProviderConfig, ChatOptions, Message, ChatResponse, ChatChunk, ModelInfo, RateLimitStatus, TokenUsage, ProviderEvents } from './types';

export class AnthropicProvider implements AIProvider {
  public readonly id = 'anthropic';
  public readonly name = 'Anthropic';
  
  public readonly models: ModelInfo[] = [
    {
      id: 'claude-sonnet-4-20250514',
      name: 'Claude 3.5 Sonnet',
      provider: 'anthropic',
      maxContextTokens: 200000,
      inputPricePerMToken: 3.00,
      outputPricePerMToken: 15.00,
      tier: 'standard'
    },
    {
      id: 'claude-opus-4-20250514',
      name: 'Claude 3 Opus',
      provider: 'anthropic',
      maxContextTokens: 200000,
      inputPricePerMToken: 15.00,
      outputPricePerMToken: 75.00,
      tier: 'premium'
    }
  ];

  private client?: Anthropic;
  private rateLimitStatus: RateLimitStatus = {
    requestsRemaining: -1,
    requestsLimit: -1,
    tokensRemaining: -1,
    tokensLimit: -1,
    resetAt: null,
    isLimited: false
  };

  private _onUsageUpdate = new vscode.EventEmitter<TokenUsage>();
  private _onRateLimitHit = new vscode.EventEmitter<RateLimitStatus>();
  private _onError = new vscode.EventEmitter<Error>();

  public events: ProviderEvents = {
    onUsageUpdate: this._onUsageUpdate.event,
    onRateLimitHit: this._onRateLimitHit.event,
    onError: this._onError.event
  };

  public configure(config: ProviderConfig): void {
    if ('apiKey' in config) this.client = config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : undefined;
  }

  public async isAvailable(): Promise<boolean> {
    return !!this.client;
  }

  public getRateLimitStatus(): RateLimitStatus {
    if (this.rateLimitStatus.isLimited && this.rateLimitStatus.resetAt && this.rateLimitStatus.resetAt.getTime() <= Date.now()) {
      this.rateLimitStatus.isLimited = false;
      this.rateLimitStatus.resetAt = null;
    }
    return this.rateLimitStatus;
  }

  private calculateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const modelInfo = this.models.find(m => m.id === modelId);
    if (!modelInfo) return 0;
    return (inputTokens / 1000000 * modelInfo.inputPricePerMToken) + 
           (outputTokens / 1000000 * modelInfo.outputPricePerMToken);
  }

  public async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    if (!this.client) throw new Error('Anthropic client not configured');

    const modelId = options?.model || this.models[0].id;
    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    try {
      const response = await this.client.messages.create({
        model: modelId,
        messages: anthropicMessages,
        system: options?.systemPrompt,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens || 4096,
      }, { signal: options?.signal }) as any;

      // Extract usage
      const usage = response.usage;
      const tokenUsage: TokenUsage = {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        estimatedCost: this.calculateCost(modelId, usage.input_tokens || 0, usage.output_tokens || 0)
      };

      this._onUsageUpdate.fire(tokenUsage);

      let textContent = '';
      if (response.content && response.content.length > 0 && response.content[0].type === 'text') {
          textContent = response.content[0].text;
      }

      return {
        content: textContent,
        model: modelId,
        provider: this.id,
        usage: tokenUsage,
        finishReason: response.stop_reason || 'unknown'
      };
    } catch (error: any) {
      if (error.status === 429 || error?.error?.type === 'rate_limit_error' || error?.error?.type === 'overloaded_error') {
        this.rateLimitStatus.isLimited = true;
        this.rateLimitStatus.resetAt = new Date(Date.now() + 60_000);
        this._onRateLimitHit.fire(this.rateLimitStatus);
      }
      this._onError.fire(error);
      throw error;
    }
  }

  public async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<ChatChunk> {
    if (!this.client) throw new Error('Anthropic client not configured');

    const modelId = options?.model || this.models[0].id;
    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    try {
      const stream = await this.client.messages.create({
        model: modelId,
        messages: anthropicMessages,
        system: options?.systemPrompt,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens || 4096,
        stream: true
      }, { signal: options?.signal });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
            yield { content: chunk.delta.text, done: false };
        }
      }
      yield { content: '', done: true };
    } catch (error: any) {
      if (error.status === 429 || error?.error?.type === 'rate_limit_error' || error?.error?.type === 'overloaded_error') {
        this.rateLimitStatus.isLimited = true;
        this.rateLimitStatus.resetAt = new Date(Date.now() + 60_000);
        this._onRateLimitHit.fire(this.rateLimitStatus);
      }
      this._onError.fire(error);
      throw error;
    }
  }

  public dispose(): void {
    this._onUsageUpdate.dispose();
    this._onRateLimitHit.dispose();
    this._onError.dispose();
  }
}
