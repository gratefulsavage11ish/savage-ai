import { NormalizedError, normalizeHttpStatus, detectRefusal } from '../errors.js';
import { timedFetch, parseJsonSafe, joinUrl, computeCost, successResult } from '../http.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
// Hugging Face: OpenAI-compatible router endpoint (https://router.huggingface.co/v1) is preferred;
// falls back to Inference API shape only if endpoint is the legacy inference host.
export class HuggingFaceAdapter extends OpenAICompatibleAdapter {
  id = 'huggingface'; label = 'Hugging Face'; supportsStreaming = false;
  constructor() { super({ defaultBaseUrl: 'https://router.huggingface.co/v1', name: 'Hugging Face' }); }
  async listModels(config) {
    const base = this.baseUrl(config);
    if (base.includes('api-inference')) return { ok: true, providerId: config.id, models: config.model ? [{ id: config.model }] : [], latencyMs: 0, note: 'Legacy inference endpoint: model list not available, configured model only.' };
    return super.listModels(config);
  }
  async sendMessage(config, messages, options = {}) {
    const base = this.baseUrl(config);
    if (!base.includes('api-inference')) return super.sendMessage(config, messages, { ...options, stream: false });
    // Legacy Inference API: POST /models/{model} { inputs }
    if (!config.model) throw new NormalizedError({ category: 'invalid_request', providerId: config.id, message: 'No model selected.' });
    const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const { res, latencyMs } = await timedFetch(joinUrl(base, `models/${config.model}`), { method: 'POST', headers: this.headers(config), body: JSON.stringify({ inputs: prompt, parameters: { return_full_text: false } }), timeoutMs: options.timeoutMs || config.timeoutMs, fetchImpl: config.fetchImpl });
    const body = await parseJsonSafe(res);
    if (!res.ok) throw normalizeHttpStatus(res.status, { providerId: config.id, model: config.model, body });
    const text = Array.isArray(body) ? body[0]?.generated_text || '' : body?.generated_text || '';
    if (!text && detectRefusal(body?.error)) throw new NormalizedError({ category: 'provider_refusal', providerId: config.id, model: config.model, message: 'Provider refused this request.' });
    return successResult({ providerId: config.id, model: config.model, responseText: text, usage: null, latencyMs, cost: computeCost(null, config.pricing), requestId: res.headers?.get?.('x-request-id') || null });
  }
}
