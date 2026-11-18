import { NormalizedError } from './errors.js';

// Request/header timeout. The timer covers the wait for response headers only:
// streamed bodies are governed by the SSE idle timeout instead, so a long but
// healthy stream is never killed by a total-request timer.
export async function timedFetch(url, { timeoutMs = 30000, fetchImpl = globalThis.fetch, signal: externalSignal, ...init } = {}) {
  if (typeof fetchImpl !== 'function') throw new NormalizedError({ category: 'connection_error', message: 'fetch is not available in this environment.' });
  if (externalSignal?.aborted) throw cancelledError();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  const canMerge = typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function';
  if (externalSignal && !canMerge) externalSignal.addEventListener?.('abort', onExternalAbort, { once: true });
  const signal = externalSignal && canMerge ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
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
    if (externalSignal?.aborted) throw Object.assign(cancelledError(), { latencyMs });
    if (timedOut || e?.name === 'AbortError') {
      throw Object.assign(new NormalizedError({ category: 'timeout', code: 'request_timeout', retryable: true, message: `Provider did not respond within ${timeoutMs}ms. No provider was switched.` }), { latencyMs });
    }
    throw Object.assign(new NormalizedError({ category: 'connection_error', retryable: true, message: `Connection error: ${e?.message || 'network failure'}` }), { latencyMs });
  } finally {
    clearTimeout(timer);
    if (externalSignal && !canMerge) externalSignal.removeEventListener?.('abort', onExternalAbort);
  }
}

export function cancelledError() {
  return new NormalizedError({ category: 'timeout', code: 'user_cancelled', cancelled: true, retryable: false, message: 'Cancelled by you. Provider and model were kept as selected.' });
}

export function streamIdleError(idleMs) {
  return new NormalizedError({ category: 'timeout', code: 'stream_idle_timeout', retryable: true, message: `Stream idle for ${idleMs}ms — the provider stopped sending data.` });
}

export async function parseJsonSafe(res) {
  try { return await res.clone().json(); } catch { return null; }
}

export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const firstNumber = (...values) => {
  for (const value of values) { const number = numberOrNull(value); if (number !== null) return number; }
  return null;
};

/**
 * Normalizes the usage shapes providers actually return. `null` means "the
 * provider did not report this", `0` means "reported as zero" — they are never
 * collapsed into each other. Unknown scalar fields are preserved in `extra`.
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const promptTokens = firstNumber(u.prompt_tokens, u.promptTokens, u.input_tokens, u.inputTokens);
  const completionTokens = firstNumber(u.completion_tokens, u.completionTokens, u.output_tokens, u.outputTokens);
  const totalTokens = firstNumber(u.total_tokens, u.totalTokens);
  const cachedTokens = firstNumber(
    u.prompt_tokens_details?.cached_tokens, u.input_tokens_details?.cached_tokens,
    u.cache_read_input_tokens, u.cached_tokens, u.cachedTokens,
  );
  const reasoningTokens = firstNumber(
    u.completion_tokens_details?.reasoning_tokens, u.output_tokens_details?.reasoning_tokens,
    u.reasoning_tokens, u.reasoningTokens,
  );
  const reportedCost = firstNumber(u.cost, u.total_cost, u.cost_usd, u.costUsd);

  const known = new Set([
    'prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens',
    'completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens',
    'total_tokens', 'totalTokens', 'cache_read_input_tokens', 'cached_tokens', 'cachedTokens',
    'reasoning_tokens', 'reasoningTokens', 'cost', 'total_cost', 'cost_usd', 'costUsd',
    'prompt_tokens_details', 'input_tokens_details', 'completion_tokens_details', 'output_tokens_details',
  ]);
  const extra = {};
  for (const [key, value] of Object.entries(u)) {
    if (known.has(key)) continue;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') extra[key] = value;
  }

  const normal = { promptTokens, completionTokens, totalTokens, cachedTokens, reasoningTokens, reportedCost };
  if (Object.values(normal).every(value => value === null) && !Object.keys(extra).length) return null;
  return Object.keys(extra).length ? { ...normal, extra } : normal;
}

/** Cost from reported usage and configured pricing. Returns null rather than guessing. */
export function computeCost(usage, pricing) {
  if (!usage || !pricing) return null;
  const inputPer1M = numberOrNull(pricing.inputPer1M);
  const outputPer1M = numberOrNull(pricing.outputPer1M);
  const inp = numberOrNull(usage.promptTokens);
  const out = numberOrNull(usage.completionTokens);
  if (inputPer1M === null || outputPer1M === null || inp === null || out === null) return null;
  const cost = (inp / 1e6) * inputPer1M + (out / 1e6) * outputPer1M;
  return cost > 0 ? Number(cost.toFixed(6)) : null;
}

/**
 * Prefer a cost the provider reported; otherwise estimate from usage + pricing.
 * `costSource` makes it clear which one the UI is showing.
 */
export function resolveCost(usage, pricing) {
  const reported = usage?.reportedCost;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
    return { cost: Number(reported.toFixed(6)), costSource: 'reported' };
  }
  const computed = computeCost(usage, pricing);
  return computed == null ? { cost: null, costSource: null } : { cost: computed, costSource: 'estimated' };
}

export function successResult({ providerId, model, responseText, usage = null, latencyMs = 0, cost = null, costSource = null, requestId = null, ...extra }) {
  return { ok: true, providerId, model, responseText, usage, latencyMs, cost, costSource, requestId, ...extra };
}
