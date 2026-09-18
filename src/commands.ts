import * as vscode from 'vscode';
import { BudgetManager } from './budget/budget-manager';
import { ProviderRegistry } from './providers/provider-registry';
import { ChatPanelProvider } from './ui/chat-panel';
import { SidebarProvider } from './ui/sidebar-provider';
import { StatusBarManager } from './ui/status-bar';
import { VSCodeLanguageModelProvider } from './providers/vscode-lm-provider';
import { GoogleOAuthManager } from './security/google-oauth';
import { GeminiProvider } from './providers/gemini-provider';
import { ModelPermissionManager, PermissionMode } from './security/model-permissions';
import { AgentRole } from './agents/types';
import { CliAgentProvider } from './providers/cli-agent-provider';
import { BillingMode, BillingPolicy } from './security/billing-policy';

export function registerCommands(
    context: vscode.ExtensionContext,
    registry: ProviderRegistry,
    budget: BudgetManager,
    chatPanelProvider: ChatPanelProvider,
    sidebarProvider: SidebarProvider,
    statusBarManager: StatusBarManager,
    googleOAuth: GoogleOAuthManager,
    modelPermissions: ModelPermissionManager,
    billingPolicy: BillingPolicy,
): vscode.Disposable[] {
    const refreshAccountProvider = async (providerId: string, notify = true): Promise<boolean> => {
        const provider = registry.getProvider(providerId);
        const available = Boolean(provider && await provider.isAvailable());
        sidebarProvider.updateProviderStatus(providerId, available ? 'Authenticated / Available' : 'Login / install CLI');
        if (notify) vscode.window.showInformationMessage(`${provider?.name || providerId}: ${available ? 'authenticated and available' : 'not authenticated or CLI not installed'}.`);
        return available;
    };
    const watchAccountLogin = (providerId: string): void => {
        let attempts = 0;
        const timer = setInterval(() => {
            void refreshAccountProvider(providerId, false).then(available => {
                attempts += 1;
                if (available || attempts >= 36) {
                    clearInterval(timer);
                    if (available) vscode.window.showInformationMessage(`${registry.getProvider(providerId)?.name}: login detected; models are now available.`);
                }
            });
        }, 5_000);
    };
    const recommendedExtensions = [
        { id: 'GitHub.copilot-chat', label: 'GitHub Copilot', description: 'Directly supplies account-backed VS Code language models to AI Orchestra' },
        { id: 'ms-windows-ai-studio.windows-ai-studio', label: 'Microsoft Foundry Toolkit', description: 'Discover, test and deploy local or hosted AI models and agents' },
        { id: 'Continue.continue', label: 'Continue', description: 'Open-source AI coding agent and model client' },
    ];
    return [
        vscode.commands.registerCommand('ai-orchestra.openChat', () => vscode.commands.executeCommand('ai-orchestra.chatView.focus')),
        vscode.commands.registerCommand('ai-orchestra.configure', async (requestedProvider?: string) => {
            const providerId = requestedProvider || await vscode.window.showQuickPick(['vscode-lm', 'codex-cli', 'claude-code', 'antigravity-cli', 'gemini', 'openai', 'anthropic', 'ollama'], { placeHolder: 'Select a provider' });
            if (!providerId) return;
            if (['codex-cli', 'claude-code', 'antigravity-cli'].includes(providerId)) {
                const provider = registry.getProvider(providerId) as CliAgentProvider;
                const cliActions = ['Login with account', 'Check authentication', 'Install official CLI', 'Logout'];
                const action = await vscode.window.showQuickPick(cliActions, { placeHolder: `${provider.name}: account authentication` });
                if (action === 'Login with account') { provider.openLoginTerminal(); watchAccountLogin(providerId); }
                if (action === 'Install official CLI') provider.openInstallTerminal();
                if (action === 'Logout') provider.openLogoutTerminal();
                if (action === 'Check authentication') await refreshAccountProvider(providerId);
                return;
            }
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
        vscode.commands.registerCommand('ai-orchestra.manageModelPermissions', async () => {
            const selectedMode = await vscode.window.showQuickPick([
                { label: 'Open', description: 'Every agent role may use every configured model', value: 'open' as PermissionMode },
                { label: 'Restricted', description: 'Deny model access unless explicitly assigned to the role', value: 'restricted' as PermissionMode },
            ], { placeHolder: `Model permission mode (current: ${modelPermissions.getMode()})` });
            if (!selectedMode) return;
            await modelPermissions.setMode(selectedMode.value);
            sidebarProvider.updatePermissionMode(selectedMode.value);
            if (selectedMode.value === 'open') {
                vscode.window.showInformationMessage('Model permissions set to Open.');
                return;
            }
            const selectedRole = await vscode.window.showQuickPick(
                ['supervisor', 'planner', 'coder', 'auditor', 'reviewer', 'tester'] as AgentRole[],
                { placeHolder: 'Select an agent role to configure' },
            );
            if (!selectedRole) return;
            const role = selectedRole as AgentRole;
            const current = new Set(modelPermissions.getAssignments(role));
            const chosen = await vscode.window.showQuickPick(
                modelPermissions.listModels().map(model => ({ ...model, picked: current.has(model.key) })),
                { canPickMany: true, placeHolder: `${role}: select allowed models (none means deny all)` },
            );
            if (!chosen) return;
            await modelPermissions.setAssignments(role, chosen.map(item => item.key));
            vscode.window.showInformationMessage(`${role}: ${chosen.length} model permission(s) saved for this workspace.`);
        }),
        vscode.commands.registerCommand('ai-orchestra.installRecommendations', async () => {
            const choices = recommendedExtensions.map(extension => ({
                ...extension,
                picked: extension.id === 'GitHub.copilot-chat',
                detail: vscode.extensions.getExtension(extension.id) ? 'Installed' : undefined,
            }));
            const selected = await vscode.window.showQuickPick(choices, {
                canPickMany: true,
                placeHolder: 'Select recommended AI extensions to install',
            });
            if (!selected?.length) return;
            let installed = 0;
            for (const extension of selected) {
                if (vscode.extensions.getExtension(extension.id)) continue;
                await vscode.commands.executeCommand('workbench.extensions.installExtension', extension.id);
                installed += 1;
            }
            vscode.window.showInformationMessage(installed
                ? `Installed ${installed} recommended extension(s). Reload VS Code if prompted.`
                : 'All selected extensions are already installed.');
        }),
        vscode.commands.registerCommand('ai-orchestra.manageBillingMode', async () => {
            const selected = await vscode.window.showQuickPick([
                { label: 'Subscription / Free only (Recommended)', description: 'Block providers that can consume API credits', value: 'subscriptionOnly' as BillingMode },
                { label: 'Credit with confirmation', description: 'Ask for explicit approval before every paid API request', value: 'creditWithConfirmation' as BillingMode },
            ], { placeHolder: `Billing mode (current: ${billingPolicy.getMode()})` });
            if (!selected) return;
            await vscode.workspace.getConfiguration('ai-orchestra.billing').update('mode', selected.value, vscode.ConfigurationTarget.Global);
            sidebarProvider.updateBillingMode(selected.value);
            vscode.window.showInformationMessage(selected.value === 'subscriptionOnly'
                ? 'AI Orchestra will use only subscription-backed or free/local providers.'
                : 'Credit providers enabled. Every individual request will require confirmation.');
        }),
        vscode.commands.registerCommand('ai-orchestra.showUsage', () => vscode.commands.executeCommand('ai-orchestra.usage.focus')),
        vscode.commands.registerCommand('ai-orchestra.switchModel', async () => {
            const providers = await registry.getAvailableProviders();
            const choices = providers.flatMap(provider => provider.models.map(model => ({ label: model.name, description: `${provider.name} · Available`, model: model.id })));
            if (!choices.length) { vscode.window.showWarningMessage('No authenticated or running AI provider is currently available. Login or configure a provider first.'); return; }
            const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Select an available model' });
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
