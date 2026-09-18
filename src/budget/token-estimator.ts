import { encode } from 'gpt-tokenizer';

export interface Message {
    role: string;
    content: string;
}

export class TokenEstimator {
    /**
     * Estimates tokens for a given text.
     * Uses gpt-tokenizer for OpenAI, heuristic for others.
     */
    public estimateTokens(text: string, provider?: string): number {
        if (!provider || provider.toLowerCase() === 'openai') {
            try {
                return encode(text).length;
            } catch {
                // Fallback if encoding fails
                return Math.ceil(text.length / 4);
            }
        }
        // Heuristic for non-OpenAI models: ~4 characters per token
        return Math.ceil(text.length / 4);
    }

    /**
     * Estimates tokens for an array of messages including overhead.
     */
    public estimateMessagesTokens(messages: Message[], provider?: string): number {
        let totalTokens = 0;
        const messageOverhead = 4; // Overhead per message

        for (const message of messages) {
            totalTokens += messageOverhead;
            totalTokens += this.estimateTokens(message.role, provider);
            totalTokens += this.estimateTokens(message.content, provider);
        }

        // Base overhead for the request (e.g., priming the model)
        totalTokens += 3;

        return totalTokens;
    }

    /**
     * Estimates response tokens based on input tokens.
     * Heuristic: Response is typically 1-2x the input, we'll estimate 1.5x as a baseline.
     */
    public estimateResponseTokens(inputTokens: number): number {
        return Math.ceil(inputTokens * 1.5);
    }
}
