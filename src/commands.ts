import * as vscode from 'vscode';
import { BudgetManager } from './budget/budget-manager';
import { ProviderRegistry } from './providers/provider-registry';
import { ChatPanelProvider } from './ui/chat-panel';
import { SidebarProvider } from './ui/sidebar-provider';
import { StatusBarManager } from './ui/status-bar';

export function registerCommands(
    context: vscode.ExtensionContext,
    registry: ProviderRegistry,
    budget: BudgetManager,
    chatPanelProvider: ChatPanelProvider,
    sidebarProvider: SidebarProvider,
    statusBarManager: StatusBarManager
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('ai-orchestra.openChat', () => vscode.commands.executeCommand('ai-orchestra.chatView.focus')),
        vscode.commands.registerCommand('ai-orchestra.configure', async () => {
            const providerId = await vscode.window.showQuickPick(['openai', 'anthropic', 'gemini', 'ollama'], { placeHolder: 'Select a provider' });
            if (!providerId) return;
            if (providerId === 'ollama') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-orchestra.ollama.endpoint');
                return;
            }
            const action = await vscode.window.showQuickPick(['Save API key', 'Remove API key'], { placeHolder: `${providerId}: authentication` });
            if (!action) return;
            const secretKey = `ai-orchestra.${providerId}.apiKey`;
            if (action === 'Remove API key') {
                await context.secrets.delete(secretKey);
                registry.getProvider(providerId)?.configure({ apiKey: undefined });
                sidebarProvider.updateProviderStatus(providerId, 'Not Configured');
                return;
            }
            const apiKey = await vscode.window.showInputBox({ prompt: `Enter API key for ${providerId}`, password: true, ignoreFocusOut: true });
            if (!apiKey) return;
            await context.secrets.store(secretKey, apiKey);
            registry.getProvider(providerId)?.configure({ apiKey });
            sidebarProvider.updateProviderStatus(providerId, 'Available');
            vscode.window.showInformationMessage(`${providerId} API key saved in VS Code SecretStorage.`);
        }),
        vscode.commands.registerCommand('ai-orchestra.showUsage', () => vscode.commands.executeCommand('ai-orchestra.usage.focus')),
        vscode.commands.registerCommand('ai-orchestra.switchModel', async () => {
            const choices = registry.getAllProviders().flatMap(provider => provider.models.map(model => ({ label: model.name, description: provider.name, model: model.id })));
            const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Select model for display; routing still enforces budget and availability' });
            if (selected) {
                statusBarManager.updateModel(selected.model);
                chatPanelProvider.postMessage('modelsUpdated', { models: [selected.model] });
            }
        }),
        vscode.commands.registerCommand('ai-orchestra.resetBudget', async () => {
            const confirm = await vscode.window.showWarningMessage('Reset session token usage? Daily cost usage is retained.', 'Yes', 'No');
            if (confirm !== 'Yes') return;
            budget.resetSession();
            const status = budget.getBudgetStatus();
            statusBarManager.updateUsage(status.tokenBudget.used, status.tokenBudget.limit);
            vscode.window.showInformationMessage('Session budget reset.');
        })
    ];
}
