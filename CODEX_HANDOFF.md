# Codex handoff prompt

Copy everything between the markers into Codex. It is self-contained.

<!-- CODEX-PROMPT-START -->
You are continuing SAVAGE AI, a provider-independent AI connection system. Clone the repository
and preserve its visual design and security invariants.

CONTEXT
- Repository (public): https://github.com/gratefulsavage11ish/savage-ai
- Clone: `git clone https://github.com/gratefulsavage11ish/savage-ai.git`
- Branch: freebuff/174eb48b615d40af2fb498a5 (repository default branch)
- Base commits: f1b6301 ("Add provider-independent SAVAGE AI stack with encrypted credential vault")
  and d0cf0a5 (Codex handoff prompt); run `git log` for the latest.
- Runtime: Node.js 26, ESM, zero dependencies, no build step.
- Read first: HANDOFF.md, README.md, src/provider-registry.js, src/chat-service.js,
  src/adapters/openai-compatible.js, src/endpoint-policy.js, server.mjs, tests/proxy.test.js.
- Run: `npm test` (105/105 passing), `npm run check`, `node server.mjs` (PORT 3001).
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
- Server: AES-256-GCM credential vault + credential API (secrets write-only, corrupt or
  truncated vaults fail closed), SSRF-guarded proxy (host allowlisting, private/link-local/IPv6
  rejection, redirects refused, loopback gated), SSE streaming proxy with client-disconnect abort
  propagation, audit summary, per-IP rate limiting, Origin/Sec-Fetch-Site checks.
- Shared SSE parser (`src/sse.js`) and request lifecycle (`src/request-lifecycle.js`): frozen
  provider snapshot per request, stale-response and late-token suppression.
- Frontend: proxy-mode auto-detection with BackendCredentialStore only — no browser key storage
  and no fallback when the backend is missing; streaming chat with Stop, normalized error cards
  with same-provider retry, accessible provider menu and focus-trapped modal, telemetry dashboard.
- Conformance harness: `tools/conformance/` records real provider traffic into sanitized cassettes
  (`tests/conformance/cassettes/`) and replays it strictly with no keys or network. Record more with
  `npm run record:conformance -- --help`; keys are read from the environment only.

INVARIANTS — DO NOT BREAK
1. Never silently switch provider or model, and never auto-retry a refusal.
2. Never send provider keys or custom auth headers to the browser; never store them in localStorage.
3. Keep the proxy allowlist and private-IP/redirect protections intact; do not add an arbitrary
   URL proxy.
4. Preserve the existing SAVAGE AI dark control-center design and responsive layout.
5. Keep the adapter interface and registry extensible; new providers register an adapter.
6. Do not claim verification you did not run.

WORKING RULES
- Use only the requirements and milestones stated in the originating chat; do not infer a roadmap
  from this handoff document.
- Preserve the invariants above and keep `npm test` and the syntax checks passing.
- Do not add production-hardening scope or features the chat did not request.

CURRENT LIMITATION
No authenticated provider credentials are configured, so successful authenticated calls are still
untested. Keyless live traffic (Pollinations model list/completion/stream, Hugging Face 401, llm7
429) is recorded and replayed by the suite. Authenticated success recordings can be added with
`npm run record:conformance` once keys are available.
<!-- CODEX-PROMPT-END -->
