import * as vscode from 'vscode';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProvider, ProviderConfig, ChatOptions, Message, ChatResponse, ChatChunk, ModelInfo, RateLimitStatus, TokenUsage, ProviderEvents } from './types';

export interface GeminiOAuthCredentials { getRequestHeaders(): Promise<Record<string, string>>; }

export class GeminiProvider implements AIProvider {
  public readonly id = 'gemini';
  public readonly name = 'Google Gemini';
  
  public readonly models: ModelInfo[] = [
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      provider: 'gemini',
      maxContextTokens: 1048576,
      inputPricePerMToken: 0.15,
      outputPricePerMToken: 0.60,
      tier: 'budget'
    },
    {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      provider: 'gemini',
      maxContextTokens: 2097152,
      inputPricePerMToken: 1.25,
      outputPricePerMToken: 10.00,
      tier: 'premium'
    }
  ];

  private client?: GoogleGenerativeAI;
  private oauth?: GeminiOAuthCredentials;
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
    if ('apiKey' in config) this.client = config.apiKey ? new GoogleGenerativeAI(config.apiKey) : undefined;
  }

  public configureOAuth(credentials?: GeminiOAuthCredentials): void { this.oauth = credentials; }

  public async isAvailable(): Promise<boolean> {
    return !!this.client || !!this.oauth;
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
    if (this.oauth) return this.chatWithOAuth(messages, options);
    if (!this.client) throw new Error('Gemini client not configured');

    const modelId = options?.model || this.models[0].id;
    const model = this.client.getGenerativeModel({
      model: modelId,
      generationConfig: { maxOutputTokens: options?.maxTokens },
        systemInstruction: options?.systemPrompt
    });

    const geminiMessages = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));

    try {
      const chat = model.startChat({
          history: geminiMessages.slice(0, -1),
      });

      const lastMessage = geminiMessages[geminiMessages.length - 1].parts[0].text;
      const result = await chat.sendMessage(lastMessage);
      const response = result.response;

      const usageMetadata = response.usageMetadata;
      const tokenUsage: TokenUsage = {
        inputTokens: usageMetadata?.promptTokenCount || 0,
        outputTokens: usageMetadata?.candidatesTokenCount || 0,
        totalTokens: usageMetadata?.totalTokenCount || 0,
        estimatedCost: this.calculateCost(modelId, usageMetadata?.promptTokenCount || 0, usageMetadata?.candidatesTokenCount || 0)
      };

      this._onUsageUpdate.fire(tokenUsage);

      return {
        content: response.text(),
        model: modelId,
        provider: this.id,
        usage: tokenUsage,
        finishReason: response.candidates?.[0]?.finishReason || 'unknown'
      };
    } catch (error: any) {
      if (error?.status === 429) {
        this.rateLimitStatus.isLimited = true;
        this.rateLimitStatus.resetAt = new Date(Date.now() + 60_000);
        this._onRateLimitHit.fire(this.rateLimitStatus);
      }
      this._onError.fire(error);
      throw error;
    }
  }

  public async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<ChatChunk> {
    if (this.oauth) {
      const response = await this.chatWithOAuth(messages, options);
      yield { content: response.content, done: false };
      yield { content: '', done: true };
      return;
    }
    if (!this.client) throw new Error('Gemini client not configured');

    const modelId = options?.model || this.models[0].id;
    const model = this.client.getGenerativeModel({
      model: modelId,
      generationConfig: { maxOutputTokens: options?.maxTokens },
        systemInstruction: options?.systemPrompt
    });

    const geminiMessages = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));

    try {
      const chat = model.startChat({
          history: geminiMessages.slice(0, -1),
      });

      const lastMessage = geminiMessages[geminiMessages.length - 1].parts[0].text;
      const result = await chat.sendMessageStream(lastMessage);

      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        yield { content: chunkText, done: false };
      }
      yield { content: '', done: true };
    } catch (error: any) {
      if (error?.status === 429) {
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

  private async chatWithOAuth(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    if (!this.oauth) throw new Error('Gemini OAuth is not configured.');
    const modelId = options?.model || this.models[0].id;
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const contents = messages.filter(message => message.role !== 'system').map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }],
    }));
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`, {
      method: 'POST', signal: options?.signal,
      headers: { 'Content-Type': 'application/json', ...(await this.oauth.getRequestHeaders()) },
      body: JSON.stringify({ contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig: { maxOutputTokens: options?.maxTokens } }),
    });
    if (!response.ok) {
      if (response.status === 429) { this.rateLimitStatus.isLimited = true; this.rateLimitStatus.resetAt = new Date(Date.now() + 60_000); }
      throw new Error(`Gemini OAuth request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    }
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const usage = data.usageMetadata || {};
    const tokenUsage: TokenUsage = {
      inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0,
      totalTokens: usage.totalTokenCount || 0,
      estimatedCost: this.calculateCost(modelId, usage.promptTokenCount || 0, usage.candidatesTokenCount || 0),
    };
    return {
      content: data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '',
      model: modelId, provider: this.id, usage: tokenUsage,
      finishReason: data.candidates?.[0]?.finishReason || 'unknown',
    };
  }
}
