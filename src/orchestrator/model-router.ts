import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/provider-registry';
import { AIProvider, ModelInfo } from '../providers/types';
import { BudgetManager } from '../budget/budget-manager';
import { TaskAnalysis } from './task-analyzer';

export interface RoutingDecision {
  provider: string;
  model: string;
  reason: string;
  wasFallback: boolean;
  originalModel?: string;
}

/**
 * Selects the best AI model for a given task based on complexity,
 * budget constraints, and provider availability.
 */
export class ModelRouter {
  constructor(
    private providerRegistry: ProviderRegistry,
    private budgetManager: BudgetManager
  ) {}

  /**
   * Routes a task to the most appropriate provider and model.
   *
   * @param analysis - The analyzed task information
   * @param preferredProvider - Optional ID of a preferred provider ('auto' = let router decide)
   * @returns A decision containing the chosen provider and model
   */
  public async route(
    analysis: TaskAnalysis,
    preferredProvider?: string,
    excludedProviders: ReadonlySet<string> = new Set(),
  ): Promise<RoutingDecision> {
    let targetTier = analysis.recommendedTier;
    let downgradeReason = '';

    // 1. Check budget — downgrade tier if budget is tight
    const budgetStatus = this.budgetManager.getBudgetStatus();

    if (budgetStatus.isExhausted) {
      // Only allow budget-tier (local/free) models
      targetTier = 'budget';
      downgradeReason = 'Budget exhausted. Using only free/local models.';
    } else if (budgetStatus.isCritical) {
      if (targetTier === 'premium') {
        targetTier = 'budget';
        downgradeReason = 'Budget critical. Downgraded from premium to budget.';
      } else if (targetTier === 'standard') {
        targetTier = 'budget';
        downgradeReason = 'Budget critical. Downgraded from standard to budget.';
      }
    } else if (budgetStatus.isWarning) {
      if (targetTier === 'premium') {
        targetTier = 'standard';
        downgradeReason = 'Budget low. Downgraded from premium to standard.';
      }
    }

    // 2. Try preferred provider first
    let selectedProviderId: string | undefined;
    let fallbackWasUsed = false;

    if (preferredProvider && preferredProvider !== 'auto' && !excludedProviders.has(preferredProvider)) {
      const provider = this.providerRegistry.getProvider(preferredProvider);
      if (provider && (await provider.isAvailable())) {
        const rateLimitStatus = provider.getRateLimitStatus();
        if (!rateLimitStatus.isLimited) {
          selectedProviderId = preferredProvider;
        }
      }
    }

    // 3. Fallback: walk the fallback order
    if (!selectedProviderId) {
      const config = this.getFallbackOrder();
      for (const providerId of config) {
        if (excludedProviders.has(providerId)) continue;
        const provider = this.providerRegistry.getProvider(providerId);
        if (provider && (await provider.isAvailable())) {
          const rateLimitStatus = provider.getRateLimitStatus();
          if (!rateLimitStatus.isLimited) {
            selectedProviderId = providerId;
            if (preferredProvider && preferredProvider !== 'auto') {
              fallbackWasUsed = true;
            }
            break;
          }
        }
      }
    }

    if (!selectedProviderId) {
      throw new Error(
        'No AI providers available. All providers are either not configured, ' +
        'unavailable, or rate-limited. Please configure at least one provider.'
      );
    }

    const provider = this.providerRegistry.getProvider(selectedProviderId)!;

    // 4. Select best model for the target tier
    const modelInfo = this.selectModelForTier(provider, targetTier);
    if (!modelInfo) {
      // Fallback to first available model
      const anyModel = provider.models[0];
      if (!anyModel) {
        throw new Error(`Provider "${selectedProviderId}" has no available models.`);
      }
      return {
        provider: selectedProviderId,
        model: anyModel.id,
        reason: `No ${targetTier}-tier model available. Using ${anyModel.name}. ${downgradeReason}`.trim(),
        wasFallback: true,
      };
    }

    return {
      provider: selectedProviderId,
      model: modelInfo.id,
      reason: `Selected ${modelInfo.name} (${targetTier} tier). ${downgradeReason}`.trim(),
      wasFallback: fallbackWasUsed || downgradeReason !== '',
      originalModel: downgradeReason ? undefined : undefined,
    };
  }

  /**
   * Selects the most appropriate model for a given tier within a provider.
   * Uses keyword matching against model IDs to determine tier membership.
   */
  public selectModelForTier(provider: AIProvider, tier: string): ModelInfo | null {
    const models = provider.models;

    // Match models by their declared tier first
    const exactMatch = models.find((m) => m.tier === tier);
    if (exactMatch) {
      return exactMatch;
    }

    // Keyword-based fallback matching
    const tierKeywords: Record<string, string[]> = {
      budget: ['mini', 'flash', 'llama', 'haiku', 'lite'],
      standard: ['gpt-4o', 'sonnet', 'gemini-pro', 'mistral'],
      premium: ['opus', 'o3', 'o1', 'gemini-2.5-pro', 'gpt-4-turbo'],
    };

    const keywords = tierKeywords[tier] || [];
    for (const model of models) {
      const idLower = model.id.toLowerCase();
      for (const kw of keywords) {
        if (idLower.includes(kw)) {
          return model;
        }
      }
    }

    // If nothing matches, return first model available
    return models.length > 0 ? models[0] : null;
  }

  /**
   * Gets the configured fallback order from VSCode settings.
   */
  private getFallbackOrder(): string[] {
    const config = vscode.workspace.getConfiguration('ai-orchestra.routing');
    return config.get('fallbackOrder', ['vscode-lm', 'codex-cli', 'claude-code', 'antigravity-cli', 'openai', 'anthropic', 'gemini', 'ollama']) as string[];
  }
}
