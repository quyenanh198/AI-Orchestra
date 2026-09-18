import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const read = (path: string) => readFile(join(process.cwd(), path), 'utf8');

test('budget manager reads the exact settings contributed by the manifest', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const source = await read('src/budget/budget-manager.ts');
  const properties = manifest.contributes.configuration.properties;
  assert.ok(properties['ai-orchestra.budget.maxTokensPerSession']);
  assert.ok(properties['ai-orchestra.budget.maxCostPerDay']);
  assert.match(source, /getConfiguration\('ai-orchestra\.budget'\)/);
  assert.match(source, /get<number>\('maxTokensPerSession'/);
  assert.match(source, /get<number>\('maxCostPerDay'/);
});

test('supervisor persists leases, checkpoints, backups, and handoff state', async () => {
  const types = await read('src/agents/types.ts');
  const store = await read('src/orchestrator/task-store.ts');
  const supervisor = await read('src/orchestrator/multi-agent-supervisor.ts');
  for (const field of ['backupAgentIds', 'leaseExpiresAt', 'heartbeatAt', 'checkpoint', 'handoffThreshold']) assert.match(types, new RegExp(field));
  assert.match(store, /leaseTask/);
  assert.match(store, /getExpiredLeases/);
  assert.match(supervisor, /recoverExpiredLeases/);
  assert.match(supervisor, /state: 'handoff'/);
});

test('agents receive provider invocation and tool capabilities without raw API keys', async () => {
  const broker = await read('src/security/credential-broker.ts');
  const tools = await read('src/tools/tool-runtime.ts');
  assert.doesNotMatch(broker, /SecretStorage|apiKey/);
  assert.match(tools, /workspace\.write/);
  assert.match(tools, /allowWorkspaceWrite/);
  assert.match(tools, /terminal\.execute/);
  assert.match(tools, /ALLOWED_COMMANDS/);
});

test('runtime provider failures trigger another routing decision', async () => {
  const orchestrator = await read('src/orchestrator/orchestrator.ts');
  assert.match(orchestrator, /excluded\.add\(routingDecision\.provider\)/);
  assert.match(orchestrator, /Runtime fallback/);
  assert.match(orchestrator, /All providers failed/);
});

test('account login keeps refresh credentials in SecretStorage', async () => {
  const google = await read('src/security/google-oauth.ts');
  const vscodeProvider = await read('src/providers/vscode-lm-provider.ts');
  assert.match(google, /SecretStorage/);
  assert.match(google, /refreshToken/);
  assert.match(google, /expectedState/);
  assert.doesNotMatch(google, /writeFile|globalState\.update/);
  assert.match(vscodeProvider, /authentication\.getSession\('github'/);
  assert.match(vscodeProvider, /lm\.selectChatModels/);
});

test('restricted mode enforces per-role model assignments at invocation time', async () => {
  const permissions = await read('src/security/model-permissions.ts');
  const broker = await read('src/security/credential-broker.ts');
  assert.match(permissions, /mode === 'open'/);
  assert.match(permissions, /assignments\[role\]/);
  assert.match(permissions, /providerId.*modelId/);
  assert.match(broker, /permissions\.isAllowed/);
  assert.match(broker, /Model permission denied/);
});

test('account-backed CLI providers invoke official CLIs without reading their tokens', async () => {
  const cli = await read('src/providers/cli-agent-provider.ts');
  const registry = await read('src/providers/provider-registry.ts');
  const manifest = await read('package.json');
  assert.match(cli, /codex.*login.*status/s);
  assert.match(cli, /claude.*auth.*status/s);
  assert.match(cli, /antigravity.*agy/s);
  assert.match(cli, /antigravity\.google\/cli\/install\.ps1/);
  assert.match(cli, /npm.*prefix.*-g/s);
  assert.match(cli, /LOCALAPPDATA/);
  assert.match(cli, /exe\|cmd\|bat/);
  assert.match(cli, /checkStatus/);
  assert.match(cli, /subscriptionType/);
  assert.match(cli, /--version/);
  assert.match(cli, /sandbox', 'read-only/);
  assert.match(cli, /permission-mode', 'plan/);
  assert.match(cli, /npm install -g/);
  assert.match(cli, /prefix: \['--yes', this\.packageName\(\)\]/);
  assert.match(registry, /CliAgentProvider\('antigravity'\)/);
  assert.match(manifest, /antigravity-cli/);
  assert.doesNotMatch(manifest, /gemini-cli/);
  assert.doesNotMatch(cli, /\.codex|\.claude|credentials\.json|oauth_creds/);
});

test('verified CLI login status is restored and revalidated on extension activation', async () => {
  const extension = await read('src/extension.ts');
  const commands = await read('src/commands.ts');
  assert.match(extension, /Previously authenticated.*checking/);
  assert.match(extension, /authVerified\.\$\{id\}/);
  assert.match(extension, /await provider\.checkStatus\(\)/);
  assert.match(commands, /globalState\.update\(`ai-orchestra\.authVerified/);
});

test('credit providers are blocked by default and require one-request confirmation', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const billing = await read('src/security/billing-policy.ts');
  const setting = manifest.contributes.configuration.properties['ai-orchestra.billing.mode'];
  assert.equal(setting.default, 'subscriptionOnly');
  assert.match(billing, /CREDIT_PROVIDERS.*openai.*anthropic.*gemini/s);
  assert.match(billing, /modal: true/);
  assert.match(billing, /Approval applies only to this single provider request/);
  assert.doesNotMatch(billing, /approvedProviders|approvedSession|cache/);
});

test('credit providers stay hidden and unroutable until credit mode is selected', async () => {
  const sidebar = await read('src/ui/sidebar-provider.ts');
  const commands = await read('src/commands.ts');
  const router = await read('src/orchestrator/model-router.ts');
  assert.match(sidebar, /billingMode === 'creditWithConfirmation'.*OpenAI API \(Credit\)/s);
  assert.match(commands, /visibleProviders.*creditWithConfirmation/s);
  assert.match(commands, /getAvailableProviders.*isCreditProvider/s);
  assert.match(router, /isCreditProvider\(providerId\).*subscriptionOnly/);
});
