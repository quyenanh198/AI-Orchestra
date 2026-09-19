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
import { DelegationSupervisor } from './orchestrator/delegation-supervisor';
import { ConversationContext } from './context/conversation-context';
import { LimitTracker } from './orchestrator/limit-tracker';
import { agentViews, describeLimit } from './ui/agent-view';
import { ToolRuntime } from './tools/tool-runtime';
import { CredentialBroker } from './security/credential-broker';
import { GoogleOAuthManager } from './security/google-oauth';
import { GeminiProvider } from './providers/gemini-provider';
import { ModelPermissionManager } from './security/model-permissions';
import { BillingPolicy } from './security/billing-policy';
import { CliAgentProvider } from './providers/cli-agent-provider';

const flushOnDeactivate: Array<() => Promise<void>> = [];

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
    const billingPolicy = new BillingPolicy();
    const modelRouter = new ModelRouter(registry, budgetManager, billingPolicy);
    const modelPermissions = new ModelPermissionManager(context.workspaceState, registry);
    const credentialBroker = new CredentialBroker(registry, modelPermissions, billingPolicy);
    const orchestrator = new Orchestrator(budgetManager, taskAnalyzer, modelRouter, credentialBroker);
    context.subscriptions.push(orchestrator);
    // Workspace-scoped: tasks carry write/execute-capable work for *this* folder; a shared global store let
    // another window/workspace "recover" (re-run) them against the wrong workspace root.
    const taskStore = new TaskStore(context.workspaceState);
    void taskStore.failInterrupted().then(count => {
        if (count) outputChannel.appendLine(`Marked ${count} task(s) from a previous session as interrupted.`);
    });
    const toolRuntime = new ToolRuntime();
    const settingsOf = (section: string) => vscode.workspace.getConfiguration(`ai-orchestra.${section}`);
    // Getters, so changing a setting takes effect without reloading the window.
    const sharedContext = new ConversationContext(context.workspaceState, {
        get recentTurns() { return settingsOf('context').get('recentTurns', 8); },
        digestLineChars: 160, maxDigestLines: 60, maxNotes: 40,
        estimate: text => tokenEstimator.estimateTokens(text),
    });
    // Limits belong to the user's accounts, not to a folder, so they live in global state.
    const limitTracker = new LimitTracker(context.globalState, () => vscode.workspace.getConfiguration('ai-orchestra').get('limits', {}));
    flushOnDeactivate.push(() => usageTracker.flush(), () => taskStore.flush(), () => sharedContext.flush(), () => limitTracker.flush());
    // Forward-declared: the sidebar and output channel are used by the event callback only after activation finishes.
    const delegation = new DelegationSupervisor({
        orchestrator,
        providers: () => registry.getAllProviders(),
        isCredit: id => billingPolicy.isCreditProvider(id),
        creditAllowed: () => billingPolicy.getMode() === 'creditWithConfirmation',
        isPermitted: (agentId, providerId, modelId) => modelPermissions.isAllowed(agentId, providerId, modelId),
        fallbackOrder: () => vscode.workspace.getConfiguration('ai-orchestra.routing').get<string[]>('fallbackOrder', []),
        limits: limitTracker,
        context: sharedContext,
        store: taskStore,
        tools: toolRuntime,
        analyze: messages => taskAnalyzer.analyze(messages),
        settings: () => ({
            maxToolTurns: settingsOf('agents').get('maxToolTurns', 4),
            contextTokens: settingsOf('context').get('maxTokens', 12000),
            maxTaskTokens: budgetManager.getTaskPolicy().maxTaskTokens,
        }),
        emit: event => {
            outputChannel.appendLine(`[${event.state}] goal=${event.goalId} agent=${event.agentId || '-'} ${event.detail || ''}`);
            sidebarProvider.updateTasks(taskStore.getTasks(event.goalId));
        },
    });

    // 4. Initialize UI
    const statusBarManager = new StatusBarManager();
    context.subscriptions.push(statusBarManager);

    const initialStatus = budgetManager.getBudgetStatus();
    statusBarManager.updateUsage(initialStatus.tokenBudget.used, initialStatus.tokenBudget.limit);
    statusBarManager.updateBudgetWarning(initialStatus.tokenBudget.percentage * 100);

    // Sidebar
    const sidebarProvider = new SidebarProvider();
    sidebarProvider.updatePermissionMode(modelPermissions.getMode());
    sidebarProvider.updateBillingMode(billingPolicy.getMode());
    const updateSidebarUsage = (): void => sidebarProvider.updateUsage(
        usageTracker.getSessionSummary(), usageTracker.getDailySummary(), budgetManager.getBudgetStatus()
    );
    updateSidebarUsage();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('ai-orchestra.providers', sidebarProvider),
        vscode.window.registerTreeDataProvider('ai-orchestra.usage', sidebarProvider)
    );

    // Chat panel wired to orchestrator
    let running: AbortController | undefined;
    const refreshAgents = async (): Promise<void> => {
        const view = await agentViews(delegation);
        chatPanelProvider.postMessage('agentsUpdated', view);
        sidebarProvider.updateAgents(view.agents);
    };
    const chatPanelProvider: ChatPanelProvider = new ChatPanelProvider(context.extensionUri, async (message) => {
        if (message.type === 'sendMessage') {
            // Never log prompt text: users paste secrets, and the output channel is easy to share.
            outputChannel.appendLine(`User message received (${String(message.text).length} chars).`);
            if (running) {
                chatPanelProvider.postMessage('error', { message: 'The supervisor is still working on the previous prompt. Wait for it or press Stop.' });
                return;
            }
            running = new AbortController();
            try {
                const outcome = await delegation.handle(String(message.text), { signal: running.signal });
                const { result, decision } = outcome;
                chatPanelProvider.postMessage('appendChunk', { chunk: result.response.content });
                chatPanelProvider.postMessage('messageComplete', {
                    content: result.response.content,
                    model: result.response.model,
                    agent: decision.agentName,
                    reason: outcome.attempts > 1 ? `${decision.reason} (after ${outcome.attempts - 1} agent(s) failed)` : decision.reason,
                    limit: describeLimit(decision.limit),
                    tokens: result.response.usage.totalTokens,
                    cost: result.response.usage.estimatedCost.toFixed(4)
                });
                const status = budgetManager.getBudgetStatus();
                statusBarManager.updateModel(decision.agentName);
                statusBarManager.updateUsage(status.tokenBudget.used, status.tokenBudget.limit);
                statusBarManager.updateBudgetWarning(status.tokenBudget.percentage * 100);
                statusBarManager.showCostTooltip(result.response.usage.estimatedCost);
                updateSidebarUsage();
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                chatPanelProvider.postMessage('error', { message: errMsg });
                outputChannel.appendLine(`Error: ${errMsg}`);
            } finally {
                running = undefined;
                void refreshAgents();
            }
        } else if (message.type === 'cancel') {
            running?.abort();
        } else if (message.type === 'clearChat') {
            await sharedContext.clear();
        } else if (message.type === 'pinAgent') {
            delegation.setPinned(message.agent ? String(message.agent) : undefined);
            statusBarManager.updateModel(message.agent ? String(message.agent) : 'Auto (supervisor)');
            outputChannel.appendLine(`Executor agent ${message.agent ? `pinned to ${message.agent}` : 'set to Auto'}.`);
        } else if (message.type === 'ready') {
            void refreshAgents();
        }
    });

    context.subscriptions.push(
        // Goals run for minutes; without this the answer is dropped if the user switches sidebar views meanwhile.
        vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewType, chatPanelProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    // 5. Register commands
    const cmds = registerCommands(
        context, registry, budgetManager,
        chatPanelProvider, sidebarProvider, statusBarManager, googleOAuth, modelPermissions, billingPolicy, delegation, refreshAgents
    );
    context.subscriptions.push(...cmds);
    context.subscriptions.push(usageTracker.onUsageUpdated(() => updateSidebarUsage()));

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
    void loadProviderKeys(context.secrets, context.globalState, registry, sidebarProvider, outputChannel, googleOAuth)
        .then(() => refreshAgents());

    outputChannel.appendLine('AI Orchestra extension activated successfully.');
}

async function loadProviderKeys(
    secrets: vscode.SecretStorage,
    state: vscode.Memento,
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
    for (const id of ['codex-cli', 'claude-code', 'antigravity-cli', 'grok-cli']) {
        const provider = registry.getProvider(id) as CliAgentProvider | undefined;
        if (state.get<number>(`ai-orchestra.authVerified.${id}`)) sidebar.updateProviderStatus(id, 'Previously authenticated · checking…');
        const status = provider ? await provider.checkStatus() : { installed: false, authenticated: false };
        const available = status.authenticated;
        await state.update(`ai-orchestra.authVerified.${id}`, available ? Date.now() : undefined);
        sidebar.updateProviderStatus(id, provider?.formatStatus(status) || 'Unavailable');
        output.appendLine(`${id}: ${provider?.formatStatus(status) || 'unavailable'}${status.executable ? ` (${status.executable})` : ''}.`);
    }
}

export async function deactivate(): Promise<void> {
    await Promise.allSettled(flushOnDeactivate.map(flush => flush()));
}
