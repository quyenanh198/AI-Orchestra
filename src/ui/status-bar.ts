import * as vscode from 'vscode';

export class StatusBarManager implements vscode.Disposable {
    private modelItem: vscode.StatusBarItem;
    private usageItem: vscode.StatusBarItem;
    private budgetItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.modelItem.command = 'ai-orchestra.switchModel';
        this.disposables.push(this.modelItem);

        this.usageItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
        this.usageItem.command = 'ai-orchestra.showUsage';
        this.disposables.push(this.usageItem);

        this.budgetItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
        this.disposables.push(this.budgetItem);

        this.updateModel('Auto (supervisor)');
        this.updateUsage(0, 10000);
        
        this.modelItem.show();
        this.usageItem.show();
    }

    public updateModel(modelName: string): void {
        this.modelItem.text = `$(hubot) ${modelName}`;
        this.modelItem.tooltip = 'Executor agent. Click to pin an agent or return to Auto';
    }

    public updateUsage(used: number, limit: number): void {
        this.usageItem.text = `$(dashboard) ${used.toLocaleString()} / ${limit.toLocaleString()} tokens`;
        this.usageItem.tooltip = 'Click to view usage details';
    }

    public updateBudgetWarning(percentage: number): void {
        if (percentage > 95) {
            this.budgetItem.text = `$(warning) ${percentage.toFixed(1)}% budget used`;
            this.budgetItem.color = new vscode.ThemeColor('errorForeground');
            this.budgetItem.show();
        } else if (percentage > 80) {
            this.budgetItem.text = `$(warning) ${percentage.toFixed(1)}% budget used`;
            this.budgetItem.color = new vscode.ThemeColor('charts.orange');
            this.budgetItem.show();
        } else if (percentage > 60) {
            this.budgetItem.text = `$(info) ${percentage.toFixed(1)}% budget used`;
            this.budgetItem.color = new vscode.ThemeColor('charts.yellow');
            this.budgetItem.show();
        } else {
            this.budgetItem.hide();
        }
    }

    public showCostTooltip(cost: number): void {
        this.usageItem.tooltip = `Current Cost: $${cost.toFixed(4)}`;
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}
