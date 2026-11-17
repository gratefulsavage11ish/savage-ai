import { NormalizedError, normalizeHttpStatus, detectRefusal } from '../errors.js';
import { timedFetch, parseJsonSafe, joinUrl, computeCost, normalizeUsage, successResult } from '../http.js';

export class OpenAICompatibleAdapter {
  id = 'openai-compatible'; label = 'OpenAI-compatible API'; supportsStreaming = true; supportsListModels = true;
  constructor({ defaultBaseUrl = '', name = 'OpenAI-compatible' } = {}) { this.defaultBaseUrl = defaultBaseUrl; this.displayName = name; }
  baseUrl(config) { return (config.endpoint || this.defaultBaseUrl || '').replace(/\/+$/, ''); }
  headers(config, extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (config.apiKey) h.Authorization = `Bearer ${config.apiKey}`;
    if (config.customHeaders) { try { Object.assign(h, typeof config.customHeaders === 'string' ? JSON.parse(config.customHeaders) : config.customHeaders); } catch { throw new NormalizedError({ category: 'invalid_request', message: 'Custom headers must be valid JSON.' }); } }
    return h;
  }
  async _requireBase(config) { if (!this.baseUrl(config)) throw new NormalizedError({ category: 'invalid_request', message: 'No endpoint configured for this provider.' }); }
  async testConnection(config) {
    await this._requireBase(config);
    if (this.supportsListModels) { const r = await this.listModels(config); return { ok: true, providerId: config.id, model: config.model, latencyMs: r.latencyMs, modelCount: r.models.length, message: `Connected — ${r.models.length} model(s) listed.` }; }
    return { ok: true, providerId: config.id, model: config.model, latencyMs: 0, message: 'Endpoint reachable.' };
  }
  async listModels(config) {
    await this._requireBase(config);
    const { res, latencyMs } = await timedFetch(joinUrl(this.baseUrl(config), 'models'), { headers: this.headers(config), timeoutMs: config.timeoutMs, fetchImpl: config.fetchImpl });
    const body = await parseJsonSafe(res);
    if (!res.ok) throw normalizeHttpStatus(res.status, { providerId: config.id, model: config.model, body });
    const models = (body?.data || body?.models || []).map(m => typeof m === 'string' ? { id: m } : { id: m.id || m.name, ownedBy: m.owned_by || m.ownedBy || null }).filter(m => m.id);
    return { ok: true, providerId: config.id, models, latencyMs };
  }
  async sendMessage(config, messages, options = {}) {
    await this._requireBase(config);
    if (!config.model) throw new NormalizedError({ category: 'invalid_request', providerId: config.id, message: 'No model selected for this provider.' });
    const stream = Boolean(options.stream && this.supportsStreaming);
    const body = { model: config.model, messages, stream, ...(options.temperature != null ? { temperature: options.temperature } : {}), ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}) };
    const { res, latencyMs } = await timedFetch(joinUrl(this.baseUrl(config), 'chat/completions'), { method: 'POST', headers: this.headers(config), body: JSON.stringify(body), timeoutMs: options.timeoutMs || config.timeoutMs, fetchImpl: config.fetchImpl, signal: options.signal });
    if (!res.ok) { const b = await parseJsonSafe(res); throw normalizeHttpStatus(res.status, { providerId: config.id, model: config.model, body: b }); }
    if (stream && res.body) return this._consumeStream(config, res, latencyMs, options);
    const json = await parseJsonSafe(res);
    const choice = json?.choices?.[0];
    const text = choice?.message?.content || choice?.text || '';
    // OpenAI refusal field (newer models) + content-filter signals
    if (choice?.message?.refusal || json?.choices?.[0]?.finish_reason === 'content_filter') {
      throw new NormalizedError({ category: 'provider_refusal', providerId: config.id, model: config.model, message: choice?.message?.refusal || 'Provider refused this request (content filter). No fallback was attempted.' });
    }
    if (!text && detectRefusal(json?.error?.message)) throw new NormalizedError({ category: 'provider_refusal', providerId: config.id, model: config.model, message: 'Provider refused this request.' });
    const usage = normalizeUsage(json?.usage);
    return successResult({ providerId: config.id, model: config.model, responseText: text, usage, latencyMs, cost: computeCost(usage, config.pricing), requestId: json?.id || res.headers?.get?.('x-request-id') || null });
  }
  async _consumeStream(config, res, latencyMs, options) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const idleMs = options.timeoutMs || config.timeoutMs || 60000;
    let buffer = '', text = '', usage = null, requestId = null, finished = false;
    try {
      while (!finished) {
        const { done, value } = await readWithIdle(reader, idleMs);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { finished = true; break; }
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event?.error) throw new NormalizedError({ category: 'server_error', providerId: config.id, model: config.model, message: event.error.message || 'Provider reported a streaming error.' });
          requestId ||= event.id;
          usage = normalizeUsage(event.usage) || usage;
          const delta = event.choices?.[0]?.delta?.content || event.choices?.[0]?.text || '';
          if (delta) { text += delta; options.onToken?.(delta, text); }
        }
      }
      try { await reader.cancel(); } catch { /* stream already closed */ }
      return successResult({ providerId: config.id, model: config.model, responseText: text, usage, latencyMs, cost: computeCost(usage, config.pricing), requestId, streamed: true });
    } catch (error) {
      try { await reader.cancel(); } catch { /* already closed */ }
      if (options.signal?.aborted) throw Object.assign(new NormalizedError({ category: 'timeout', retryable: false, message: 'Request was cancelled.' }), { latencyMs });
      if (error instanceof NormalizedError) throw Object.assign(error, { latencyMs });
      throw Object.assign(new NormalizedError({ category: 'connection_error', providerId: config.id, model: config.model, retryable: true, message: `Streaming connection failed: ${error?.message || 'connection lost'}` }), { latencyMs });
    }
  }
  normalizeError(error) { return error instanceof NormalizedError ? error : new NormalizedError({ category: 'unknown_error', message: error?.message || String(error) }); }
}
function readWithIdle(reader, idleMs) {
  let timer;
  const idle = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new NormalizedError({ category: 'timeout', retryable: true, message: `Stream idle for ${idleMs}ms — the provider stopped sending data.` })), idleMs);
  });
  return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
}

export class CustomOpenAICompatibleAdapter extends OpenAICompatibleAdapter { id = 'custom-openai'; label = 'Custom OpenAI-compatible'; constructor() { super({ name: 'Custom provider' }); } }
