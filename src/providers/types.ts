import * as vscode from 'vscode';

/** Role in a conversation */
export type MessageRole = 'system' | 'user' | 'assistant';

/** A single message in a conversation */
export interface Message {
  role: MessageRole;
  content: string;
}

/** Options for a chat request */
export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
}

/** A chunk from a streaming response */
export interface ChatChunk {
  content: string;
  done: boolean;
}

/** Complete chat response */
export interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  usage: TokenUsage;
  finishReason: string;
}

/** Token usage for a single request */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number; // USD
}

/** Rate limit status for a provider */
export interface RateLimitStatus {
  requestsRemaining: number;
  requestsLimit: number;
  tokensRemaining: number;
  tokensLimit: number;
  resetAt: Date | null;
  isLimited: boolean;
}

/** Model info */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxContextTokens: number;
  inputPricePerMToken: number;  // USD per million tokens
  outputPricePerMToken: number;
  tier: 'budget' | 'standard' | 'premium';
}

/** Budget configuration */
export interface BudgetConfig {
  maxTokensPerSession: number;
  maxCostPerDay: number;
  maxRequestsPerMinute: number;
  warningThreshold: number;
  fallbackOrder: string[];
  autoDowngrade: boolean;
}

/** Provider configuration */
export interface ProviderConfig {
  apiKey?: string;
  endpoint?: string;
  enabledModels?: string[];
}

/** The main AI provider interface */
export interface AIProvider {
  readonly id: string;
  readonly name: string;
  readonly models: ModelInfo[];
  /** Set when the provider can only take the prompt on its command line, which the OS limits in length. */
  readonly maxPromptChars?: number;

  /** Check if provider is configured and available */
  isAvailable(): Promise<boolean>;

  /** Get current rate limit status */
  getRateLimitStatus(): RateLimitStatus;

  /** Send a chat request */
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;

  /** Stream a chat response */
  stream(messages: Message[], options?: ChatOptions): AsyncGenerator<ChatChunk>;

  /** Configure the provider (set API key etc) */
  configure(config: ProviderConfig): void;

  /** Dispose resources */
  dispose(): void;
}

/** Events emitted by providers */
export interface ProviderEvents {
  onUsageUpdate: vscode.Event<TokenUsage>;
  onRateLimitHit: vscode.Event<RateLimitStatus>;
  onError: vscode.Event<Error>;
}
