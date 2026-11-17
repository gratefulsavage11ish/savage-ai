import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry, createDefaultRegistry, BUILTIN_PROVIDERS } from '../src/provider-registry.js';
import { OpenAICompatibleAdapter, CustomOpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { HuggingFaceAdapter } from '../src/adapters/huggingface.js';
import { VeniceAdapter } from '../src/adapters/venice.js';
import { ChatService } from '../src/chat-service.js';
import { Telemetry } from '../src/telemetry.js';
import { NormalizedError } from '../src/errors.js';

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
