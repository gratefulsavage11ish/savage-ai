import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry, createDefaultRegistry, BUILTIN_PROVIDERS } from '../src/provider-registry.js';
import { OpenAICompatibleAdapter, CustomOpenAICompatibleAdapter, sanitizeCustomHeaders } from '../src/adapters/openai-compatible.js';
import { HuggingFaceAdapter } from '../src/adapters/huggingface.js';
import { VeniceAdapter } from '../src/adapters/venice.js';
import { ChatService } from '../src/chat-service.js';
import { Telemetry } from '../src/telemetry.js';
import { NormalizedError } from '../src/errors.js';
import { normalizeUsage } from '../src/http.js';

const jsonRes = (body, status = 200, headers = {}) => ({
  ok: status < 400, status,
  headers: { get: key => headers[key] || null },
  clone() { return { json: async () => body }; },
});
const message = { role: 'user', content: 'hi' };

test('provider registration & adapter selection', () => {
  const registry = createDefaultRegistry();
  for (const id of ['huggingface', 'venice', 'openai-compatible', 'custom-openai']) assert.ok(registry.has(id), id);
  assert.equal(registry.adapterFor({ adapter: 'venice' }).id, 'venice');
  assert.throws(() => registry.adapterFor({ adapter: 'nope' }), /No adapter registered/);
  assert.throws(() => new ProviderRegistry().register({}), TypeError);
  assert.ok(BUILTIN_PROVIDERS.find(p => p.id === 'huggingface').model === 'openai/gpt-oss-120b');
});

test('OpenAI-compatible request is normalized', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonRes({ id: 'req_1', choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
  };
  const result = await new OpenAICompatibleAdapter().sendMessage(
    { id: 'p', endpoint: 'https://x.test/v1', apiKey: 'k', model: 'm', pricing: { inputPer1M: 1, outputPer1M: 2 }, fetchImpl }, [message],
  );
  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'p');
  assert.equal(result.model, 'm');
  assert.equal(result.responseText, 'hi there');
  assert.equal(result.usage.totalTokens, 8);
  assert.equal(result.requestId, 'req_1');
  assert.ok(result.cost > 0);
  assert.match(seen.url, /\/chat\/completions$/);
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(seen.init.body).messages, [message]);
});

test('custom headers and pricing are applied', async () => {
  let headers = null;
  const fetchImpl = async (url, init) => { headers = init.headers; return jsonRes({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }); };
  const result = await new OpenAICompatibleAdapter().sendMessage(
    { id: 'p', endpoint: 'https://x.test/v1', model: 'm', customHeaders: { 'X-Org': 'acme' }, pricing: { inputPer1M: 3, outputPer1M: 9 }, fetchImpl }, [message],
  );
  assert.equal(headers['X-Org'], 'acme');
  assert.equal(result.cost, 3);
});

test('Hugging Face uses router endpoint by default and does not stream', async () => {
  const adapter = new HuggingFaceAdapter();
  assert.ok(adapter instanceof OpenAICompatibleAdapter);
  assert.equal(adapter.supportsStreaming, false);
  assert.equal(adapter.baseUrl({ endpoint: '' }), 'https://router.huggingface.co/v1');
});

test('Hugging Face legacy inference shape is supported', async () => {
  let requested = '';
  const fetchImpl = async (url) => { requested = url; return jsonRes([{ generated_text: 'legacy hello' }]); };
  const result = await new HuggingFaceAdapter().sendMessage(
    { id: 'p', endpoint: 'https://api-inference.huggingface.co', model: 'm', apiKey: 'k', fetchImpl }, [message],
  );
  assert.equal(result.responseText, 'legacy hello');
  assert.match(requested, /\/models\/m$/);
});

test('Venice adapter keeps Venice defaults', () => {
  const adapter = new VeniceAdapter();
  assert.equal(adapter.id, 'venice');
  assert.equal(adapter.baseUrl({ endpoint: '' }), 'https://api.venice.ai/api/v1');
});

test('model discovery', async () => {
  const fetchImpl = async () => jsonRes({ data: [{ id: 'a', owned_by: 'x' }, { id: 'b' }] });
  const result = await new OpenAICompatibleAdapter().listModels({ id: 'p', endpoint: 'https://x/v1', apiKey: 'k', fetchImpl });
  assert.deepEqual(result.models.map(m => m.id), ['a', 'b']);
  assert.equal(result.ok, true);
});

test('refusal detection: content_filter and message.refusal', async () => {
  const filtered = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => filtered.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: async () => jsonRes({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }) }, [message]),
    error => error.category === 'provider_refusal',
  );
  const refused = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => refused.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: async () => jsonRes({ choices: [{ message: { refusal: 'I cannot help with that' } }] }) }, [message]),
    error => error.category === 'provider_refusal',
  );
});

test('rate-limit, auth, invalid, server and model errors are categorized', async () => {
  const adapter = new OpenAICompatibleAdapter();
  const cases = [
    [400, 'invalid_request'], [401, 'authentication_error'], [403, 'authentication_error'],
    [404, 'model_unavailable'], [422, 'invalid_request'], [429, 'rate_limit'], [500, 'server_error'], [503, 'server_error'],
  ];
  for (const [status, category] of cases) {
    await assert.rejects(
      () => adapter.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: async () => jsonRes({ error: { message: 'provider says no' } }, status) }, [message]),
      error => error.category === category,
      `HTTP ${status} should map to ${category}`,
    );
  }
});

test('redirects are refused instead of followed (SSRF safety)', async () => {
  let init = null;
  const adapter = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => adapter.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: async (url, options) => { init = options; return jsonRes({}, 302); } }, [message]),
    error => error.category === 'invalid_request' && /redirect/i.test(error.message),
  );
  assert.equal(init.redirect, 'manual');
});

test('missing endpoint/model is an invalid_request', async () => {
  const adapter = new OpenAICompatibleAdapter();
  await assert.rejects(() => adapter.sendMessage({ id: 'p', endpoint: '', model: 'm' }, [message]), error => error.category === 'invalid_request');
  await assert.rejects(() => adapter.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: '' }, [message]), error => error.category === 'invalid_request');
});

test('connection failure is normalized and retryable', async () => {
  const adapter = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => adapter.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: async () => { throw new TypeError('fetch failed'); } }, [message]),
    error => error.category === 'connection_error' && error.retryable === true,
  );
});

test('timeouts are normalized distinctly from connection errors', async () => {
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
  });
  const adapter = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => adapter.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: hangingFetch }, [message], { timeoutMs: 20 }),
    error => error.category === 'timeout' && error.retryable === true,
  );
});

test('streaming emits tokens and returns a normalized result', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"total_tokens":7}}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  const tokens = [];
  const result = await new OpenAICompatibleAdapter().sendMessage(
    { id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: stream }) },
    [message], { stream: true, onToken: delta => tokens.push(delta) },
  );
  assert.deepEqual(tokens, ['Hel', 'lo']);
  assert.equal(result.responseText, 'Hello');
  assert.equal(result.streamed, true);
  assert.equal(result.usage.totalTokens, 7);
});

test('stream stops reading after [DONE] even if the connection stays open', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n'));
      // intentionally never close
    },
  });
  const result = await new OpenAICompatibleAdapter().sendMessage(
    { id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: stream }) },
    [message], { stream: true, timeoutMs: 20 },
  );
  assert.equal(result.responseText, 'done');
  assert.equal(result.streamed, true);
});

test('stream idle timeouts are normalized and release the reader', async () => {
  const stream = new ReadableStream({ start() { /* never emits */ } });
  const adapter = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => adapter.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: stream }) }, [message], { stream: true, timeoutMs: 20 }),
    error => error.category === 'timeout' && /idle/i.test(error.message),
  );
});

test('stream transport errors become connection errors', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('socket reset')); } });
  const adapter = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => adapter.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: stream }) }, [message], { stream: true }),
    error => error.category === 'connection_error' && /Streaming connection failed/.test(error.message),
  );
});

test('custom OpenAI-compatible adapter is registered', () => {
  const adapter = new CustomOpenAICompatibleAdapter();
  assert.equal(adapter.id, 'custom-openai');
  assert.ok(createDefaultRegistry().has('custom-openai'));
});

test('no silent fallback — ChatService rethrows and calls exactly one adapter', async () => {
  let calls = 0;
  const failing = { id: 'fail', label: 'F', supportsStreaming: false, supportsListModels: false, async sendMessage() { calls += 1; throw new NormalizedError({ category: 'rate_limit', message: '429' }); }, normalizeError: error => error };
  const other = { id: 'other', label: 'O', async sendMessage() { calls += 100; return { ok: true }; }, normalizeError: error => error };
  const registry = new ProviderRegistry().register(failing).register(other);
  const service = new ChatService(registry, new Telemetry());
  await assert.rejects(() => service.send({ id: 'p', adapter: 'fail', enabled: true, model: 'm' }, [message]), error => error.category === 'rate_limit');
  assert.equal(calls, 1, 'must not fall through to another provider');
});

test('no silent fallback — refusal does not retry or switch', async () => {
  let calls = 0;
  const adapter = new OpenAICompatibleAdapter();
  const fetchImpl = async () => { calls += 1; return jsonRes({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }); };
  await assert.rejects(() => adapter.sendMessage({ id: 'p', endpoint: 'https://x/v1', model: 'm', fetchImpl }, [message]), error => error.category === 'provider_refusal');
  assert.equal(calls, 1);
});

test('disabled provider is refused without trying others', async () => {
  const service = new ChatService(createDefaultRegistry(), new Telemetry());
  await assert.rejects(() => service.send({ id: 'p', adapter: 'openai-compatible', enabled: false, model: 'm' }, [message]), error => error.category === 'invalid_request' && /disabled/i.test(error.message));
});

test('unknown adapter fails closed', async () => {
  const service = new ChatService(createDefaultRegistry(), new Telemetry());
  await assert.rejects(() => service.send({ id: 'p', adapter: 'nope', enabled: true, model: 'm' }, [message]), error => error.category === 'invalid_request' && /No adapter registered/.test(error.message));
});

// ---------- Milestone 2: headers, errors, usage, cancellation, streams ----------
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const baseConfig = (overrides = {}) => ({ id: 'p', endpoint: 'https://x/v1', model: 'm', ...overrides });

test('reserved headers can never override Authorization, Host or forwarding headers', async () => {
  let headers = null;
  const fetchImpl = async (url, init) => { headers = init.headers; return jsonResponse({ choices: [{ message: { content: 'ok' } }] }); };
  await new OpenAICompatibleAdapter().sendMessage(baseConfig({
    apiKey: 'real-key', fetchImpl,
    customHeaders: { Authorization: 'Bearer attacker', Host: 'evil.test', Cookie: 'session=1', 'X-Forwarded-For': '1.2.3.4', 'X-Trace': 'yes' },
  }), [message]);
  assert.equal(headers.Authorization, 'Bearer real-key');
  assert.equal(headers.Host, undefined);
  assert.equal(headers.Cookie, undefined);
  assert.equal(headers['x-forwarded-for'], undefined);
  assert.equal(headers['X-Trace'], 'yes');
});

test('custom header injection and invalid names are rejected in the adapter', async () => {
  const adapter = new OpenAICompatibleAdapter();
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl, customHeaders: { 'X-Bad': 'value\r\nInjected: 1' } }), [message]),
    error => error.category === 'invalid_request' && /line breaks/.test(error.message),
  );
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl, customHeaders: { 'Bad Name': 'x' } }), [message]),
    error => error.category === 'invalid_request',
  );
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl, customHeaders: '{not json' }), [message]),
    error => error.category === 'invalid_request',
  );
});

test('sanitizeCustomHeaders drops reserved names and keeps the rest', () => {
  assert.deepEqual(sanitizeCustomHeaders({ authorization: 'x', HOST: 'y', 'X-Org': 'acme' }), { 'X-Org': 'acme' });
  assert.equal(sanitizeCustomHeaders(''), undefined);
  assert.equal(sanitizeCustomHeaders({ Authorization: 'x' }), undefined);
});

test('402, 413, 415 and 451 map to explicit categories and codes', async () => {
  const adapter = new OpenAICompatibleAdapter();
  const cases = [
    [402, 'rate_limit', 'payment_required', false],
    [413, 'invalid_request', 'payload_too_large', false],
    [415, 'invalid_request', 'unsupported_media_type', false],
    [451, 'provider_refusal', 'unavailable_for_legal_reasons', false],
  ];
  for (const [status, category, code, retryable] of cases) {
    const fetchImpl = async () => jsonResponse({ error: { message: 'provider says no' } }, status);
    await assert.rejects(
      () => adapter.sendMessage(baseConfig({ fetchImpl }), [message]),
      error => error.category === category && error.code === code && error.status === status && error.retryable === retryable,
      `HTTP ${status} should be ${category}/${code}`,
    );
  }
});

test('404 distinguishes an endpoint miss from a missing model', async () => {
  const adapter = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl: async () => jsonResponse({ error: { message: 'model not found' } }, 404) }), [message]),
    error => error.category === 'model_unavailable',
  );
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl: async () => jsonResponse({ error: { message: 'unknown endpoint /v1/chat/completions' } }, 404) }), [message]),
    error => error.category === 'invalid_request' && error.code === 'endpoint_not_found',
  );
});

test('malformed JSON, missing choices and empty completions are explicit server errors', async () => {
  const adapter = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl: async () => new Response('not json at all', { status: 200 }) }), [message]),
    error => error.category === 'server_error' && error.code === 'malformed_json',
  );
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl: async () => jsonResponse({ id: 'x' }) }), [message]),
    error => error.category === 'server_error' && error.code === 'malformed_response',
  );
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }) }), [message]),
    error => error.category === 'server_error' && error.code === 'empty_completion',
  );
});

test('provider refusal fields are refusals; ordinary assistant text is not', async () => {
  const adapter = new OpenAICompatibleAdapter();
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl: async () => jsonResponse({ error: { code: 'content_policy_violation', message: 'blocked' } }) }), [message]),
    error => error.category === 'provider_refusal',
  );
  const answer = 'I cannot help with that refusal policy question — but here is the actual answer.';
  const result = await adapter.sendMessage(baseConfig({ fetchImpl: async () => jsonResponse({ choices: [{ message: { content: answer } }] }) }), [message]);
  assert.equal(result.ok, true);
  assert.equal(result.responseText, answer);
});

test('usage normalization preserves cached/reasoning tokens, extra fields and null vs zero', () => {
  const usage = normalizeUsage({
    prompt_tokens: 10, completion_tokens: 0, total_tokens: 10,
    prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 }, throughput: 12,
  });
  assert.equal(usage.promptTokens, 10);
  assert.equal(usage.completionTokens, 0);
  assert.equal(usage.cachedTokens, 4);
  assert.equal(usage.reasoningTokens, 2);
  assert.equal(usage.totalTokens, 10);
  assert.equal(usage.reportedCost, null);
  assert.equal(usage.extra.throughput, 12);
  assert.equal(normalizeUsage(null), null);

  const missing = normalizeUsage({ prompt_tokens: 3 });
  assert.equal(missing.completionTokens, null, 'missing is null, not zero');
  assert.equal(missing.cachedTokens, null);
});

test('cost is never invented when usage is missing and is labelled by source', async () => {
  const adapter = new OpenAICompatibleAdapter();
  const pricing = { inputPer1M: 1, outputPer1M: 2 };
  const noUsage = await adapter.sendMessage(baseConfig({ pricing, fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'hi' } }] }) }), [message]);
  assert.equal(noUsage.cost, null);
  assert.equal(noUsage.costSource, null);

  const estimated = await adapter.sendMessage(baseConfig({ pricing, fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }) }), [message]);
  assert.equal(estimated.cost, 1);
  assert.equal(estimated.costSource, 'estimated');

  const reported = await adapter.sendMessage(baseConfig({ pricing, fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.0042 } }) }), [message]);
  assert.equal(reported.cost, 0.0042);
  assert.equal(reported.costSource, 'reported');
});

test('cancelling mid-stream stops tokens, releases the reader and reports cancellation', async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')); },
    cancel() { cancelled = true; },
  });
  const abort = new AbortController();
  const tokens = [];
  const promise = new OpenAICompatibleAdapter().sendMessage(
    baseConfig({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: stream }) }),
    [message],
    { stream: true, signal: abort.signal, onToken: delta => { tokens.push(delta); abort.abort(); } },
  );
  await assert.rejects(promise, error => error.category === 'timeout' && error.cancelled === true && error.code === 'user_cancelled');
  assert.deepEqual(tokens, ['first']);
  assert.equal(cancelled, true, 'the reader must be released on cancellation');
});

test('a stream without [DONE] is returned but marked incomplete', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      controller.close();
    },
  });
  const result = await new OpenAICompatibleAdapter().sendMessage(
    baseConfig({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: stream }) }),
    [message], { stream: true },
  );
  assert.equal(result.responseText, 'partial');
  assert.equal(result.complete, false);
  assert.equal(result.terminatedBy, 'eof');
  assert.match(result.warning, /without \[DONE\]/);
});

test('a terminal finish_reason without [DONE] is treated as complete', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'));
      controller.close();
    },
  });
  const result = await new OpenAICompatibleAdapter().sendMessage(
    baseConfig({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: stream }) }),
    [message], { stream: true },
  );
  assert.equal(result.complete, true);
  assert.equal(result.terminatedBy, 'finish_reason');
  assert.equal(result.warning, undefined);
});

test('request timeout and stream idle timeout are reported distinctly', async () => {
  const adapter = new OpenAICompatibleAdapter();
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
  });
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl: hangingFetch }), [message], { timeoutMs: 20 }),
    error => error.category === 'timeout' && error.code === 'request_timeout' && /did not respond/.test(error.message),
  );
  const silent = new ReadableStream({ start() { /* never emits */ } });
  await assert.rejects(
    () => adapter.sendMessage(baseConfig({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: silent }) }), [message], { stream: true, timeoutMs: 20 }),
    error => error.category === 'timeout' && error.code === 'stream_idle_timeout' && /idle/i.test(error.message),
  );
});
