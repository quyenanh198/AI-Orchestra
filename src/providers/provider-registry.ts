import { AIProvider } from './types';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import { OllamaProvider } from './ollama-provider';

export class ProviderRegistry {
    private static instance: ProviderRegistry;
    private providers: Map<string, AIProvider> = new Map();

    private constructor() {}

    public static getInstance(): ProviderRegistry {
        if (!ProviderRegistry.instance) {
            ProviderRegistry.instance = new ProviderRegistry();
        }
        return ProviderRegistry.instance;
    }

    public initialize(): void {
        this.registerProvider(new OpenAIProvider());
        this.registerProvider(new AnthropicProvider());
        this.registerProvider(new GeminiProvider());
        this.registerProvider(new OllamaProvider());
    }

    public registerProvider(provider: AIProvider): void {
        this.providers.set(provider.id, provider);
    }

    public unregisterProvider(id: string): void {
        const provider = this.providers.get(id);
        if (provider) {
            provider.dispose();
            this.providers.delete(id);
        }
    }

    public getProvider(id: string): AIProvider | undefined {
        return this.providers.get(id);
    }

    public getAllProviders(): AIProvider[] {
        return Array.from(this.providers.values());
    }

    public async getAvailableProviders(): Promise<AIProvider[]> {
        const providers = this.getAllProviders();
        const availableProviders = [];
        
        for (const provider of providers) {
            if (await provider.isAvailable()) {
                availableProviders.push(provider);
            }
        }
        
        return availableProviders;
    }

    public dispose(): void {
        for (const provider of this.providers.values()) {
            provider.dispose();
        }
        this.providers.clear();
    }
}
