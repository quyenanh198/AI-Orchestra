import * as vscode from 'vscode';
import OpenAI from 'openai';
import { AIProvider, ProviderConfig, ChatOptions, Message, ChatResponse, ChatChunk, ModelInfo, RateLimitStatus, TokenUsage, ProviderEvents } from './types';

export class OpenAIProvider implements AIProvider {
  public readonly id = 'openai';
  public readonly name = 'OpenAI';
  
  public readonly models: ModelInfo[] = [
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      provider: 'openai',
      maxContextTokens: 128000,
      inputPricePerMToken: 2.50,
      outputPricePerMToken: 10.00,
      tier: 'standard'
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      provider: 'openai',
      maxContextTokens: 128000,
      inputPricePerMToken: 0.15,
      outputPricePerMToken: 0.60,
      tier: 'budget'
    },
    {
      id: 'o3-mini',
      name: 'o3-mini',
      provider: 'openai',
      maxContextTokens: 200000,
      inputPricePerMToken: 1.10,
      outputPricePerMToken: 4.40,
      tier: 'premium'
    }
  ];

  private client?: OpenAI;
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
    if ('apiKey' in config) this.client = config.apiKey ? new OpenAI({ apiKey: config.apiKey }) : undefined;
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

  private updateRateLimit(headers: any) {
    if (!headers) return;
    
    // Parse headers if available
    const remReq = headers['x-ratelimit-remaining-requests'];
    const limitReq = headers['x-ratelimit-limit-requests'];
    const remTok = headers['x-ratelimit-remaining-tokens'];
    const limitTok = headers['x-ratelimit-limit-tokens'];
    
    if (remReq) this.rateLimitStatus.requestsRemaining = parseInt(remReq, 10);
    if (limitReq) this.rateLimitStatus.requestsLimit = parseInt(limitReq, 10);
    if (remTok) this.rateLimitStatus.tokensRemaining = parseInt(remTok, 10);
    if (limitTok) this.rateLimitStatus.tokensLimit = parseInt(limitTok, 10);
    
    this.rateLimitStatus.isLimited = this.rateLimitStatus.requestsRemaining === 0 || this.rateLimitStatus.tokensRemaining === 0;
    
    if (this.rateLimitStatus.isLimited) {
      this._onRateLimitHit.fire(this.rateLimitStatus);
    }
  }

  public async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    if (!this.client) throw new Error('OpenAI client not configured');

    const modelId = options?.model || this.models[0].id;
    const openaiMessages: any[] = [];
    
    if (options?.systemPrompt) {
      openaiMessages.push({ role: 'system', content: options.systemPrompt });
    }
    
    openaiMessages.push(...messages.map(m => ({ role: m.role, content: m.content })));

    try {
      const response = await this.client.chat.completions.create({
        model: modelId,
        messages: openaiMessages,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
      }, { signal: options?.signal }) as any;

      // Extract rate limits from response if we can access headers (requires raw response handling, simplified here)
      
      const usage = response.usage;
      const tokenUsage: TokenUsage = {
        inputTokens: usage?.prompt_tokens || 0,
        outputTokens: usage?.completion_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
        estimatedCost: this.calculateCost(modelId, usage?.prompt_tokens || 0, usage?.completion_tokens || 0)
      };

      this._onUsageUpdate.fire(tokenUsage);

      return {
        content: response.choices[0]?.message?.content || '',
        model: response.model,
        provider: this.id,
        usage: tokenUsage,
        finishReason: response.choices[0]?.finish_reason || 'unknown'
      };
    } catch (error: any) {
      if (error.status === 429) {
        this.rateLimitStatus.isLimited = true;
        this.rateLimitStatus.resetAt = new Date(Date.now() + 60_000);
        this._onRateLimitHit.fire(this.rateLimitStatus);
      }
      this._onError.fire(error);
      throw error;
    }
  }

  public async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<ChatChunk> {
    if (!this.client) throw new Error('OpenAI client not configured');

    const modelId = options?.model || this.models[0].id;
    const openaiMessages: any[] = [];
    
    if (options?.systemPrompt) {
      openaiMessages.push({ role: 'system', content: options.systemPrompt });
    }
    
    openaiMessages.push(...messages.map(m => ({ role: m.role, content: m.content })));

    try {
      const stream = await this.client.chat.completions.create({
        model: modelId,
        messages: openaiMessages,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        stream: true
      }, { signal: options?.signal });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield { content, done: false };
        }
      }
      yield { content: '', done: true };
    } catch (error: any) {
      if (error.status === 429) {
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
