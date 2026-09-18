import * as vscode from 'vscode';
import axios from 'axios';
import { AIProvider, ProviderConfig, ChatOptions, Message, ChatResponse, ChatChunk, ModelInfo, RateLimitStatus, TokenUsage, ProviderEvents } from './types';

export class OllamaProvider implements AIProvider {
  public readonly id = 'ollama';
  public readonly name = 'Ollama';
  
  public models: ModelInfo[] = [];

  private endpoint = 'http://localhost:11434';
  
  private rateLimitStatus: RateLimitStatus = {
    requestsRemaining: Number.MAX_SAFE_INTEGER,
    requestsLimit: Number.MAX_SAFE_INTEGER,
    tokensRemaining: Number.MAX_SAFE_INTEGER,
    tokensLimit: Number.MAX_SAFE_INTEGER,
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

  constructor() {
    this.refreshModels();
  }

  public configure(config: ProviderConfig): void {
    if (config.endpoint) {
      this.endpoint = config.endpoint;
      this.refreshModels();
    }
  }

  public async isAvailable(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.endpoint}/api/tags`);
      return response.status === 200;
    } catch {
      return false;
    }
  }

  public async refreshModels(): Promise<void> {
    try {
      const response = await axios.get(`${this.endpoint}/api/tags`);
      if (response.data && Array.isArray(response.data.models)) {
        this.models = response.data.models.map((m: any) => ({
          id: m.name,
          name: m.name,
          provider: 'ollama',
          maxContextTokens: 4096, // default ollama context
          inputPricePerMToken: 0,
          outputPricePerMToken: 0,
          tier: 'budget'
        }));
      }
    } catch {
      // failed to fetch models, endpoint might be down
    }
  }

  public getRateLimitStatus(): RateLimitStatus {
    return this.rateLimitStatus;
  }

  public async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    if (this.models.length === 0) {
        await this.refreshModels();
    }
    
    const modelId = options?.model || (this.models.length > 0 ? this.models[0].id : 'llama3');
    const ollamaMessages = [];
    
    if (options?.systemPrompt) {
        ollamaMessages.push({ role: 'system', content: options.systemPrompt });
    }
    ollamaMessages.push(...messages);

    try {
      const response = await axios.post(`${this.endpoint}/api/chat`, {
        model: modelId,
        messages: ollamaMessages,
        stream: false,
        options: {
            temperature: options?.temperature,
            num_predict: options?.maxTokens
        }
      }, {
        signal: options?.signal as any
      });

      const tokenUsage: TokenUsage = {
        inputTokens: response.data.prompt_eval_count || 0,
        outputTokens: response.data.eval_count || 0,
        totalTokens: (response.data.prompt_eval_count || 0) + (response.data.eval_count || 0),
        estimatedCost: 0
      };

      this._onUsageUpdate.fire(tokenUsage);

      return {
        content: response.data.message?.content || '',
        model: modelId,
        provider: this.id,
        usage: tokenUsage,
        finishReason: response.data.done_reason || 'stop'
      };
    } catch (error: any) {
      this._onError.fire(error);
      throw error;
    }
  }

  public async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<ChatChunk> {
    if (this.models.length === 0) {
        await this.refreshModels();
    }
    
    const modelId = options?.model || (this.models.length > 0 ? this.models[0].id : 'llama3');
    const ollamaMessages = [];
    
    if (options?.systemPrompt) {
        ollamaMessages.push({ role: 'system', content: options.systemPrompt });
    }
    ollamaMessages.push(...messages);

    try {
      const response = await axios.post(`${this.endpoint}/api/chat`, {
        model: modelId,
        messages: ollamaMessages,
        stream: true,
        options: {
            temperature: options?.temperature,
            num_predict: options?.maxTokens
        }
      }, {
        responseType: 'stream',
        signal: options?.signal as any
      });

      const stream = response.data;
      
      for await (const chunk of stream) {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
              if (line.trim()) {
                  const data = JSON.parse(line);
                  if (data.message?.content) {
                      yield { content: data.message.content, done: false };
                  }
                  if (data.done) {
                      yield { content: '', done: true };
                  }
              }
          }
      }
    } catch (error: any) {
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
