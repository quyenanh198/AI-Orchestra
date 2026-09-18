export const PRICING_TABLE: Record<string, { inputPricePerMToken: number, outputPricePerMToken: number }> = {
    'gpt-4o': { inputPricePerMToken: 2.50, outputPricePerMToken: 10.00 },
    'gpt-4o-mini': { inputPricePerMToken: 0.15, outputPricePerMToken: 0.60 },
    'o3-mini': { inputPricePerMToken: 1.10, outputPricePerMToken: 4.40 },
    'claude-sonnet-4-20250514': { inputPricePerMToken: 3.00, outputPricePerMToken: 15.00 },
    'claude-opus-4-20250514': { inputPricePerMToken: 15.00, outputPricePerMToken: 75.00 },
    'gemini-2.5-flash': { inputPricePerMToken: 0.15, outputPricePerMToken: 0.60 },
    'gemini-2.5-pro': { inputPricePerMToken: 1.25, outputPricePerMToken: 10.00 },
};

const CONSERVATIVE_UNKNOWN_PRICING = { inputPricePerMToken: 15, outputPricePerMToken: 75 };

/**
 * Calculates the cost of a request in USD.
 * @param model The model identifier.
 * @param inputTokens The number of input tokens.
 * @param outputTokens The number of output tokens.
 * @returns The cost in USD.
 */
export function calculateCost(model: string, inputTokens: number, outputTokens: number, provider?: string): number {
    const pricing = ['ollama', 'vscode-lm', 'codex-cli', 'claude-code', 'gemini-cli'].includes(provider || '')
        ? { inputPricePerMToken: 0, outputPricePerMToken: 0 }
        : PRICING_TABLE[model] || CONSERVATIVE_UNKNOWN_PRICING;
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePerMToken;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePerMToken;
    return inputCost + outputCost;
}
