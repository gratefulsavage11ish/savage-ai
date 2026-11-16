# Codex handoff prompt

Copy everything between the markers into Codex. It is self-contained.

<!-- CODEX-PROMPT-START -->
You are continuing SAVAGE AI, a provider-independent AI connection system. Work in the existing
workspace and preserve its visual design and security invariants.

CONTEXT
- Workspace: /workspace/chats/174eb48b615d40af2fb498a5
- Branch: freebuff/174eb48b615d40af2fb498a5
- Base commit: f1b6301 ("Add provider-independent SAVAGE AI stack with encrypted credential vault")
- Runtime: Node.js 26, ESM, zero dependencies, no build step.
- Read first: HANDOFF.md, README.md, src/provider-registry.js, src/chat-service.js,
  src/adapters/openai-compatible.js, src/endpoint-policy.js, server.mjs, tests/proxy.test.js.
- Run: `npm test` (35/35 passing), `npm run check`, `node server.mjs` (PORT 3001).
- Persistence requires `SAVAGE_CREDENTIAL_KEY="$(openssl rand -hex 32)"`; without it the server
  uses a non-persistent in-memory vault. Provider hosts beyond Hugging Face/Venice must be added
  to `SAVAGE_ALLOWED_HOSTS`. `SAVAGE_ALLOW_LOCAL=0` disables loopback endpoints.

WHAT EXISTS
- ProviderRegistry with HuggingFaceAdapter, VeniceAdapter, OpenAICompatibleAdapter and
  CustomOpenAICompatibleAdapter. Interface: testConnection, listModels, sendMessage,
  normalizeError.
- Normalized results: { ok, providerId, model, responseText, usage, latencyMs, cost, requestId }.
- Normalized error categories: provider_refusal, authentication_error, invalid_request,
  rate_limit, connection_error, timeout, server_error, model_unavailable, unknown_error.
- ChatService calls exactly one adapter and rethrows; no retry, no silent fallback, no automatic
  model switch. Provider selection is always explicit and stays put after failures.
- Server: AES-256-GCM credential vault + credential API (secrets write-only), SSRF-guarded proxy
  (host allowlisting, private/link-local rejection, redirects refused, loopback gated),
  SSE streaming proxy, audit summary, per-IP rate limiting, Origin/Sec-Fetch-Site checks.
- Frontend: proxy-mode auto-detection with BackendCredentialStore, streaming chat, normalized
  error cards with same-provider retry, accessible provider menu, telemetry dashboard.

INVARIANTS — DO NOT BREAK
1. Never silently switch provider or model, and never auto-retry a refusal.
2. Never send provider keys or custom auth headers to the browser; never store them in localStorage.
3. Keep the proxy allowlist and private-IP/redirect protections intact; do not add an arbitrary
   URL proxy.
4. Preserve the existing SAVAGE AI dark control-center design and responsive layout.
5. Keep the adapter interface and registry extensible; new providers register an adapter.
6. Do not claim verification you did not run.

PRIORITIES, IN ORDER
1. Authentication and per-user credential isolation: user accounts, per-user vault namespaces,
   per-user rate limits, authorization checks on every credential and proxy route.
2. Replace the development file vault with KMS-backed envelope encryption and an encrypted
   database; add key rotation.
3. CSRF tokens and audit retention/alerting; expand audit fields without logging secrets.
4. DNS pinning / egress proxy to close the SSRF rebinding TOCTOU, keeping tests green.
5. Real provider configuration and live verification once credentials are available (Hugging Face
   router model `openai/gpt-oss-120b`, Venice, an allowlisted OpenAI-compatible endpoint).
6. Add tests for every new behavior; keep `npm test` and syntax checks passing.

CURRENT LIMITATION
The branch is not pushed to a remote yet (GitHub device authorization was still pending). Do not
invent a remote or credentials. If the repository is available, base work on the commit above.
<!-- CODEX-PROMPT-END -->
