import { bodyBytes, decodeChunks, sha256 } from './cassette.js';

export class ConformanceReplayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConformanceReplayError';
  }
}

const DROPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

function replayResponse(interaction, method) {
  const { response } = interaction;
  const chunks = decodeChunks(response.chunks);
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    try { headers.set(name, String(value)); } catch { /* invalid recorded header */ }
  }

  const bodyAllowed = method !== 'HEAD' && response.status !== 204 && response.status !== 304;
  let body = null;
  if (bodyAllowed && chunks.length) {
    let index = 0;
    body = new ReadableStream({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunks[index]));
        index += 1;
      },
    });
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText || undefined,
    headers,
  });
}

/**
 * Strict replay: requests must match a recorded method, URL and body hash.
 * There is deliberately no fallback to the network or to global fetch.
 */
export function createReplayFetch(cassette, { matchBody = true } = {}) {
  const entries = cassette.interactions.map((interaction, index) => ({ interaction, index, used: false }));

  async function replayFetch(url, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    const target = String(url);
    const incomingHash = init.body === undefined ? null : sha256(bodyBytes(init.body));
    const sameTarget = entries.filter(entry => (
      entry.interaction.request.method === method && entry.interaction.request.url === target
    ));
    const match = sameTarget.find(entry => (
      !entry.used && (!matchBody || entry.interaction.request.bodyHash === incomingHash)
    ));

    if (!match) {
      if (sameTarget.length) {
        throw new ConformanceReplayError(
          `No unused recorded response for ${method} ${target}. Replay is strict: the request body must match or the cassette must be re-recorded.`,
        );
      }
      throw new ConformanceReplayError(
        `No recorded response for ${method} ${target}. Replay never falls back to the network.`,
      );
    }

    match.used = true;
    return replayResponse(match.interaction, method);
  }

  replayFetch.remaining = () => entries
    .filter(entry => !entry.used)
    .map(entry => `${entry.interaction.request.method} ${entry.interaction.request.url}`);
  replayFetch.assertConsumed = () => {
    const remaining = replayFetch.remaining();
    if (remaining.length) {
      throw new ConformanceReplayError(`Cassette interactions were not replayed: ${remaining.join(', ')}`);
    }
  };
  return replayFetch;
}

/** Convenience helpers so a test can reuse the recorded request exactly. */
export function createReplaySession(cassette, options = {}) {
  const fetch = createReplayFetch(cassette, options);

  const bodyAt = (index = 0) => {
    const text = cassette.interactions[index]?.request?.bodyText;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  };

  return {
    cassette,
    fetch,
    provider(overrides = {}) {
      return {
        id: cassette.provenance.provider,
        adapter: cassette.provenance.adapter,
        endpoint: cassette.provenance.endpoint,
        model: cassette.provenance.model,
        ...overrides,
      };
    },
    request(index = 0) {
      return cassette.interactions[index]?.request || null;
    },
    body: bodyAt,
    messages(index = 0) {
      return bodyAt(index)?.messages || [];
    },
    options(index = 0) {
      const body = bodyAt(index) || {};
      const replay = {};
      if ('stream' in body) replay.stream = Boolean(body.stream);
      if (body.max_tokens != null) replay.maxTokens = body.max_tokens;
      if (body.temperature != null) replay.temperature = body.temperature;
      return replay;
    },
    remaining: () => fetch.remaining(),
    assertConsumed: () => fetch.assertConsumed(),
  };
}
