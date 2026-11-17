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
- `src/errors.js` — `NormalizedError` with categories `provider_refusal`, `authentication_error`,
  `invalid_request`, `rate_limit`, `connection_error`, `timeout`, `server_error`,
  `model_unavailable`, `unknown_error`.
- `src/chat-service.js` — dispatches to **exactly one** adapter and re-throws normalized errors.
  It never retries and never switches provider/model.
- `src/endpoint-policy.js` — host allowlisting, loopback gating, private/link-local IP rejection.
- `src/telemetry.js` — local latency, availability, usage and cost telemetry.
- `server.mjs` — encrypted vault, credential API, provider proxy, audit log, rate limiter, static host.

Normalized success result:

```js
{ ok: true, providerId, model, responseText, usage, latencyMs, cost, requestId }
```

Cost is computed from reported usage and the per-provider pricing you configure
(`inputPer1M` / `outputPer1M`, USD per 1M tokens). It is `null` when the provider reports no usage.

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

Chat requests can be cancelled with the Stop control; cancelling aborts the browser request and the
upstream provider call on the server. The Evaluation view includes a per-provider health chart built
from real request outcomes, latency and refusal telemetry.

Provider metadata (name, endpoint, model, pricing) is stored in `localStorage`; keys and
custom headers are not. In server mode the browser uses `BackendCredentialStore` and never
receives secret material. In prototype mode (`file://` or a plain static server) the client
falls back to `LocalCredentialStore`, which is explicitly marked insecure.

## Tests

```sh
npm test        # 39 tests, no network or real keys required
npm run check   # syntax checks + the same tests
```

Covers provider registration, adapter selection, OpenAI-compatible/HF/Venice/custom requests,
streaming token parsing, model discovery, every error category, timeouts, connection failures,
refusals, credential encryption at rest (ciphertext contains no plaintext), credential endpoints,
CSRF/JSON enforcement, proxy chat/models/test, SSE streaming through the proxy, cost and usage
telemetry, SSRF/allowlist/loopback rejection, Authorization override protection, static file
exposure, and no-silent-fallback at both the service and proxy layers.

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
4. SSRF: host allowlisting, private-IP rejection and `redirect: 'manual'` (redirects are refused)
   are in place, but DNS resolution and the later request are separate steps (rebinding TOCTOU).
   For production, pin resolved addresses and egress through a proxy/firewall.
5. Configure real provider credentials: Hugging Face token (`openai/gpt-oss-120b` via the router),
   Venice key, and an OpenAI-compatible endpoint. Add that endpoint's host to
   `SAVAGE_ALLOWED_HOSTS` — `openai-compatible` has no default host allowlist by design.
6. Local Ollama works over loopback in development (`SAVAGE_ALLOW_LOCAL=1`); production should
   set `SAVAGE_ALLOW_LOCAL=0` unless a trusted self-hosted provider is intended.
7. Streaming is implemented for OpenAI-compatible endpoints. The legacy Hugging Face inference
   shape is buffered (no stream), and the adapter reports `supportsStreaming: false`.
