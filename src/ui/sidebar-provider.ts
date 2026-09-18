import * as vscode from 'vscode';
import { TaskRecord } from '../agents/types';
import { BudgetStatus } from '../budget/budget-manager';
import { UsageSummary } from '../budget/usage-tracker';
import { PermissionMode } from '../security/model-permissions';
import { BillingMode } from '../security/billing-policy';

export class SidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private providerStatuses: Map<string, string> = new Map();
    private tasks: TaskRecord[] = [];
    private session?: UsageSummary;
    private daily?: UsageSummary;
    private budget?: BudgetStatus;
    private permissionMode: PermissionMode = 'open';
    private billingMode: BillingMode = 'subscriptionOnly';

    constructor() {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    updateProviderStatus(providerId: string, status: string): void {
        this.providerStatuses.set(providerId, status);
        this.refresh();
    }

    updateTasks(tasks: TaskRecord[]): void {
        this.tasks = tasks;
        this.refresh();
    }

    updateUsage(session: UsageSummary, daily: UsageSummary, budget: BudgetStatus): void {
        this.session = session;
        this.daily = daily;
        this.budget = budget;
        this.refresh();
    }

    updatePermissionMode(mode: PermissionMode): void { this.permissionMode = mode; this.refresh(); }
    updateBillingMode(mode: BillingMode): void { this.billingMode = mode; this.refresh(); }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (!element) {
            // Root items
            const providersRoot = new vscode.TreeItem('Providers', vscode.TreeItemCollapsibleState.Expanded);
            providersRoot.contextValue = 'providersRoot';
            
            const usageRoot = new vscode.TreeItem('Usage', vscode.TreeItemCollapsibleState.Expanded);
            usageRoot.contextValue = 'usageRoot';

            const agentsRoot = new vscode.TreeItem('Agent Tasks', vscode.TreeItemCollapsibleState.Expanded);
            agentsRoot.contextValue = 'agentsRoot';

            const permissions = new vscode.TreeItem('Model Permissions', vscode.TreeItemCollapsibleState.None);
            permissions.description = this.permissionMode === 'open' ? 'Open' : 'Restricted';
            permissions.iconPath = new vscode.ThemeIcon(this.permissionMode === 'open' ? 'unlock' : 'lock');
            permissions.command = { command: 'ai-orchestra.manageModelPermissions', title: 'Manage Model Permissions' };

            const recommendations = new vscode.TreeItem('Recommended Extensions', vscode.TreeItemCollapsibleState.None);
            recommendations.description = 'Add AI integrations';
            recommendations.iconPath = new vscode.ThemeIcon('extensions');
            recommendations.command = { command: 'ai-orchestra.installRecommendations', title: 'Install Recommended Extensions' };

            const billing = new vscode.TreeItem('Billing Mode', vscode.TreeItemCollapsibleState.None);
            billing.description = this.billingMode === 'subscriptionOnly' ? 'Subscription / Free only' : 'Credit: confirm every request';
            billing.iconPath = new vscode.ThemeIcon(this.billingMode === 'subscriptionOnly' ? 'shield' : 'warning');
            billing.command = { command: 'ai-orchestra.manageBillingMode', title: 'Manage Billing Mode' };

            return Promise.resolve([providersRoot, billing, permissions, recommendations, agentsRoot, usageRoot]);
        }

        if (element.label === 'Providers') {
            const providers = [
                { id: 'vscode-lm', label: 'GitHub Copilot / VS Code' },
                { id: 'codex-cli', label: 'OpenAI Codex / ChatGPT Account' },
                { id: 'claude-code', label: 'Claude Code / Claude Account' },
                { id: 'antigravity-cli', label: 'Google Antigravity / Google Account' },
                { id: 'ollama', label: 'Ollama (Local)' }
            ];
            if (this.billingMode === 'creditWithConfirmation') providers.splice(4, 0,
                { id: 'openai', label: 'OpenAI API (Credit)' },
                { id: 'anthropic', label: 'Anthropic API (Credit)' },
                { id: 'gemini', label: 'Google Gemini API (Credit)' },
            );

            return Promise.resolve(providers.map(p => {
                const item = new vscode.TreeItem(p.label, vscode.TreeItemCollapsibleState.None);
                const status = this.providerStatuses.get(p.id) || 'Not configured';
                item.description = status;
                item.iconPath = new vscode.ThemeIcon(this.getIconForStatus(status));
                item.contextValue = 'provider';
                item.command = { command: 'ai-orchestra.configure', title: `Configure ${p.label}`, arguments: [p.id] };
                return item;
            }));
        }

        if (element.label === 'Usage') {
            const session = new vscode.TreeItem('Session Usage', vscode.TreeItemCollapsibleState.None);
            session.description = `${this.session?.totalTokens || 0} tokens / $${(this.session?.totalCost || 0).toFixed(4)}`;
            session.iconPath = new vscode.ThemeIcon('pulse');

            const daily = new vscode.TreeItem('Daily Usage', vscode.TreeItemCollapsibleState.None);
            daily.description = `${this.daily?.totalTokens || 0} tokens / $${(this.daily?.totalCost || 0).toFixed(4)}`;
            daily.iconPath = new vscode.ThemeIcon('calendar');

            const budget = new vscode.TreeItem('Budget Remaining', vscode.TreeItemCollapsibleState.None);
            const remaining = Math.max(0, (this.budget?.costBudget.limit || 0) - (this.budget?.costBudget.used || 0));
            const remainingPercent = Math.max(0, 100 - (this.budget?.costBudget.percentage || 0) * 100);
            budget.description = `${remainingPercent.toFixed(0)}% ($${remaining.toFixed(2)})`;
            budget.iconPath = new vscode.ThemeIcon('credit-card');

            return Promise.resolve([session, daily, budget]);
        }

        if (element.label === 'Agent Tasks') {
            return Promise.resolve(this.tasks.map(task => {
                const item = new vscode.TreeItem(task.description, vscode.TreeItemCollapsibleState.None);
                item.description = `${task.status} · ${task.primaryAgentId || 'unassigned'} · ${task.usedTokens}/${task.tokenBudget}`;
                item.tooltip = task.checkpoint?.summary || task.error || task.description;
                item.iconPath = new vscode.ThemeIcon(task.status === 'completed' ? 'pass' : task.status === 'failed' ? 'error' : task.status === 'handoff' ? 'sync' : 'loading~spin');
                return item;
            }));
        }

        return Promise.resolve([]);
    }

    private getIconForStatus(status: string): string {
        if (/Available|Authenticated|Signed in/i.test(status)) { return 'check'; }
        if (status === 'Not Configured' || status === 'Not configured') { return 'x'; }
        if (status === 'Rate limited') { return 'warning'; }
        if (status === 'Not Running') { return 'debug-disconnect'; }
        return 'circle-outline';
    }
}
