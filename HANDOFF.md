# SAVAGE AI — server & workspace handoff

Shared context for anyone continuing this build. Keep this file in sync with the running server.

## Workspace

- Path: `/workspace/chats/174eb48b615d40af2fb498a5`
- Repository: https://github.com/gratefulsavage11ish/savage-ai (public)
- Branch: `freebuff/174eb48b615d40af2fb498a5` (repository default branch)
- Runtime: Node.js 26 (ESM, no dependencies, no build step)
- Files: `index.html`, `styles.css`, `app.js`, `server.mjs`, `src/`, `tests/`, `tools/conformance/`, `package.json`, `README.md`

## Run the development server

```sh
# encrypted, persistent credential vault
export SAVAGE_CREDENTIAL_KEY="$(openssl rand -hex 32)"
node server.mjs          # http://0.0.0.0:3001

# or, without a key (in-memory vault, credentials lost on restart)
node server.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `SAVAGE_CREDENTIAL_KEY` | unset | 32-byte hex key for the AES-256-GCM file vault at `data/vault.json` |
| `SAVAGE_ALLOWED_HOSTS` | unset | Comma-separated extra provider hosts allowed by the proxy |
| `SAVAGE_ALLOW_LOCAL` | `1` | Set `0` to refuse loopback provider endpoints |

No server process is guaranteed to survive a workspace restart: start it with the command above.
It runs with an in-memory vault (`memory-dev`), no authentication and no stored credentials unless
you set `SAVAGE_CREDENTIAL_KEY`.

## Live endpoints

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/health` | Mode, vault kind, adapters, error categories, warnings |
| GET | `/api/telemetry` | Server audit summary + last 50 events |
| GET | `/api/credentials` | Providers with stored credentials |
| GET | `/api/credentials/:id` | `{ ok, id, configured }` — never returns secrets |
| PUT | `/api/credentials/:id` | Body `{ secret?, headers? }`, encrypted |
| DELETE | `/api/credentials/:id` | Removes stored credentials |
| POST | `/api/proxy/:id/chat` | Body `{ provider, messages, options: { stream? } }` |
| POST | `/api/proxy/:id/models` | Body `{ provider }` |
| POST | `/api/proxy/:id/test` | Body `{ provider }` |

Proxy `provider` shape (never includes keys; the server injects the vaulted secret):

```json
{
  "id": "p1",
  "adapter": "openai-compatible",
  "endpoint": "https://provider.example.com/v1",
  "model": "model-id",
  "pricing": { "inputPer1M": 0, "outputPer1M": 0 }
}
```

Adapters: `huggingface`, `venice`, `openai-compatible`, `custom-openai`.

Mutations require `Content-Type: application/json` and a same-origin `Origin` (curl must send it).
Success: `{ "ok": true, "result": { ... } }`. Failure: `{ "ok": false, "error": { "category", "message", ... } }`
with categories `provider_refusal`, `authentication_error`, `invalid_request`, `rate_limit`,
`connection_error`, `timeout`, `server_error`, `model_unavailable`, `unknown_error`.

Streaming chat responses are SSE (`text/event-stream`) with `{"type":"token"|"done"|"error"}` frames.

## Verification state

- `node --check app.js` and `node --check server.mjs` pass.
- `npm test` → **105/105 passing** (adapters, SSE parsing, error categories, cancellation vs timeouts,
  header sanitization, usage/cost, corrupt/truncated/concurrent vault writes, permissions, credentials,
  proxy, client-disconnect abort propagation, streaming idle/error/cancel behavior, IPv6/SSRF,
  request lifecycle, no-fallback, telemetry, and record/replay of live provider cassettes).
- `tools/conformance/` records real provider traffic into sanitized cassettes; replay is strict,
  network-free and key-free. Record new exchanges with `npm run record:conformance -- --help`.
- `npm run check` runs syntax checks plus the suite.
- Health and static hosting return 200.

## Architecture at a glance

- `src/provider-registry.js` — registry + built-in providers (HF default `openai/gpt-oss-120b`).
- `src/adapters/*` — four adapters, shared `testConnection` / `listModels` / `sendMessage` / `normalizeError`.
- `src/chat-service.js` — exactly one adapter per request; normalized errors rethrown; **never** retries or switches provider/model.
- `src/endpoint-policy.js` — host allowlisting, loopback gating, private/link-local rejection.
- `src/http.js` — timed fetch, `redirect: 'manual'` (redirects refused), usage/cost normalization.
- `src/sse.js` — shared SSE parser (chunking, CRLF, multiline data, split UTF-8, `[DONE]`).
- `src/request-lifecycle.js` — frozen provider snapshot per request; stale/late-token suppression.
- `server.mjs` — fail-closed vault, credential API, SSRF-guarded proxy, audit log, rate limiter,
  client-disconnect abort propagation, static host.
- `app.js` — auto-detects the backend; `BackendCredentialStore` only and **no** browser key storage
  (fails closed without the server); accessible ⋯ menu and focus-trapped modal; streaming chat;
  normalized errors with same-provider retry.
- `tools/conformance/` — recording fetch, strict replay, sanitized cassette writer and recording CLI;
  `tests/conformance/cassettes/` holds the live provider exchanges replayed by the suite.

## Known gaps (do not treat as done)

1. No authentication/authorization; anyone who can reach the server can use stored credentials.
2. Dev file vault, not KMS/encrypted DB; no key rotation.
3. No per-user rate limits, CSRF tokens, audit retention, or alerting.
4. DNS rebinding is **not solved**: the resolve check and the outbound connection are separate
   steps, and dependency-free `fetch` cannot pin the resolved address. Use an enforcing egress proxy
   or address pinning in production.
5. Authenticated provider calls are still untested: no real keys are configured. Keyless live
   traffic (Pollinations model list/completion/stream, Hugging Face 401, llm7 429) is recorded and
   replayed. Record authenticated successes with `npm run record:conformance` once keys are available.
   `openai-compatible` hosts must be added to `SAVAGE_ALLOWED_HOSTS`; Hugging Face / Venice need
   their own keys.
