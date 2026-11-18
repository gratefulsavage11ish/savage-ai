import {
  bodyBytes,
  encodeChunk,
  normalizeSecrets,
  redactBytes,
  sanitizeHeaders,
  sha256,
} from './cassette.js';

export const DEFAULT_RECORD_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Wraps a fetch implementation and records each request/response pair. The
 * caller still receives the original Response untouched; the body is read from
 * a clone in the background so streaming reaches the adapter immediately.
 *
 * `secrets` are scrubbed from request headers/bodies and response headers/body.
 * The writer also refuses to persist a cassette if a secret is still present.
 */
export function createRecordingFetch({
  fetchImpl = globalThis.fetch,
  secrets = [],
  redactHeaderNames = [],
  limitBytes = DEFAULT_RECORD_LIMIT_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createRecordingFetch requires a fetch implementation.');
  const filteredSecrets = normalizeSecrets(secrets);
  const interactions = [];
  const pending = new Set();
  const stats = { requests: 0, bytes: 0, redactions: 0, truncated: 0 };

  async function recordResponseBody(response, interaction) {
    let clone;
    try {
      clone = response.clone();
    } catch {
      return; // Response-like doubles that cannot be cloned are not recordable.
    }
    if (!clone.body) return;
    const reader = clone.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const redacted = redactBytes(Buffer.from(value), filteredSecrets);
        stats.redactions += redacted.count;
        if (interaction.response.bytes + redacted.buffer.length > limitBytes) {
          interaction.response.truncated = true;
          stats.truncated += 1;
          await reader.cancel().catch(() => {});
          break;
        }
        interaction.response.chunks.push(encodeChunk(redacted.buffer));
        interaction.response.bytes += redacted.buffer.length;
        stats.bytes += redacted.buffer.length;
      }
    } catch (error) {
      interaction.response.recordError = error?.name || 'body_read_error';
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  async function recordingFetch(url, init = {}) {
    const started = performance.now();
    const requestHeaders = sanitizeHeaders(init.headers, { secrets: filteredSecrets, redactHeaderNames });
    stats.redactions += requestHeaders.redacted + requestHeaders.replacements;

    let safeBody = bodyBytes(init.body);
    if (safeBody) {
      const redacted = redactBytes(safeBody, filteredSecrets);
      safeBody = redacted.buffer;
      stats.redactions += redacted.count;
    }

    const interaction = {
      request: {
        method: String(init.method || 'GET').toUpperCase(),
        url: String(url),
        headers: requestHeaders.headers,
        bodyText: safeBody ? safeBody.toString('utf8') : null,
        bodyHash: safeBody ? sha256(safeBody) : null,
      },
      response: {
        status: 0,
        statusText: '',
        headers: {},
        chunks: [],
        bytes: 0,
        truncated: false,
      },
      timingMs: 0,
    };

    const response = await fetchImpl(url, init);
    interaction.timingMs = Math.round(performance.now() - started);
    interaction.response.status = response.status;
    interaction.response.statusText = response.statusText || '';
    const responseHeaders = sanitizeHeaders(response.headers, { secrets: filteredSecrets, redactHeaderNames });
    stats.redactions += responseHeaders.redacted + responseHeaders.replacements;
    interaction.response.headers = responseHeaders.headers;
    interactions.push(interaction);
    stats.requests += 1;

    const task = recordResponseBody(response, interaction).catch(error => {
      interaction.response.recordError = error?.message || 'record_error';
    });
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return response;
  }

  recordingFetch.interactions = interactions;
  recordingFetch.stats = stats;
  recordingFetch.flush = async ({ timeoutMs = 15000 } = {}) => {
    if (!pending.size) return;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting ${timeoutMs}ms for recorded response bodies.`)), timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled([...pending]), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  return recordingFetch;
}
