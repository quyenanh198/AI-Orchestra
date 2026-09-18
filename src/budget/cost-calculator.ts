import { PRICING_TABLE, calculateCost } from '../config/pricing';

export class CostCalculator {
    /**
     * Calculates the exact cost of a request in USD.
     */
    public calculateRequestCost(model: string, inputTokens: number, outputTokens: number, provider?: string): number {
        return calculateCost(model, inputTokens, outputTokens, provider);
    }

    /**
     * Estimates the cost of a request in USD.
     */
    public estimateRequestCost(model: string, estimatedInputTokens: number, estimatedOutputTokens: number, provider?: string): number {
        return calculateCost(model, estimatedInputTokens, estimatedOutputTokens, provider);
    }

    /**
     * Categorizes a model by its price tier.
     */
    public getModelTier(model: string): 'budget' | 'standard' | 'premium' {
        const pricing = PRICING_TABLE[model];
        if (!pricing) return 'premium';
        
        const avgCostPerM = (pricing.inputPricePerMToken + pricing.outputPricePerMToken) / 2;
        
        if (avgCostPerM < 1.0) {
            return 'budget';
        } else if (avgCostPerM < 10.0) {
            return 'standard';
        } else {
            return 'premium';
        }
    }

    /**
     * Suggests a cheaper alternative model if available.
     */
    public getCheaperAlternative(currentModel: string): string | null {
        const currentTier = this.getModelTier(currentModel);
        if (currentTier === 'budget') return null;

        if (currentModel.includes('gpt-4o') || currentModel.includes('o3-')) {
            return 'gpt-4o-mini';
        } else if (currentModel.includes('claude-opus')) {
            return 'claude-sonnet-4-20250514';
        } else if (currentModel.includes('gemini-2.5-pro')) {
            return 'gemini-2.5-flash';
        }
        
        // General fallback
        return 'gpt-4o-mini';
    }

    /**
     * Formats a cost value as a USD string.
     */
    public formatCost(cost: number): string {
        return `$${cost.toFixed(4)}`;
    }
}
