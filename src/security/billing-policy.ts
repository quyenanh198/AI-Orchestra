import * as vscode from 'vscode';

export type BillingMode = 'subscriptionOnly' | 'creditWithConfirmation';

const CREDIT_PROVIDERS = new Set(['openai', 'anthropic', 'gemini']);

export class BillingPolicy {
  public getMode(): BillingMode {
    return vscode.workspace.getConfiguration('ai-orchestra.billing').get<BillingMode>('mode', 'subscriptionOnly');
  }

  public isCreditProvider(providerId: string): boolean { return CREDIT_PROVIDERS.has(providerId); }

  public async authorize(providerId: string, modelId: string, agentId: string): Promise<void> {
    if (!this.isCreditProvider(providerId)) return;
    if (this.getMode() === 'subscriptionOnly') {
      throw new Error(`Credit billing is disabled. ${providerId}/${modelId} requires switching Billing Mode to Credit with confirmation.`);
    }
    const approved = await vscode.window.showWarningMessage(
      `Credit charge confirmation: allow agent ${agentId} to call ${providerId}/${modelId} once? Provider charges may apply.`,
      { modal: true, detail: 'Approval applies only to this single provider request. The next request will ask again.' },
      'Approve this request',
    );
    if (approved !== 'Approve this request') throw new Error(`User declined credit usage for ${providerId}/${modelId}.`);
  }
}
