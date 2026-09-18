import * as vscode from 'vscode';

export interface BudgetConfig {
    maxSessionBudget: number;
    maxDailyBudget: number;
    warningThresholdPercentage: number;
}

export interface ProviderConfig {
    enabled: boolean;
    defaultModel: string;
}

export class Settings {
    public static getConfig(): BudgetConfig {
        const config = vscode.workspace.getConfiguration('ai-orchestra.budget');
        return {
            maxSessionBudget: config.get<number>('maxSessionBudget', 5.0),
            maxDailyBudget: config.get<number>('maxDailyBudget', 20.0),
            warningThresholdPercentage: config.get<number>('warningThresholdPercentage', 80)
        };
    }

    public static getProviderConfig(providerId: string): ProviderConfig {
        const config = vscode.workspace.getConfiguration(`ai-orchestra.providers.${providerId}`);
        return {
            enabled: config.get<boolean>('enabled', true),
            defaultModel: config.get<string>('defaultModel', '')
        };
    }

    public static onConfigChanged(callback: (e: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ai-orchestra')) {
                callback(e);
            }
        });
    }

    public static async updateSetting(key: string, value: any, target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-orchestra');
        await config.update(key, value, target);
    }
}
