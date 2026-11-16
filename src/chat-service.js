import { NormalizedError } from './errors.js';
// Single-provider dispatch. NO fallback: any failure is re-thrown normalized.
export class ChatService {
  constructor(registry, telemetry) { this.registry = registry; this.telemetry = telemetry; }
  async send(provider, messages, options = {}) {
    if (provider?.enabled === false) throw new NormalizedError({ category: 'invalid_request', providerId: provider?.id, message: 'Provider is disabled. Enable it or pick another — SAVAGE will not switch for you.' });
    const adapter = this.registry.adapterFor(provider);
    const started = performance.now();
    try {
      const result = await adapter.sendMessage(provider, messages, options);
      this.telemetry?.record({ ok: true, providerId: provider.id, model: result.model, latencyMs: result.latencyMs ?? Math.round(performance.now() - started), cost: result.cost, usage: result.usage, requestId: result.requestId, kind: 'chat' });
      return result;
    } catch (e) {
      const normalized = adapter.normalizeError ? adapter.normalizeError(e) : e;
      this.telemetry?.record({ ok: false, providerId: provider.id, model: provider.model, latencyMs: e.latencyMs ?? Math.round(performance.now() - started), category: normalized.category || 'unknown_error', kind: 'chat' });
      throw normalized; // never fallback
    }
  }
  async test(provider) { const a = this.registry.adapterFor(provider); try { const r = await a.testConnection(provider); this.telemetry?.record({ ok: true, providerId: provider.id, latencyMs: r.latencyMs, kind: 'test' }); return r; } catch (e) { const n = a.normalizeError(e); this.telemetry?.record({ ok: false, providerId: provider.id, latencyMs: e.latencyMs || 0, category: n.category, kind: 'test' }); throw n; } }
  async listModels(provider) { const a = this.registry.adapterFor(provider); if (!a.supportsListModels) throw new NormalizedError({ category: 'invalid_request', providerId: provider.id, message: 'This provider does not support model discovery.' }); return a.listModels(provider); }
}
