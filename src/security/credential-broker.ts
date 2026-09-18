import { ProviderRegistry } from '../providers/provider-registry';
import { AIProvider } from '../providers/types';
import { ModelPermissionManager } from './model-permissions';
import { BillingPolicy } from './billing-policy';

/** Agents receive an invoker capability, never a raw provider credential. */
export class CredentialBroker {
  constructor(private readonly registry: ProviderRegistry, private readonly permissions: ModelPermissionManager, private readonly billing: BillingPolicy) {}

  public async getProviderForInvocation(agentId: string, providerId: string, modelId: string): Promise<AIProvider> {
    if (!agentId) throw new Error('Credential access requires an agent identity.');
    if (!this.permissions.isAllowed(agentId, providerId, modelId)) {
      throw new Error(`Model permission denied: ${agentId} cannot use ${providerId}/${modelId}. Configure AI Orchestra Model Permissions.`);
    }
    await this.billing.authorize(providerId, modelId, agentId);
    const provider = this.registry.getProvider(providerId);
    if (!provider) throw new Error(`Provider ${providerId} is unavailable.`);
    return provider;
  }
}
