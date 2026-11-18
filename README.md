# SAVAGE AI — provider-independent AI connection system

Vanilla HTML/CSS/JS frontend plus a dependency-free Node development server.
No framework, no build step, no npm install required.

Repository: https://github.com/gratefulsavage11ish/savage-ai (public).

## Architecture

```
ProviderRegistry
  ├── HuggingFaceAdapter            (router.huggingface.co/v1, default model openai/gpt-oss-120b;
  │                                  legacy api-inference shape also supported)
  ├── VeniceAdapter                 (https://api.venice.ai/api/v1)
  ├── OpenAICompatibleAdapter       (any /chat/completions + /models endpoint)
  └── CustomOpenAICompatibleAdapter (Ollama & self-hosted OpenAI-compatible servers)
        testConnection(config)
        listModels(config)
        sendMessage(config, messages, options)   // options.stream + onToken
        normalizeError(error)
```

Shared pieces:

- `src/http.js` — timed fetch (`AbortController`), usage/cost normalization, `successResult`.
- `src/sse.js` — shared SSE parser: chunk boundaries, CRLF/CR/LF, multiline `data:`, UTF-8 split
  across chunks, `[DONE]` and trailing bytes.
- `src/request-lifecycle.js` — one in-flight request at a time, with a frozen provider snapshot so
  late tokens and provider/model switches cannot relabel a response or misattribute telemetry.
- `src/errors.js` — `NormalizedError` with categories `provider_refusal`, `authentication_error`,
  `invalid_request`, `rate_limit`, `connection_error`, `timeout`, `server_error`,
  `model_unavailable`, `unknown_error`. Status mapping is explicit: 402 → `rate_limit`
  (`payment_required`, not retryable), 413/415 → `invalid_request`, 451 → `provider_refusal`,
  404 → `model_unavailable` unless the body names a missing endpoint, malformed or empty 200s →
  `server_error`, other 4xx → `invalid_request`. Refusal detection only reads provider
  error/refusal fields, never assistant text.
- `src/chat-service.js` — dispatches to **exactly one** adapter and re-throws normalized errors.
  It never retries and never switches provider/model.
- `src/endpoint-policy.js` — host allowlisting, loopback gating, private/link-local IP rejection.
- `src/telemetry.js` — local latency, availability, usage and cost telemetry.
- `server.mjs` — encrypted vault, credential API, provider proxy, audit log, rate limiter, static host.

Normalized success result:

```js
{ ok: true, providerId, model, responseText, usage, latencyMs, cost, requestId }
```

Usage keeps input/output/total, cached and reasoning tokens, and preserves unknown scalar fields.
`null` (not reported) and `0` (reported as zero) are distinct. Cost prefers a provider-reported
cost and otherwise estimates from usage plus the per-provider pricing you configure
(`inputPer1M` / `outputPer1M`, USD per 1M tokens); `costSource` is `reported`, `estimated`, or
`null`, and a missing side of the usage never produces a confident cost.

## Run

```sh
export SAVAGE_CREDENTIAL_KEY="$(openssl rand -hex 32)"
node server.mjs
# → http://localhost:3001  (PORT overrides)
```

Without `SAVAGE_CREDENTIAL_KEY` the server still starts with an **in-memory** vault
(credentials are encrypted but lost on restart; the UI and `/api/health` warn about this).

Optional environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `SAVAGE_CREDENTIAL_KEY` | — | 32-byte key (64 hex chars) for the encrypted file vault |
| `SAVAGE_ALLOWED_HOSTS` | — | Comma-separated extra hosts allowed as provider endpoints |
| `SAVAGE_ALLOW_LOCAL` | `1` | Set `0` to refuse loopback provider endpoints (production) |

## HTTP API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Service mode, vault kind, adapters, error categories, warnings |
| GET | `/api/credentials` | List provider ids that have stored credentials |
| GET | `/api/credentials/:id` | `{ configured: boolean }` — never returns secrets |
| PUT | `/api/credentials/:id` | Store `{ secret, headers }` encrypted |
| DELETE | `/api/credentials/:id` | Remove stored credentials |
| POST | `/api/proxy/:id/chat` | Real chat; `options.stream` returns SSE (`token` / `done` / `error`) |
| POST | `/api/proxy/:id/models` | Real model discovery |
| POST | `/api/proxy/:id/test` | Real connection test |
| GET | `/api/telemetry` | Server audit summary (latency, cost, refusals, rate limits) |

Proxy requests carry provider metadata (`id`, `adapter`, `endpoint`, `model`, `pricing`) but
**never keys**; the server injects the vaulted secret. Provider selection lives in the UI:
the server has no fallback path. Cross-origin mutations are refused (Origin/Sec-Fetch-Site),
bodies must be `application/json`, and requests are rate limited per IP.

Chat requests can be cancelled with the Stop control; cancelling aborts the browser request, the
server's upstream call, and the stream reader. Cancellation is reported distinctly from a request
timeout and from an idle-stream timeout, and late tokens from a cancelled or superseded request are
discarded. A stream that ends without `[DONE]` but with content is returned as `complete: false`
with a warning instead of being presented as a clean finish. The Evaluation view includes a
per-provider health chart built from real request outcomes, latency and refusal telemetry.

Provider metadata (name, endpoint, model, pricing) is stored in `localStorage`; keys and
custom headers are not. The browser uses `BackendCredentialStore` and never receives secret
material. There is no browser credential fallback: if `/api/health` is unavailable the UI fails
closed, disables key entry and asks for the server instead of writing keys to storage.

## Tests

```sh
npm test        # 89 tests, no network or real keys required
npm run check   # syntax checks + the same tests
```

Covers provider registration, adapter selection, OpenAI-compatible/HF/Venice/custom requests,
SSE parsing (chunking, CRLF, multiline data, split UTF-8, `[DONE]`, no-`[DONE]` policy), model
discovery, every error category including 402/413/415/451 and endpoint-vs-model 404s, malformed
and empty responses, refusal fields, cancellation versus timeout, header sanitization, usage/cost
normalization, credential encryption at rest (ciphertext contains no plaintext), corrupt/truncated
vaults, wrong keys, concurrent and failed atomic writes, file permissions, credential endpoints,
CSRF/JSON enforcement, proxy chat/models/test, client-disconnect abort propagation, streaming
through the proxy, SSRF/IPv6/allowlist/loopback rejection, static file exposure, and
no-silent-fallback at both the service and proxy layers.

## Add a provider adapter

```js
class MyAdapter extends OpenAICompatibleAdapter {
  id = 'my-provider';
  constructor() { super({ defaultBaseUrl: 'https://api.my-provider.com/v1', name: 'My Provider' }); }
}
registry.register(new MyAdapter());
```

Then allowlist its host in `src/endpoint-policy.js` (or `SAVAGE_ALLOWED_HOSTS`) and add it to the
adapter `<select>` in `index.html`. No application rebuild or registry changes elsewhere.

## Still required before production

1. The encrypted file vault is a development scaffold. Replace it with KMS-backed envelope
   encryption and an encrypted database; rotate `SAVAGE_CREDENTIAL_KEY` via a secret manager.
2. Add authentication, authorization, per-user rate limits, CSRF tokens (an Origin check alone
   is not auth), audit retention/alerts, and key rotation.
3. Keep API keys server-side only and ideally proxy every provider call — never send secrets to
   the browser.
4. SSRF: host allowlisting, private-IP rejection (including IPv4-mapped IPv6, zone ids and 6to4)
   and `redirect: 'manual'` are in place, but the DNS check and the later connection are separate
   steps. Dependency-free Node cannot pin the address for `fetch`, so **DNS rebinding is not
   solved** — production must pin resolved addresses or egress through an enforcing proxy/firewall.
5. Configure real provider credentials: Hugging Face token (`openai/gpt-oss-120b` via the router),
   Venice key, and an OpenAI-compatible endpoint. Add that endpoint's host to
   `SAVAGE_ALLOWED_HOSTS` — `openai-compatible` has no default host allowlist by design.
6. Local Ollama works over loopback in development (`SAVAGE_ALLOW_LOCAL=1`); production should
   set `SAVAGE_ALLOW_LOCAL=0` unless a trusted self-hosted provider is intended.
7. Streaming is implemented for OpenAI-compatible endpoints. The legacy Hugging Face inference
   shape is buffered (no stream), and the adapter reports `supportsStreaming: false`.
