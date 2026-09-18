import { ProviderRegistry } from '../providers/provider-registry';
import { AIProvider } from '../providers/types';

/** Agents receive an invoker capability, never a raw provider credential. */
export class CredentialBroker {
  constructor(private readonly registry: ProviderRegistry) {}

  public getProviderForInvocation(agentId: string, providerId: string): AIProvider {
    if (!agentId) throw new Error('Credential access requires an agent identity.');
    const provider = this.registry.getProvider(providerId);
    if (!provider) throw new Error(`Provider ${providerId} is unavailable.`);
    return provider;
  }
}
