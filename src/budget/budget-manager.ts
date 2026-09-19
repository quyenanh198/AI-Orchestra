import * as vscode from 'vscode';
import { UsageTracker } from './usage-tracker';
import { CostCalculator } from './cost-calculator';
import { TokenEstimator } from './token-estimator';
import * as crypto from 'node:crypto';

export interface BudgetCheckResult {
    allowed: boolean;
    reason?: string;
    suggestedModel?: string;
    remainingTokenBudget: number;
    remainingCostBudget: number;
    estimatedCost: number;
    budgetUtilization: number;
}

export interface BudgetStatus {
    tokenBudget: { used: number; limit: number; percentage: number };
    costBudget: { used: number; limit: number; percentage: number };
    isWarning: boolean;
    isCritical: boolean;
    isExhausted: boolean;
    recommendedTier: 'budget' | 'standard' | 'premium';
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

interface BudgetConfig {
    maxDailyCost: number;
    maxDailyTokens: number;
    maxSessionTokens: number;
    maxTaskTokens: number;
    warningThreshold: number; // 0-1
    criticalThreshold: number; // 0-1
}

export class BudgetManager implements vscode.Disposable {
    private config: BudgetConfig;
    private configDisposable: vscode.Disposable;
    private reservations = new Map<string, { tokens: number; cost: number }>();

    private _onBudgetWarning = new vscode.EventEmitter<BudgetStatus>();
    public readonly onBudgetWarning = this._onBudgetWarning.event;

    private _onBudgetCritical = new vscode.EventEmitter<BudgetStatus>();
    public readonly onBudgetCritical = this._onBudgetCritical.event;

    private _onBudgetExhausted = new vscode.EventEmitter<BudgetStatus>();
    public readonly onBudgetExhausted = this._onBudgetExhausted.event;

    constructor(
        private usageTracker: UsageTracker,
        private costCalculator: CostCalculator,
        private tokenEstimator: TokenEstimator
    ) {
        this.config = this.loadConfig();
        this.configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ai-orchestra.budget')) {
                this.config = this.loadConfig();
            }
        });
    }

    private loadConfig(): BudgetConfig {
        const config = vscode.workspace.getConfiguration('ai-orchestra.budget');
        return {
            maxDailyCost: config.get<number>('maxCostPerDay', 5.0),
            // Previously read `maxTokensPerSession`, so "Reset Session Budget" could never free any daily headroom.
            maxDailyTokens: config.get<number>('maxTokensPerDay', 500000),
            maxSessionTokens: config.get<number>('maxTokensPerSession', 100000),
            maxTaskTokens: config.get<number>('maxTokensPerTask', 32000),
            warningThreshold: config.get<number>('warningThreshold', 0.8), // 80%
            criticalThreshold: config.get<number>('criticalThreshold', 0.95) // 95%
        };
    }

    public canAfford(model: string, estimatedInputTokens: number, provider?: string): BudgetCheckResult {
        const estimatedOutputTokens = this.tokenEstimator.estimateResponseTokens(estimatedInputTokens);
        const estimatedCost = this.costCalculator.estimateRequestCost(model, estimatedInputTokens, estimatedOutputTokens, provider);
        const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;

        const dailySummary = this.usageTracker.getDailySummary();
        const sessionSummary = this.usageTracker.getSessionSummary();
        const reserved = this.reservedTotals();
        // A zero-cost request (local/subscription provider) must not be blocked by an already-spent dollar cap.
        const costUtilization = estimatedCost > 0
            ? (dailySummary.totalCost + reserved.cost + estimatedCost) / this.config.maxDailyCost
            : 0;
        const dailyTokenUtilization = (dailySummary.totalTokens + reserved.tokens + estimatedTotalTokens) / this.config.maxDailyTokens;
        const sessionTokenUtilization = (sessionSummary.totalTokens + reserved.tokens + estimatedTotalTokens) / this.config.maxSessionTokens;
        
        const utilization = Math.max(costUtilization, dailyTokenUtilization, sessionTokenUtilization);
        const remainingCost = Math.max(0, this.config.maxDailyCost - dailySummary.totalCost);
        const remainingTokens = Math.max(0, this.config.maxDailyTokens - dailySummary.totalTokens);

        let allowed = true;
        let reason: string | undefined;
        let suggestedModel: string | undefined;

        if (utilization > 1) {
            allowed = false;
            reason = costUtilization > 1 ? 'Daily cost budget exceeded'
                : sessionTokenUtilization > 1 ? 'Session token budget exceeded'
                : 'Daily token budget exceeded';
            suggestedModel = this.costCalculator.getCheaperAlternative(model) || undefined;
        } else if (utilization > this.config.criticalThreshold) {
            suggestedModel = this.costCalculator.getCheaperAlternative(model) || undefined;
        }

        return {
            allowed,
            reason,
            suggestedModel,
            remainingCostBudget: remainingCost,
            remainingTokenBudget: remainingTokens,
            estimatedCost,
            budgetUtilization: utilization
        };
    }

    public recordUsage(model: string, usage: TokenUsage, provider: string = 'openai'): void {
        const cost = this.costCalculator.calculateRequestCost(model, usage.inputTokens, usage.outputTokens, provider);
        
        this.usageTracker.record({
            provider,
            model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            cost
        });

        this.checkThresholds();
    }

    public reserveRequest(model: string, estimatedInputTokens: number, maxOutputTokens: number, provider?: string): { id?: string; allowed: boolean; reason?: string } {
        const check = this.canAfford(model, estimatedInputTokens, provider);
        const estimatedCost = this.costCalculator.estimateRequestCost(model, estimatedInputTokens, maxOutputTokens, provider);
        const estimatedTokens = estimatedInputTokens + maxOutputTokens;
        const daily = this.usageTracker.getDailySummary();
        const session = this.usageTracker.getSessionSummary();
        const reserved = this.reservedTotals();
        const allowed = check.allowed
            && (estimatedCost === 0 || daily.totalCost + reserved.cost + estimatedCost <= this.config.maxDailyCost)
            && daily.totalTokens + reserved.tokens + estimatedTokens <= this.config.maxDailyTokens
            && session.totalTokens + reserved.tokens + estimatedTokens <= this.config.maxSessionTokens;
        if (!allowed) return { allowed: false, reason: check.reason || 'Insufficient unreserved budget' };
        const id = crypto.randomUUID();
        this.reservations.set(id, { tokens: estimatedTokens, cost: estimatedCost });
        return { id, allowed: true };
    }

    public commitReservation(id: string, model: string, usage: TokenUsage, provider: string): void {
        this.reservations.delete(id);
        this.recordUsage(model, usage, provider);
    }

    public releaseReservation(id?: string): void {
        if (id) this.reservations.delete(id);
    }

    private reservedTotals(): { tokens: number; cost: number } {
        let tokens = 0; let cost = 0;
        for (const reservation of this.reservations.values()) { tokens += reservation.tokens; cost += reservation.cost; }
        return { tokens, cost };
    }

    public getBudgetStatus(): BudgetStatus {
        const dailySummary = this.usageTracker.getDailySummary();
        const costPercentage = dailySummary.totalCost / this.config.maxDailyCost;
        const tokenPercentage = dailySummary.totalTokens / this.config.maxDailyTokens;
        const maxPercentage = Math.max(costPercentage, tokenPercentage);

        let recommendedTier: 'budget' | 'standard' | 'premium' = 'premium';
        if (maxPercentage > this.config.criticalThreshold) {
            recommendedTier = 'budget';
        } else if (maxPercentage > this.config.warningThreshold) {
            recommendedTier = 'standard';
        }

        return {
            tokenBudget: { used: dailySummary.totalTokens, limit: this.config.maxDailyTokens, percentage: tokenPercentage },
            costBudget: { used: dailySummary.totalCost, limit: this.config.maxDailyCost, percentage: costPercentage },
            isWarning: maxPercentage >= this.config.warningThreshold && maxPercentage < this.config.criticalThreshold,
            isCritical: maxPercentage >= this.config.criticalThreshold && maxPercentage < 1.0,
            isExhausted: maxPercentage >= 1.0,
            recommendedTier
        };
    }

    public getRecommendedModel(preferredModel: string): string {
        const status = this.getBudgetStatus();
        if (status.isExhausted || status.isCritical) {
            const alternative = this.costCalculator.getCheaperAlternative(preferredModel);
            return alternative || preferredModel;
        }
        return preferredModel;
    }

    public resetSession(): void {
        this.usageTracker.resetSession();
    }

    /** Token ceiling for one delegated request (all tool turns of the single executor agent). */
    public getTaskPolicy(): { maxTaskTokens: number } {
        return { maxTaskTokens: this.config.maxTaskTokens };
    }

    private checkThresholds(): void {
        const status = this.getBudgetStatus();
        if (status.isExhausted) {
            this._onBudgetExhausted.fire(status);
        } else if (status.isCritical) {
            this._onBudgetCritical.fire(status);
        } else if (status.isWarning) {
            this._onBudgetWarning.fire(status);
        }
    }

    public dispose(): void {
        this.configDisposable.dispose();
        this._onBudgetWarning.dispose();
        this._onBudgetCritical.dispose();
        this._onBudgetExhausted.dispose();
    }
}
