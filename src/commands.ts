import * as vscode from 'vscode';
import { BudgetManager } from './budget/budget-manager';
import { ProviderRegistry } from './providers/provider-registry';
import { ChatPanelProvider } from './ui/chat-panel';
import { SidebarProvider } from './ui/sidebar-provider';
import { StatusBarManager } from './ui/status-bar';
import { VSCodeLanguageModelProvider } from './providers/vscode-lm-provider';
import { GoogleOAuthManager } from './security/google-oauth';
import { GeminiProvider } from './providers/gemini-provider';

export function registerCommands(
    context: vscode.ExtensionContext,
    registry: ProviderRegistry,
    budget: BudgetManager,
    chatPanelProvider: ChatPanelProvider,
    sidebarProvider: SidebarProvider,
    statusBarManager: StatusBarManager,
    googleOAuth: GoogleOAuthManager,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('ai-orchestra.openChat', () => vscode.commands.executeCommand('ai-orchestra.chatView.focus')),
        vscode.commands.registerCommand('ai-orchestra.configure', async () => {
            const providerId = await vscode.window.showQuickPick(['vscode-lm', 'openai', 'anthropic', 'gemini', 'ollama'], { placeHolder: 'Select a provider' });
            if (!providerId) return;
            if (providerId === 'vscode-lm') {
                const provider = registry.getProvider(providerId) as VSCodeLanguageModelProvider;
                const account = await provider.signIn();
                sidebarProvider.updateProviderStatus(providerId, `Signed in: ${account}`);
                vscode.window.showInformationMessage(`AI Orchestra connected to VS Code models as ${account}.`);
                return;
            }
            if (providerId === 'ollama') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-orchestra.ollama.endpoint');
                return;
            }
            const actions = providerId === 'gemini'
                ? ['Sign in with Google OAuth', 'Sign out Google OAuth', 'Save API key', 'Remove API key']
                : ['Save API key', 'Remove API key'];
            const action = await vscode.window.showQuickPick(actions, { placeHolder: `${providerId}: authentication` });
            if (!action) return;
            if (providerId === 'gemini' && action === 'Sign in with Google OAuth') {
                const clientId = await vscode.window.showInputBox({ prompt: 'Google OAuth Desktop Client ID', ignoreFocusOut: true });
                const clientSecret = await vscode.window.showInputBox({ prompt: 'Google OAuth Desktop Client secret', password: true, ignoreFocusOut: true });
                const projectId = await vscode.window.showInputBox({ prompt: 'Google Cloud project ID used for Gemini billing/quota', ignoreFocusOut: true });
                if (!clientId || !clientSecret || !projectId) return;
                await googleOAuth.signIn(clientId, clientSecret, projectId);
                (registry.getProvider('gemini') as GeminiProvider).configureOAuth(googleOAuth);
                sidebarProvider.updateProviderStatus('gemini', 'Signed in with Google');
                vscode.window.showInformationMessage('Gemini OAuth login completed. Refresh token is stored in VS Code SecretStorage.');
                return;
            }
            if (providerId === 'gemini' && action === 'Sign out Google OAuth') {
                await googleOAuth.signOut();
                (registry.getProvider('gemini') as GeminiProvider).configureOAuth(undefined);
                const apiKey = await context.secrets.get('ai-orchestra.gemini.apiKey');
                sidebarProvider.updateProviderStatus('gemini', apiKey ? 'Available (API key)' : 'Not Configured');
                return;
            }
            const secretKey = `ai-orchestra.${providerId}.apiKey`;
            if (action === 'Remove API key') {
                await context.secrets.delete(secretKey);
                registry.getProvider(providerId)?.configure({ apiKey: undefined });
                sidebarProvider.updateProviderStatus(providerId, 'Not Configured');
                return;
            }
            const apiKey = await vscode.window.showInputBox({ prompt: `Enter API key for ${providerId}`, password: true, ignoreFocusOut: true });
            if (!apiKey) return;
            if (providerId === 'gemini') {
                await googleOAuth.signOut();
                (registry.getProvider('gemini') as GeminiProvider).configureOAuth(undefined);
            }
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
