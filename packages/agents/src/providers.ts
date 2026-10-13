/**
 * Model providers — the crew's connection to language models.
 *
 * The crew never talks to a model directly: every call goes through the
 * provider gateway, which walks an ordered list of OpenAI-compatible
 * providers (Featherless, Azure AI Foundry, any custom endpoint) with a
 * circuit breaker per provider. When every provider is unavailable the
 * gateway returns null and the crew falls back to deterministic templates —
 * the production never stalls.
 */

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  providerId: string;
}

export interface LLMProvider {
  id: string;
  enabled(): boolean;
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<string>;
}

interface OpenAICompatOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Azure-style deployments use a different path. */
  azureDeployment?: string;
  apiVersion?: string;
}

/** Any endpoint that speaks the OpenAI chat-completions schema. */
export function openAICompatProvider(options: OpenAICompatOptions): LLMProvider {
  return {
    id: options.id,
    enabled: () => options.apiKey.length > 0 && options.baseUrl.length > 0,
    async complete(req: CompletionRequest, signal?: AbortSignal): Promise<string> {
      const url = options.azureDeployment
        ? `${options.baseUrl}/openai/deployments/${options.azureDeployment}/chat/completions?api-version=${options.apiVersion ?? '2024-06-01'}`
        : `${options.baseUrl}/chat/completions`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options.azureDeployment) headers['api-key'] = options.apiKey;
      else headers['Authorization'] = `Bearer ${options.apiKey}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);
      if (signal) signal.addEventListener('abort', () => controller.abort());
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: options.model,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user },
            ],
            max_tokens: req.maxTokens ?? 400,
            temperature: req.temperature ?? 0.3,
          }),
        });
        if (!response.ok) throw new Error(`${options.id} HTTP ${response.status}`);
        const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = json.choices?.[0]?.message?.content;
        if (!text) throw new Error(`${options.id} returned empty completion`);
        return text.trim();
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function featherlessProvider(apiKey: string, model = 'Qwen/Qwen3-30B-A3B-Instruct-2507'): LLMProvider {
  return openAICompatProvider({
    id: 'featherless',
    baseUrl: 'https://api.featherless.ai/v1',
    apiKey,
    model,
  });
}

export function foundryProvider(endpoint: string, apiKey: string, deployment: string): LLMProvider {
  return openAICompatProvider({
    id: 'foundry',
    baseUrl: endpoint,
    apiKey,
    model: deployment,
    azureDeployment: deployment,
  });
}

/** Deterministic provider used by tests and offline development. */
export function mockProvider(id: string, transform: (req: CompletionRequest) => string): LLMProvider {
  return {
    id,
    enabled: () => true,
    async complete(req) {
      return transform(req);
    },
  };
}

export interface GatewayOptions {
  breakerThreshold?: number;
  cooldownMs?: number;
}

interface BreakerState {
  failures: number;
  openedAt: number;
}

export class ProviderGateway {
  private readonly providers: LLMProvider[];
  private readonly breakers = new Map<string, BreakerState>();
  private readonly breakerThreshold: number;
  private readonly cooldownMs: number;
  private lastUsed: string | null = null;

  constructor(providers: LLMProvider[], options: GatewayOptions = {}) {
    this.providers = providers;
    this.breakerThreshold = options.breakerThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }

  /** Returns null when every provider is unavailable or failing. */
  async complete(req: CompletionRequest): Promise<CompletionResult | null> {
    for (const provider of this.providers) {
      if (!provider.enabled()) continue;
      const breaker = this.breakers.get(provider.id) ?? { failures: 0, openedAt: 0 };
      if (breaker.failures >= this.breakerThreshold && Date.now() - breaker.openedAt < this.cooldownMs) {
        continue; // circuit open
      }
      try {
        const text = await provider.complete(req);
        this.breakers.set(provider.id, { failures: 0, openedAt: 0 });
        this.lastUsed = provider.id;
        return { text, providerId: provider.id };
      } catch {
        breaker.failures++;
        breaker.openedAt = Date.now();
        this.breakers.set(provider.id, breaker);
      }
    }
    this.lastUsed = null;
    return null;
  }

  lastProvider(): string | null {
    return this.lastUsed;
  }
}
