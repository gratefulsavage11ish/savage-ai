import { NormalizedError } from './errors.js';
// Timed fetch with timeout. Never retries silently — caller decides.
export async function timedFetch(url, { timeoutMs = 30000, fetchImpl = globalThis.fetch, signal: externalSignal, ...init } = {}) {
  if (typeof fetchImpl !== 'function') throw new NormalizedError({ category: 'connection_error', message: 'fetch is not available in this environment.' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = externalSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  const started = performance.now();
  try {
    // Redirects are never followed: an allowlisted host must not be able to
    // bounce the request to an internal address (SSRF protection).
    const res = await fetchImpl(url, { ...init, redirect: 'manual', signal });
    const latency = Math.round(performance.now() - started);
    if (res.status >= 300 && res.status < 400) {
      throw Object.assign(new NormalizedError({ category: 'invalid_request', status: res.status, message: `Provider returned an unexpected redirect (HTTP ${res.status}). Redirects are refused for safety.` }), { latencyMs: latency });
    }
    return { res, latencyMs: latency };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started);
    if (e instanceof NormalizedError) throw Object.assign(e, { latencyMs });
    if (externalSignal?.aborted) throw Object.assign(new NormalizedError({ category: 'timeout', retryable: false, message: 'Request was cancelled.' }), { latencyMs });
    if (e?.name === 'AbortError') throw Object.assign(new NormalizedError({ category: 'timeout', retryable: true, message: `Request timed out after ${timeoutMs}ms.` }), { latencyMs });
    throw Object.assign(new NormalizedError({ category: 'connection_error', retryable: true, message: `Connection error: ${e?.message || 'network failure'}` }), { latencyMs });
  } finally { clearTimeout(timer); }
}
export async function parseJsonSafe(res) { try { return await res.clone().json(); } catch { return null; } }
export function joinUrl(base, path) { return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`; }
export function computeCost(usage, pricing) {
  if (!usage || !pricing) return null;
  const inp = usage.promptTokens ?? usage.input_tokens ?? 0, out = usage.completionTokens ?? usage.output_tokens ?? 0;
  const cost = (inp / 1e6) * (pricing.inputPer1M ?? 0) + (out / 1e6) * (pricing.outputPer1M ?? 0);
  return cost > 0 ? Number(cost.toFixed(6)) : null;
}
export function normalizeUsage(u) {
  if (!u) return null;
  return { promptTokens: u.prompt_tokens ?? u.promptTokens ?? u.input_tokens ?? null, completionTokens: u.completion_tokens ?? u.completionTokens ?? u.output_tokens ?? null, totalTokens: u.total_tokens ?? u.totalTokens ?? null };
}
export function successResult({ providerId, model, responseText, usage = null, latencyMs = 0, cost = null, requestId = null, ...extra }) {
  return { ok: true, providerId, model, responseText, usage, latencyMs, cost, requestId, ...extra };
}
