import * as vscode from 'vscode';
import { ProviderRegistry } from './providers/provider-registry';
import { CostCalculator } from './budget/cost-calculator';
import { TokenEstimator } from './budget/token-estimator';
import { UsageTracker } from './budget/usage-tracker';
import { BudgetManager } from './budget/budget-manager';
import { TaskAnalyzer } from './orchestrator/task-analyzer';
import { ModelRouter } from './orchestrator/model-router';
import { Orchestrator } from './orchestrator/orchestrator';
import { StatusBarManager } from './ui/status-bar';
import { ChatPanelProvider } from './ui/chat-panel';
import { SidebarProvider } from './ui/sidebar-provider';
import { Settings } from './config/settings';
import { registerCommands } from './commands';
import { TaskStore } from './orchestrator/task-store';
import { MultiAgentSupervisor } from './orchestrator/multi-agent-supervisor';
import { ToolRuntime } from './tools/tool-runtime';
import { CredentialBroker } from './security/credential-broker';
import { GoogleOAuthManager } from './security/google-oauth';
import { GeminiProvider } from './providers/gemini-provider';
import { ModelPermissionManager } from './security/model-permissions';

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('AI Orchestra');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('Activating AI Orchestra extension...');

    // 1. Initialize providers
    const registry = ProviderRegistry.getInstance();
    registry.initialize();
    const googleOAuth = new GoogleOAuthManager(context.secrets);

    // 2. Initialize budget system
    const costCalculator = new CostCalculator();
    const tokenEstimator = new TokenEstimator();
    const usageTracker = new UsageTracker(context.globalState);
    const budgetManager = new BudgetManager(usageTracker, costCalculator, tokenEstimator);
    context.subscriptions.push(budgetManager);

    // 3. Initialize orchestrator system
    const taskAnalyzer = new TaskAnalyzer();
    const modelRouter = new ModelRouter(registry, budgetManager);
    const modelPermissions = new ModelPermissionManager(context.workspaceState, registry);
    const credentialBroker = new CredentialBroker(registry, modelPermissions);
    const orchestrator = new Orchestrator(budgetManager, taskAnalyzer, modelRouter, credentialBroker);
    context.subscriptions.push(orchestrator);
    const taskStore = new TaskStore(context.globalState);
    const toolRuntime = new ToolRuntime();
    const supervisor = new MultiAgentSupervisor(orchestrator, taskStore, budgetManager, toolRuntime);
    context.subscriptions.push(supervisor);

    // 4. Initialize UI
    const statusBarManager = new StatusBarManager();
    context.subscriptions.push(statusBarManager);

    const initialStatus = budgetManager.getBudgetStatus();
    statusBarManager.updateUsage(initialStatus.tokenBudget.used, initialStatus.tokenBudget.limit);
    statusBarManager.updateBudgetWarning(initialStatus.tokenBudget.percentage * 100);

    // Sidebar
    const sidebarProvider = new SidebarProvider();
    sidebarProvider.updatePermissionMode(modelPermissions.getMode());
    const updateSidebarUsage = (): void => sidebarProvider.updateUsage(
        usageTracker.getSessionSummary(), usageTracker.getDailySummary(), budgetManager.getBudgetStatus()
    );
    updateSidebarUsage();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('ai-orchestra.providers', sidebarProvider),
        vscode.window.registerTreeDataProvider('ai-orchestra.usage', sidebarProvider)
    );

    // Chat panel wired to orchestrator
    const chatPanelProvider = new ChatPanelProvider(context.extensionUri, async (message) => {
        if (message.type === 'sendMessage') {
            outputChannel.appendLine(`User: ${String(message.text).substring(0, 100)}`);
            try {
                const result = await supervisor.executeGoal(String(message.text));

                // Send content as a chunk so it displays in the chat
                chatPanelProvider.postMessage('appendChunk', {
                    chunk: result.response.content
                });

                // Then send completion metadata
                chatPanelProvider.postMessage('messageComplete', {
                    content: result.response.content,
                    model: result.response.model,
                    provider: result.response.provider,
                    tokens: result.response.usage.totalTokens,
                    cost: result.response.usage.estimatedCost.toFixed(4)
                });

                // Update UI
                const status = budgetManager.getBudgetStatus();
                statusBarManager.updateModel(result.response.model);
                statusBarManager.updateUsage(status.tokenBudget.used, status.tokenBudget.limit);
                statusBarManager.updateBudgetWarning(status.tokenBudget.percentage * 100);
                statusBarManager.showCostTooltip(result.response.usage.estimatedCost);
                updateSidebarUsage();
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                chatPanelProvider.postMessage('error', { message: errMsg });
                outputChannel.appendLine(`Error: ${errMsg}`);
            }
        } else if (message.type === 'switchModel') {
            statusBarManager.updateModel(String(message.model));
            outputChannel.appendLine(`Model switched to: ${message.model}`);
        }
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewType, chatPanelProvider)
    );

    // 5. Register commands
    const cmds = registerCommands(
        context, registry, budgetManager,
        chatPanelProvider, sidebarProvider, statusBarManager, googleOAuth, modelPermissions
    );
    context.subscriptions.push(...cmds);
    context.subscriptions.push(supervisor.onEvent(event => {
        outputChannel.appendLine(`[${event.state}] goal=${event.goalId} task=${event.taskId || '-'} agent=${event.agentId || '-'} ${event.detail || ''}`);
        sidebarProvider.updateTasks(supervisor.getTasks(event.goalId));
    }));
    context.subscriptions.push(usageTracker.onUsageUpdated(() => updateSidebarUsage()));
    const recoveryTimer = setInterval(() => void supervisor.recoverExpiredLeases(), 15_000);
    context.subscriptions.push({ dispose: () => clearInterval(recoveryTimer) });

    // 6. Wire up budget events
    context.subscriptions.push(
        budgetManager.onBudgetWarning((status) => {
            statusBarManager.updateBudgetWarning(status.tokenBudget.percentage * 100);
            vscode.window.showWarningMessage(
                `AI Orchestra: Budget at ${Math.round(status.tokenBudget.percentage * 100)}%. Consider switching to a cheaper model.`
            );
        }),
        budgetManager.onBudgetCritical((status) => {
            statusBarManager.updateBudgetWarning(status.tokenBudget.percentage * 100);
            vscode.window.showWarningMessage(
                `AI Orchestra: Budget critical at ${Math.round(status.tokenBudget.percentage * 100)}%! Auto-downgrading to budget models.`
            );
        }),
        budgetManager.onBudgetExhausted(() => {
            statusBarManager.updateBudgetWarning(100);
            vscode.window.showErrorMessage(
                'AI Orchestra: Daily budget exhausted! Reset budget or wait until tomorrow.'
            );
        })
    );

    // 7. Wire configuration changes
    context.subscriptions.push(
        Settings.onConfigChanged((e) => {
            if (e.affectsConfiguration('ai-orchestra')) {
                outputChannel.appendLine('Configuration changed, reloading...');
                sidebarProvider.refresh();
            }
        })
    );

    // 8. Load API keys
    void loadProviderKeys(context.secrets, registry, sidebarProvider, outputChannel, googleOAuth);

    outputChannel.appendLine('AI Orchestra extension activated successfully.');
}

async function loadProviderKeys(
    secrets: vscode.SecretStorage,
    registry: ProviderRegistry,
    sidebar: SidebarProvider,
    output: vscode.OutputChannel,
    googleOAuth: GoogleOAuthManager,
): Promise<void> {
    for (const id of ['openai', 'anthropic', 'gemini']) {
        const key = await secrets.get(`ai-orchestra.${id}.apiKey`);
        if (key) {
            const provider = registry.getProvider(id);
            if (provider) {
                provider.configure({ apiKey: key });
                sidebar.updateProviderStatus(id, 'Available');
                output.appendLine(`${id} provider configured.`);
            }
        } else {
            sidebar.updateProviderStatus(id, 'Not Configured');
        }
    }
    if (await googleOAuth.isConfigured()) {
        (registry.getProvider('gemini') as GeminiProvider).configureOAuth(googleOAuth);
        sidebar.updateProviderStatus('gemini', 'Signed in with Google');
    }
    const ollama = registry.getProvider('ollama');
    if (ollama) {
        const endpoint = vscode.workspace.getConfiguration('ai-orchestra.ollama').get('endpoint', 'http://localhost:11434');
        ollama.configure({ endpoint });
        const available = await ollama.isAvailable();
        sidebar.updateProviderStatus('ollama', available ? 'Available' : 'Not Running');
    }
    const vscodeModels = registry.getProvider('vscode-lm');
    sidebar.updateProviderStatus('vscode-lm', vscodeModels && await vscodeModels.isAvailable() ? 'Available' : 'Sign in required');
}

export function deactivate(): void {}
