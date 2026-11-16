import { HuggingFaceAdapter } from './adapters/huggingface.js';
import { VeniceAdapter } from './adapters/venice.js';
import { OpenAICompatibleAdapter, CustomOpenAICompatibleAdapter } from './adapters/openai-compatible.js';
import { NormalizedError } from './errors.js';
export const BUILTIN_PROVIDERS = [
  { id: 'huggingface', name: 'Hugging Face', adapter: 'huggingface', endpoint: 'https://router.huggingface.co/v1', model: 'openai/gpt-oss-120b', enabled: true, builtin: true },
  { id: 'venice', name: 'Venice AI', adapter: 'venice', endpoint: 'https://api.venice.ai/api/v1', model: 'llama-3.1-70b', enabled: true, builtin: true },
  { id: 'openai-compatible', name: 'OpenAI-compatible API', adapter: 'openai-compatible', endpoint: '', model: '', enabled: true, builtin: true },
  { id: 'ollama', name: 'Local Ollama (example)', adapter: 'custom-openai', endpoint: 'http://localhost:11434/v1', model: 'llama3.1', enabled: true, builtin: true },
];
export class ProviderRegistry {
  #adapters = new Map();
  register(adapter) { if (!adapter?.id || typeof adapter.sendMessage !== 'function') throw new TypeError('Adapter must implement sendMessage(config, messages, options)'); this.#adapters.set(adapter.id, adapter); return this; }
  get(id) { return this.#adapters.get(id) || null; }
  has(id) { return this.#adapters.has(id); }
  list() { return [...this.#adapters.values()].map(a => ({ id: a.id, label: a.label, supportsStreaming: !!a.supportsStreaming, supportsListModels: !!a.supportsListModels })); }
  adapterFor(provider) { const a = this.get(provider?.adapter); if (!a) throw new NormalizedError({ category: 'invalid_request', providerId: provider?.id, message: `No adapter registered for "${provider?.adapter || 'unknown'}". Register one in ProviderRegistry.` }); return a; }
}
export function createDefaultRegistry(fetchImpl) {
  const r = new ProviderRegistry();
  // fetchImpl injection is handled by callers passing config.fetchImpl; adapters default to global fetch.
  [new HuggingFaceAdapter(), new VeniceAdapter(), new OpenAICompatibleAdapter(), new CustomOpenAICompatibleAdapter()].forEach(a => r.register(a));
  return r;
}
