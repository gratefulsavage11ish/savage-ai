import { NormalizedError, normalizeHttpStatus, refusalMessage } from '../errors.js';
import { timedFetch, joinUrl, normalizeUsage, resolveCost, successResult, cancelledError, streamIdleError } from '../http.js';
import { SseParser } from '../sse.js';

// Headers a caller may never set from provider configuration. `authorization`
// and `host` are the security-critical ones: letting custom headers win would
// let a client point a vaulted key at another host or replay it elsewhere.
export const RESERVED_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'host', 'content-length', 'connection',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect', 'keep-alive',
  'cookie', 'set-cookie', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-real-ip', 'forwarded', 'via', 'content-encoding',
]);

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** Parses, validates and filters custom headers. Reserved names are dropped. */
export function sanitizeCustomHeaders(input) {
  if (input == null || input === '') return undefined;
  let headers = input;
  if (typeof headers === 'string') {
    try { headers = JSON.parse(headers); } catch { throw new NormalizedError({ category: 'invalid_request', message: 'Custom headers must be valid JSON.' }); }
  }
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new NormalizedError({ category: 'invalid_request', message: 'Custom headers must be a JSON object.' });
  }
  const out = {};
  for (const [key, value] of Object.entries(headers).slice(0, 50)) {
    const name = String(key).trim();
    if (!HEADER_NAME.test(name)) throw new NormalizedError({ category: 'invalid_request', message: `Invalid custom header name "${name}".` });
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    const text = String(value ?? '');
    if (/[\r\n\0]/.test(text)) throw new NormalizedError({ category: 'invalid_request', message: `Custom header "${name}" must not contain line breaks.` });
    out[name] = text.slice(0, 2048);
  }
  return Object.keys(out).length ? out : undefined;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
  return '';
}

async function readBody(res) {
  let text;
  try { text = await res.clone().text(); } catch { text = undefined; }
  if (typeof text === 'string') {
    if (!text) return { json: null, text: '' };
    try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
  }
  // Response-like test doubles may only implement json().
  try { return { json: await res.clone().json(), text: '' }; } catch { return { json: null, text: '' }; }
}

export class OpenAICompatibleAdapter {
  id = 'openai-compatible'; label = 'OpenAI-compatible API'; supportsStreaming = true; supportsListModels = true;
  constructor({ defaultBaseUrl = '', name = 'OpenAI-compatible' } = {}) { this.defaultBaseUrl = defaultBaseUrl; this.displayName = name; }
  baseUrl(config) { return (config.endpoint || this.defaultBaseUrl || '').replace(/\/+$/, ''); }
  headers(config, extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (config.apiKey) h.Authorization = `Bearer ${config.apiKey}`;
    const custom = sanitizeCustomHeaders(config.customHeaders);
    if (custom) Object.assign(h, custom);
    return h;
  }
  async _requireBase(config) {
    if (!this.baseUrl(config)) throw new NormalizedError({ category: 'invalid_request', message: 'No endpoint configured for this provider.' });
  }
  async testConnection(config) {
    await this._requireBase(config);
    if (this.supportsListModels) { const r = await this.listModels(config); return { ok: true, providerId: config.id, model: config.model, latencyMs: r.latencyMs, modelCount: r.models.length, message: `Connected — ${r.models.length} model(s) listed.` }; }
    return { ok: true, providerId: config.id, model: config.model, latencyMs: 0, message: 'Endpoint reachable.' };
  }
  async listModels(config) {
    await this._requireBase(config);
    const { res, latencyMs } = await timedFetch(joinUrl(this.baseUrl(config), 'models'), { headers: this.headers(config), timeoutMs: config.timeoutMs, fetchImpl: config.fetchImpl, signal: config.signal });
    const { json } = await readBody(res);
    if (!res.ok) throw normalizeHttpStatus(res.status, { providerId: config.id, model: config.model, body: json });
    if (json === null) throw new NormalizedError({ category: 'server_error', code: 'malformed_json', retryable: true, message: 'Provider model list was not valid JSON.' });
    const models = (json?.data || json?.models || []).map(m => typeof m === 'string' ? { id: m } : { id: m.id || m.name, ownedBy: m.owned_by || m.ownedBy || null }).filter(m => m.id);
    return { ok: true, providerId: config.id, models, latencyMs };
  }
  async sendMessage(config, messages, options = {}) {
    await this._requireBase(config);
    if (!config.model) throw new NormalizedError({ category: 'invalid_request', providerId: config.id, message: 'No model selected for this provider.' });
    const stream = Boolean(options.stream && this.supportsStreaming);
    const body = { model: config.model, messages, stream, ...(options.temperature != null ? { temperature: options.temperature } : {}), ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}) };
    const { res, latencyMs } = await timedFetch(joinUrl(this.baseUrl(config), 'chat/completions'), { method: 'POST', headers: this.headers(config), body: JSON.stringify(body), timeoutMs: options.timeoutMs || config.timeoutMs, fetchImpl: config.fetchImpl, signal: options.signal });
    if (!res.ok) {
      const { json, text } = await readBody(res);
      throw normalizeHttpStatus(res.status, { providerId: config.id, model: config.model, body: json, bodyText: json ? '' : text });
    }
    if (stream && res.body) return this._consumeStream(config, res, latencyMs, options);

    const { json, text: rawText } = await readBody(res);
    if (json === null) {
      throw new NormalizedError({ category: 'server_error', code: 'malformed_json', retryable: true, providerId: config.id, model: config.model, message: rawText ? 'Provider returned a response that was not valid JSON.' : 'Provider returned an empty response body.' });
    }
    const refusal = refusalMessage(json);
    if (refusal) throw new NormalizedError({ category: 'provider_refusal', providerId: config.id, model: config.model, message: refusal, raw: json });

    const choices = json.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new NormalizedError({ category: 'server_error', code: 'malformed_response', retryable: true, providerId: config.id, model: config.model, message: 'Provider response did not include any choices.' });
    }
    const choice = choices[0];
    const text = extractText(choice?.message?.content) || (typeof choice?.text === 'string' ? choice.text : '');
    if (!text) {
      if (choice?.finish_reason === 'length') {
        return successResult({ providerId: config.id, model: config.model, responseText: '', usage: normalizeUsage(json.usage), latencyMs, cost: null, requestId: json?.id || null, warning: 'The provider returned no text because the token limit was reached.' });
      }
      throw new NormalizedError({ category: 'server_error', code: 'empty_completion', retryable: true, providerId: config.id, model: config.model, message: 'Provider returned an empty completion.' });
    }
    const usage = normalizeUsage(json.usage);
    const { cost, costSource } = resolveCost(usage, config.pricing);
    return successResult({ providerId: config.id, model: config.model, responseText: text, usage, latencyMs, cost, costSource, requestId: json?.id || res.headers?.get?.('x-request-id') || null });
  }

  async _consumeStream(config, res, latencyMs, options = {}) {
    const reader = res.body.getReader();
    const parser = new SseParser();
    const idleMs = options.idleTimeoutMs ?? options.timeoutMs ?? config.timeoutMs ?? 60_000;
    const signal = options.signal;
    let text = '', usage = null, requestId = null, finishReason = null;
    let released = false;

    const release = async () => {
      if (released) return;
      released = true;
      try { await reader.cancel(); } catch { /* already closed */ }
    };
    const onAbort = () => { void release(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const consume = (event) => {
      if (event.type === 'done') return;
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; } // keep-alives / partial frames are ignored
      const refusal = refusalMessage(payload);
      if (refusal) throw new NormalizedError({ category: 'provider_refusal', providerId: config.id, model: config.model, message: refusal, raw: payload });
      if (payload?.error) throw new NormalizedError({ category: 'server_error', providerId: config.id, model: config.model, message: payload.error.message || 'Provider reported a streaming error.' });
      requestId ||= payload?.id || null;
      usage = normalizeUsage(payload?.usage) || usage;
      const choice = payload?.choices?.[0];
      if (choice?.delta?.refusal) throw new NormalizedError({ category: 'provider_refusal', providerId: config.id, model: config.model, message: String(choice.delta.refusal), raw: payload });
      const delta = extractText(choice?.delta?.content) || (typeof choice?.text === 'string' ? choice.text : '');
      if (delta && !signal?.aborted) {
        text += delta;
        options.onToken?.(delta, text);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    };

    try {
      if (signal?.aborted) throw cancelledError();
      while (!parser.done) {
        const { done, value } = await readWithIdle(reader, idleMs, signal);
        if (done) break;
        for (const event of parser.feed(value)) consume(event);
        if (signal?.aborted) throw cancelledError();
      }
      if (!parser.done) for (const event of parser.flush()) consume(event);

      if (finishReason === 'content_filter') {
        throw new NormalizedError({ category: 'provider_refusal', providerId: config.id, model: config.model, message: 'Provider refused this request (content filter). No fallback was attempted.' });
      }
      if (!text) {
        if (parser.done) throw new NormalizedError({ category: 'server_error', code: 'empty_completion', retryable: true, providerId: config.id, model: config.model, message: 'Provider returned a stream with no content.' });
        throw new NormalizedError({ category: 'connection_error', code: 'stream_incomplete', retryable: true, providerId: config.id, model: config.model, message: 'Stream ended before the provider sent any content.' });
      }
      const complete = parser.done || finishReason !== null;
      const terminatedBy = parser.done ? 'done' : finishReason !== null ? 'finish_reason' : 'eof';
      const warnings = [];
      if (!parser.done && finishReason === null) warnings.push('Stream ended without [DONE]; the response may be incomplete.');
      if (finishReason === 'length') warnings.push('Response was cut off by the token limit.');
      const { cost, costSource } = resolveCost(usage, config.pricing);
      return successResult({
        providerId: config.id, model: config.model, responseText: text, usage, latencyMs, cost, costSource, requestId,
        streamed: true, complete, terminatedBy,
        ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      });
    } catch (error) {
      if (signal?.aborted || error?.cancelled) throw Object.assign(cancelledError(), { latencyMs });
      if (error instanceof NormalizedError) throw Object.assign(error, { latencyMs });
      throw Object.assign(new NormalizedError({ category: 'connection_error', code: 'stream_transport', retryable: true, providerId: config.id, model: config.model, message: `Streaming connection failed: ${error?.message || 'connection lost'}` }), { latencyMs });
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      await release();
    }
  }

  normalizeError(error) { return error instanceof NormalizedError ? error : new NormalizedError({ category: 'unknown_error', message: error?.message || String(error) }); }
}

function readWithIdle(reader, idleMs, signal) {
  if (signal?.aborted) return Promise.reject(cancelledError());
  let timer;
  const idle = new Promise((_, reject) => { timer = setTimeout(() => reject(streamIdleError(idleMs)), idleMs); });
  return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
}

export class CustomOpenAICompatibleAdapter extends OpenAICompatibleAdapter { id = 'custom-openai'; label = 'Custom OpenAI-compatible'; constructor() { super({ name: 'Custom provider' }); } }
