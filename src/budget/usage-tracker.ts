import * as vscode from 'vscode';

export interface UsageRecord {
    timestamp: number;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
}

export interface UsageSummary {
    totalTokens: number;
    totalCost: number;
    totalRequests: number;
    byProvider: Record<string, { tokens: number; cost: number; requests: number }>;
    byModel: Record<string, { tokens: number; cost: number; requests: number }>;
}

export class UsageTracker {
    private readonly sessionKey = 'ai-orchestra.usage.session';
    private readonly dailyKey = 'ai-orchestra.usage.daily';
    private readonly monthlyKey = 'ai-orchestra.usage.monthly';
    
    private sessionRecords: UsageRecord[] = [];
    private dailyRecords: UsageRecord[];
    private monthlyRecords: UsageRecord[];
    private persistQueue: Promise<void> = Promise.resolve();
    
    private _onUsageUpdated = new vscode.EventEmitter<UsageSummary>();
    public readonly onUsageUpdated = this._onUsageUpdated.event;

    constructor(private memento: vscode.Memento) {
        const now = new Date();
        const startOfDay = new Date().setHours(0, 0, 0, 0);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        this.dailyRecords = this.getRecords(this.dailyKey).filter(r => r.timestamp >= startOfDay);
        this.monthlyRecords = this.getRecords(this.monthlyKey).filter(r => r.timestamp >= startOfMonth);
        this.enqueuePersist();
    }

    public record(usage: Omit<UsageRecord, 'timestamp'>): void {
        const record: UsageRecord = {
            ...usage,
            timestamp: Date.now()
        };

        this.sessionRecords.push(record);
        
        // Update daily and monthly in memento
        this.dailyRecords.push(record);
        this.monthlyRecords.push(record);
        this.enqueuePersist();

        this._onUsageUpdated.fire(this.getSessionSummary());
    }

    public getSessionSummary(): UsageSummary {
        return this.summarize(this.sessionRecords);
    }

    public getDailySummary(): UsageSummary {
        const startOfDay = new Date().setHours(0, 0, 0, 0);
        const records = this.dailyRecords.filter(r => r.timestamp >= startOfDay);
        return this.summarize(records);
    }

    public getMonthlySummary(): UsageSummary {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const records = this.monthlyRecords.filter(r => r.timestamp >= startOfMonth);
        return this.summarize(records);
    }

    public resetSession(): void {
        this.sessionRecords = [];
        this._onUsageUpdated.fire(this.getSessionSummary());
    }

    public exportReport(): string {
        const report = {
            session: this.getSessionSummary(),
            daily: this.getDailySummary(),
            monthly: this.getMonthlySummary()
        };
        return JSON.stringify(report, null, 2);
    }

    private getRecords(key: string): UsageRecord[] {
        return this.memento.get<UsageRecord[]>(key, []);
    }

    private summarize(records: UsageRecord[]): UsageSummary {
        const summary: UsageSummary = {
            totalTokens: 0,
            totalCost: 0,
            totalRequests: records.length,
            byProvider: {},
            byModel: {}
        };

        for (const record of records) {
            summary.totalTokens += record.totalTokens;
            summary.totalCost += record.cost;

            if (!summary.byProvider[record.provider]) {
                summary.byProvider[record.provider] = { tokens: 0, cost: 0, requests: 0 };
            }
            summary.byProvider[record.provider].tokens += record.totalTokens;
            summary.byProvider[record.provider].cost += record.cost;
            summary.byProvider[record.provider].requests += 1;

            if (!summary.byModel[record.model]) {
                summary.byModel[record.model] = { tokens: 0, cost: 0, requests: 0 };
            }
            summary.byModel[record.model].tokens += record.totalTokens;
            summary.byModel[record.model].cost += record.cost;
            summary.byModel[record.model].requests += 1;
        }

        return summary;
    }

    public async flush(): Promise<void> {
        await this.persistQueue;
    }

    private enqueuePersist(): void {
        const daily = [...this.dailyRecords];
        const monthly = [...this.monthlyRecords];
        this.persistQueue = this.persistQueue.then(async () => {
            await this.memento.update(this.dailyKey, daily);
            await this.memento.update(this.monthlyKey, monthly);
        });
    }
}
