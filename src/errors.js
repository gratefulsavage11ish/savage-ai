// Normalized error taxonomy. Adapters must map provider-specific failures here.
export const ERROR_CATEGORIES = Object.freeze({
  PROVIDER_REFUSAL: 'provider_refusal',
  AUTHENTICATION_ERROR: 'authentication_error',
  INVALID_REQUEST: 'invalid_request',
  RATE_LIMIT: 'rate_limit',
  CONNECTION_ERROR: 'connection_error',
  TIMEOUT: 'timeout',
  SERVER_ERROR: 'server_error',
  MODEL_UNAVAILABLE: 'model_unavailable',
  UNKNOWN_ERROR: 'unknown_error',
});
export const CATEGORY_LABELS = {
  provider_refusal: 'Provider refusal', authentication_error: 'Authentication error',
  invalid_request: 'Invalid request', rate_limit: 'Rate limit', connection_error: 'Connection error',
  timeout: 'Timeout', server_error: 'Server error', model_unavailable: 'Model unavailable', unknown_error: 'Unknown error',
};
export class NormalizedError extends Error {
  constructor({ category = ERROR_CATEGORIES.UNKNOWN_ERROR, message, providerId, model, status, code, retryable = false, raw } = {}) {
    super(message || CATEGORY_LABELS[category] || category);
    this.name = 'NormalizedError'; this.category = category; this.providerId = providerId || null;
    this.model = model || null; this.status = status ?? null; this.code = code || null;
    this.retryable = retryable; this.raw = raw;
  }
  toJSON() { return { name: this.name, category: this.category, message: this.message, providerId: this.providerId, model: this.model, status: this.status, code: this.code, retryable: this.retryable }; }
}
export function normalizeHttpStatus(status, { providerId, model, bodyText = '', body } = {}) {
  const text = `${bodyText} ${body?.error?.message || body?.message || body?.error || ''}`.toLowerCase();
  if (status === 429) return new NormalizedError({ category: 'rate_limit', status, providerId, model, retryable: true, message: 'Rate limit reached. Retry later — no provider was switched.' });
  if (status === 401 || status === 403) return new NormalizedError({ category: 'authentication_error', status, providerId, model, message: 'Authentication failed. Check the API key for this provider.' });
  if (status === 404 || text.includes('model') && (text.includes('not found') || text.includes('does not exist') || text.includes('unavailable'))) return new NormalizedError({ category: 'model_unavailable', status, providerId, model, message: `Model unavailable: ${model || 'unknown model'}` });
  if (status >= 300 && status < 400) return new NormalizedError({ category: 'invalid_request', status, providerId, model, message: `Provider returned an unexpected redirect (HTTP ${status}). Redirects are refused for safety.` });
  if (status === 400 || status === 422) return new NormalizedError({ category: 'invalid_request', status, providerId, model, message: 'Invalid request. Check model id, endpoint and message format.' });
  if (status >= 500) return new NormalizedError({ category: 'server_error', status, providerId, model, retryable: true, message: 'Provider server error. No fallback was attempted.' });
  return new NormalizedError({ category: 'unknown_error', status, providerId, model, message: `Provider returned HTTP ${status}.` });
}
export function detectRefusal(text) {
  if (!text) return false;
  return /(content[_ ]?filter|refusal|i (?:can't|cannot|won't) (?:help|assist|do that)|i'm sorry.*(?:can't|cannot))/i.test(text);
}
