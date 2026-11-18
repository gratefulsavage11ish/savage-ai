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

// Provider codes/types that mean "the provider refused the content", not "the
// request was malformed". Matching is exact against these sets, never a fuzzy
// search of ordinary assistant text.
const REFUSAL_CODES = new Set([
  'content_filter', 'content_filter_results', 'content_policy_violation', 'content_policy',
  'moderation_blocked', 'moderation', 'safety', 'safety_violation', 'safe_completion',
]);

export class NormalizedError extends Error {
  constructor({ category = ERROR_CATEGORIES.UNKNOWN_ERROR, message, providerId, model, status, code, retryable = false, cancelled = false, raw } = {}) {
    super(message || CATEGORY_LABELS[category] || category);
    this.name = 'NormalizedError'; this.category = category; this.providerId = providerId || null;
    this.model = model || null; this.status = status ?? null; this.code = code || null;
    this.retryable = retryable; this.cancelled = Boolean(cancelled); this.raw = raw;
  }
  toJSON() {
    return {
      name: this.name, category: this.category, message: this.message, providerId: this.providerId,
      model: this.model, status: this.status, code: this.code, retryable: this.retryable, cancelled: this.cancelled,
    };
  }
}

function bodyText(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  const message = body.error?.message ?? body.message ?? (typeof body.error === 'string' ? body.error : '');
  return typeof message === 'string' ? message : '';
}

// A 404 can mean "this endpoint does not exist" or "this model does not exist".
// Only the body can tell them apart; without evidence we keep the model reading
// because that is what a chat/completions 404 normally means.
const ENDPOINT_HINT = /(endpoint|route|url|path|no such host|unknown host|invalid host)/i;
const ENDPOINT_MISSING = /(not found|does not exist|unknown|invalid|no such)/i;

export function isEndpointNotFound(text) {
  const value = String(text || '');
  if (!value) return false;
  return ENDPOINT_HINT.test(value) && ENDPOINT_MISSING.test(value);
}

export function normalizeHttpStatus(status, { providerId, model, bodyText: rawText = '', body } = {}) {
  const text = `${rawText} ${bodyText(body)}`.toLowerCase();
  const shared = { status, providerId, model };

  if (status === 402) {
    return new NormalizedError({ ...shared, category: 'rate_limit', retryable: false, code: 'payment_required', message: 'Payment required or quota exhausted for this provider. Check billing — no provider was switched.' });
  }
  if (status === 413) {
    return new NormalizedError({ ...shared, category: 'invalid_request', retryable: false, code: 'payload_too_large', message: 'The provider rejected this request as too large. Shorten the conversation — no provider was switched.' });
  }
  if (status === 415) {
    return new NormalizedError({ ...shared, category: 'invalid_request', retryable: false, code: 'unsupported_media_type', message: 'The provider rejected the request content type (HTTP 415).' });
  }
  if (status === 451) {
    return new NormalizedError({ ...shared, category: 'provider_refusal', retryable: false, code: 'unavailable_for_legal_reasons', message: 'The provider refused this request for legal reasons (HTTP 451). No fallback was attempted.' });
  }
  if (status === 429) {
    return new NormalizedError({ ...shared, category: 'rate_limit', retryable: true, message: 'Rate limit reached. Retry later — no provider was switched.' });
  }
  if (status === 401 || status === 403) {
    return new NormalizedError({ ...shared, category: 'authentication_error', message: 'Authentication failed. Check the API key for this provider.' });
  }
  if (status === 404) {
    if (isEndpointNotFound(text)) {
      return new NormalizedError({ ...shared, category: 'invalid_request', retryable: false, code: 'endpoint_not_found', message: 'The provider endpoint was not found (HTTP 404). Check the endpoint URL.' });
    }
    return new NormalizedError({ ...shared, category: 'model_unavailable', message: `Model unavailable: ${model || 'unknown model'}` });
  }
  if (status >= 300 && status < 400) {
    return new NormalizedError({ ...shared, category: 'invalid_request', message: `Provider returned an unexpected redirect (HTTP ${status}). Redirects are refused for safety.` });
  }
  if (status === 400 || status === 422) {
    return new NormalizedError({ ...shared, category: 'invalid_request', message: 'Invalid request. Check model id, endpoint and message format.' });
  }
  if (status >= 500) {
    return new NormalizedError({ ...shared, category: 'server_error', retryable: true, message: 'Provider server error. No fallback was attempted.' });
  }
  if (status >= 400) {
    return new NormalizedError({ ...shared, category: 'invalid_request', message: `Provider returned HTTP ${status}.` });
  }
  return new NormalizedError({ ...shared, category: 'unknown_error', message: `Provider returned HTTP ${status}.` });
}

/**
 * Refusal detector for provider *error/refusal fields only*.
 * Never call this on assistant content: ordinary answers may contain the words
 * "refusal", "cannot" or "sorry" without being a provider refusal.
 */
export function detectRefusal(text) {
  if (!text) return false;
  return /(content[_ ]?filter|refusal|i (?:can't|cannot|won't) (?:help|assist|do that)|i'm sorry.*(?:can't|cannot))/i.test(String(text));
}

/** Returns a refusal message when the payload is a refusal, otherwise null. */
export function refusalMessage(body) {
  if (!body || typeof body !== 'object') return null;
  const code = String(body.error?.code ?? body.error?.type ?? '').toLowerCase();
  if (code && REFUSAL_CODES.has(code)) return body.error?.message || 'Provider refused this request. No fallback was attempted.';
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  if (choice?.message?.refusal) return String(choice.message.refusal);
  if (choice?.finish_reason === 'content_filter') return 'Provider refused this request (content filter). No fallback was attempted.';
  if (body.error?.message && detectRefusal(body.error.message)) return body.error.message;
  if (typeof body.refusal === 'string' && body.refusal) return body.refusal;
  return null;
}
