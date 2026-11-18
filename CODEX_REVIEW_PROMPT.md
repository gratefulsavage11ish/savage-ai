# Codex task: read-only review + Milestone 2 / 3 plan

**Mode: INSPECTION ONLY.** Do not modify, create, delete or rename any file. Do not commit,
do not install anything, do not edit package.json or the lockfile. You may run read-only
commands (`git log`, `npm test`, `npm run check`, `node server.mjs`) to confirm behaviour, but
the deliverable is a written report, nothing applied.

Repository: https://github.com/gratefulsavage11ish/savage-ai
Branch under review: `freebuff/174eb48b615d40af2fb498a5`

## What this project is

SAVAGE AI is a provider-independent AI connection system: a vanilla HTML/CSS/JS frontend plus a
dependency-free Node (ESM) development server, with no framework and no build step. Every AI
provider is reached through an adapter so the app is not hardcoded around OpenAI.

```
index.html, styles.css, app.js        UI: provider management, chat, streaming, evaluation view
server.mjs                            static host, encrypted credential vault, provider proxy,
                                      SSE streaming, audit log, rate limiting, Origin/JSON checks
src/provider-registry.js              adapter registry + built-in provider list
src/chat-service.js                   single-provider dispatch; never retries, never falls back
src/adapters/openai-compatible.js     base adapter: chat, models, SSE stream parsing, refusal detection
src/adapters/huggingface.js           router endpoint + legacy inference shape (buffered)
src/adapters/venice.js                Venice defaults
src/errors.js                         NormalizedError + 9 categories + HTTP status mapping
src/http.js                           timed fetch, abort, usage/cost normalization
src/endpoint-policy.js                host allowlist, loopback gating, private-IP rejection
src/secure-storage.js                 CredentialStore / BackendCredentialStore (no browser key store)
src/telemetry.js                      local latency, availability, usage, cost telemetry
tests/*.test.js                       105 tests (node --test), no network or real keys needed
tools/conformance/                    record/replay harness + recording CLI for provider cassettes
tests/conformance/cassettes/          sanitized live provider exchanges replayed by the tests
.github/workflows/ci.yml              Node 22 + 24: syntax checks + npm test
```

Runtime facts: `node server.mjs` listens on `:3001` (`PORT`); `SAVAGE_CREDENTIAL_KEY` enables the
encrypted file vault, otherwise an in-memory vault is used. `npm test` runs 105 tests; `npm run check`
adds `node --check` on `app.js`, `server.mjs` and the recording CLI. CI runs both on Node 22 and 24.

## Non-negotiable invariants

Treat any violation of these as a finding, and treat any proposal that breaks them as wrong:

1. **No silent switching.** The system never switches provider or model, never retries into a
   different provider, and never falls back after a refusal or failure.
2. **User owns selection.** Provider and model selection belong to the user and must survive
   errors, reloads and mid-stream changes.
3. **Normalized errors only.** Every provider failure maps to exactly one of: `provider_refusal`,
   `authentication_error`, `invalid_request`, `rate_limit`, `connection_error`, `timeout`,
   `server_error`, `model_unavailable`, `unknown_error`. Raw provider payloads must not reach the UI.
4. **Adapters are the extension point.** Adding a provider should require a new adapter, a registry
   entry, an allowlist entry and a UI option — nothing more, no core rewrites.
5. **Secrets never reach the browser.** Keys stay server-side in the vault; the client only learns
   `{ configured: boolean }`.
6. **SSRF protections stay intact.** Allowlist, loopback gating, private/link-local rejection,
   `redirect: 'manual'`, no credentials in endpoint URLs.
7. **The visual design and responsive layout are preserved.** Review for regressions, do not redesign.
8. **No cryptocurrency or blockchain functionality.** `node:crypto` for AES-256-GCM vault encryption
   is the only acceptable cryptography.

## Review scope — inspect everything

Read every file listed above, in full, including tests and CI config. Then assess:

**Correctness**
- SSE parsing in `_consumeStream`: CRLF handling, multi-line `data:` events, comment/`event:` lines,
  split UTF-8 sequences across chunks, usage arriving only in the final chunk, `[DONE]` followed by
  more bytes, streams that end without `[DONE]`, and whether `reader.cancel()` is always reached.
- Abort semantics: client Stop → browser abort → server abort → upstream `signal`. What happens when
  the abort lands between the fetch resolving and the stream being read? Are timers, readers and
  listeners always released? Is the idle timeout distinct from the total timeout?
- `normalizeHttpStatus` classification: precedence bugs (note the `404 || text.includes('model') && …`
  expression), 400 vs 422 vs 404 vs 402/413/415/451/503, and cases where a body message contradicts
  the status code. Which categories are unreachable from which adapters?
- Refusal detection: false positives on ordinary text, false negatives for providers that signal
  refusals in the body with HTTP 200, `finish_reason: 'content_filter'`, or an empty `content`.
- Usage/cost: missing or partial usage, cached-token pricing, cost rounding, `null` vs `0` semantics.

**Security**
- Vault: key derivation from `SAVAGE_CREDENTIAL_KEY`, IV/nonce uniqueness, auth tag handling, AAD,
  file permissions, atomic writes, concurrent writes, behaviour on corrupted or truncated vault files,
  and what happens when the key changes.
- Proxy: allowlist suffix matching, DNS rebinding window between policy check and request, IPv6
  forms (`::ffff:`, zone ids, bracketed hosts, integer/octal IPv4), user-supplied `customHeaders`
  overriding `Authorization` or `Host`, header injection, request body size limits, and error bodies
  that could echo secrets.
- Server: Origin / `Sec-Fetch-Site` checks, JSON content-type enforcement, rate-limit keying and
  memory growth, audit/telemetry array growth, static-file path traversal and dotfile exposure,
  directory listing, caching headers on secret-bearing responses.

**Frontend**
- `app.js` state machine: switching provider mid-stream, two concurrent streams, stale responses
  overwriting newer state, retry reusing an aborted controller, provider deletion while streaming.
- Rendering: any place provider/model/message text is inserted as HTML (XSS), and whether error text
  is escaped.
- Storage: corrupted `localStorage` JSON, quota exceeded, migration when stored provider shapes change.
- Accessibility and responsive behaviour of the provider menu, model picker and Stop control.

**Tests and delivery**
- Which invariants are actually asserted versus assumed; missing coverage for cancellation, vault
  corruption, rate limiting, concurrency, and adapter parsing edge cases.
- Whether tests would catch a regression that introduces silent fallback.
- Repo hygiene: README accuracy against the code, absent LICENSE, absent `engines`, no lockfile,
  no lint/format/type checking, no dependency budget statement, CI that only runs tests.

For each area, distinguish **verified defect** (you reproduced or can point to the exact line that
must fail) from **risk** (plausible but unproven). Do not pad the report with style preferences.

## Deliverable 1 — findings

A table sorted by severity, one row per finding:

`ID | Severity (blocker/high/medium/low) | Area | Location (file:line) | Defect or risk | Why it matters | Suggested fix (describe, do not apply) | Effort (S/M/L)`

Then, for every one of the eight invariants: **pass / partial / fail**, with the evidence that
justifies it.

Then a short list of **test gaps**, each phrased as the assertion that should exist.

Cap the report at roughly 25 findings — the most consequential ones, not everything you notice.
State explicitly what you could not verify without real provider credentials.

## Deliverable 2 — Milestone 2 and Milestone 3 plan

Milestone 1 is the current state: adapter architecture with real provider calls, normalized errors,
an encrypted server vault, a working proxy, a streaming/cancellable UI, 105 tests and CI on Node 22/24.

Produce a concrete plan for **Milestone 2** and then **Milestone 3**. Ground both in the gaps your
review actually found — the milestone should name the findings it closes.

For each milestone provide:

- **Theme** in one sentence, and the single measurable goal that proves it is done.
- **Why now** — what breaks or stays untestable if it is deferred.
- **In scope / explicitly out of scope.**
- **Work items**, at most 10, each with: what changes, acceptance criteria, the tests to add
  (named), and its dependency on other items.
- **Risks and mitigations**, including anything that could reintroduce silent fallback, leak a
  secret, or break the dependency-free constraint.
- **Definition of done** — the command(s) that must pass and the manual check a human must perform.
- **Rough sequencing** — what lands first and what can run in parallel.

Constraints on the plan:

- Milestone 2 must be the next coherent capability, not a grab bag. Prefer closing the reliability
  and provider-conformance gaps that make real usage unverifiable today (there are no API keys in
  CI, so live calls are unproven).
- Milestone 3 must build on Milestone 2 rather than repeat it.
- Do not introduce authentication, multi-tenancy or a KMS unless you argue in one paragraph that it
  is the highest-value next step; if you do argue it, put it in Milestone 3 and say what it displaces.
- Stay dependency-free unless a dependency is genuinely required — if so, name the exact package,
  its version, why the standard library cannot do it, and what it costs.
- Every work item must have a verification method. No work item may reduce the current test baseline.
- No cryptocurrency or blockchain work of any kind.

## Output

Write the whole report as your reply. Do not create `REVIEW.md` or any other file unless your
harness cannot return a message without one. Be blunt and specific; cite `file:line` for every
claim; no praise, no summary of what the code already does well beyond one short paragraph.
