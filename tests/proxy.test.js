import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSavage, startUpstream, api } from './helpers.js';
import { ProviderRegistry } from '../src/provider-registry.js';
import { NormalizedError } from '../src/errors.js';

const providerFor = (upstream, overrides = {}) => ({
  id: 'p1', name: 'Test provider', adapter: 'openai-compatible',
  endpoint: `${upstream.url}/v1`, model: 'test-model', ...overrides,
});
const chatBody = (provider, options = {}) => ({ provider, messages: [{ role: 'user', content: 'hi' }], options });

test('health endpoint advertises adapters, vault mode and warnings', async () => {
  const ctx = await startSavage();
  try {
    const response = await api(ctx.base, '/api/health', { method: 'GET' });
    assert.equal(response.status, 200);
    assert.equal(response.json.service, 'savage-ai');
    assert.equal(response.json.auth, false);
    assert.equal(response.json.vault, 'encrypted-file-dev');
    assert.equal(response.json.adapters.length, 4);
    assert.ok(response.json.errorCategories.includes('provider_refusal'));
    assert.ok(response.json.warnings.some(w => /authentication/i.test(w)));
  } finally { await ctx.close(); }
});

test('proxy chat performs a real request, forwards the vaulted key and records telemetry', async () => {
  const upstream = await startUpstream(() => ({
    body: { id: 'req_1', choices: [{ message: { content: 'hello from upstream' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  }));
  const ctx = await startSavage();
  try {
    await api(ctx.base, '/api/credentials/p1', { method: 'PUT', body: { secret: 'vault-secret' } });
    const provider = providerFor(upstream, { pricing: { inputPer1M: 1, outputPer1M: 2 } });
    const response = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody(provider) });
    assert.equal(response.status, 200, response.text);
    const result = response.json.result;
    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'p1');
    assert.equal(result.model, 'test-model');
    assert.equal(result.responseText, 'hello from upstream');
    assert.equal(result.usage.totalTokens, 15);
    assert.equal(result.requestId, 'req_1');
    assert.equal(result.cost, 0.00002);
    assert.equal(typeof result.latencyMs, 'number');

    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer vault-secret');
    assert.equal(upstream.calls[0].body.model, 'test-model');

    const telemetry = await api(ctx.base, '/api/telemetry', { method: 'GET' });
    assert.ok(telemetry.json.summary.requests >= 1);
    assert.equal(telemetry.json.summary.totalCost, 0.00002);
  } finally { await upstream.close(); await ctx.close(); }
});

test('proxy streams SSE tokens and a final result', async () => {
  const frames = [
    'data: {"id":"s1","choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"id":"s1","choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const upstream = await startUpstream(() => ({ headers: { 'Content-Type': 'text/event-stream' }, raw: frames }));
  const ctx = await startSavage();
  try {
    const response = await fetch(`${ctx.base}/api/proxy/p1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.base },
      body: JSON.stringify(chatBody(providerFor(upstream), { stream: true })),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    const events = text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.replace(/^data:\s*/, '')));
    assert.ok(events.some(event => event.type === 'token' && event.text === 'Hel'));
    const done = events.find(event => event.type === 'done');
    assert.ok(done, 'stream must end with a done event');
    assert.equal(done.result.responseText, 'Hello');
    assert.equal(done.result.streamed, true);
  } finally { await upstream.close(); await ctx.close(); }
});

test('proxy model discovery and connection test', async () => {
  const upstream = await startUpstream(req => req.url.endsWith('/models') ? { body: { data: [{ id: 'alpha' }, { id: 'beta' }] } } : { status: 500, body: {} });
  const ctx = await startSavage();
  try {
    const models = await api(ctx.base, '/api/proxy/p1/models', { body: { provider: providerFor(upstream) } });
    assert.equal(models.status, 200);
    assert.deepEqual(models.json.result.models.map(m => m.id), ['alpha', 'beta']);

    const test = await api(ctx.base, '/api/proxy/p1/test', { body: { provider: providerFor(upstream) } });
    assert.equal(test.status, 200);
    assert.equal(test.json.result.ok, true);
    assert.equal(test.json.result.modelCount, 2);
  } finally { await upstream.close(); await ctx.close(); }
});

test('rate limits are normalized and never retried', async () => {
  const upstream = await startUpstream(() => ({ status: 429, body: { error: { message: 'slow down' } } }));
  const ctx = await startSavage();
  try {
    const response = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody(providerFor(upstream)) });
    assert.equal(response.status, 429);
    assert.equal(response.json.error.category, 'rate_limit');
    assert.equal(response.json.error.retryable, true);
    assert.equal(upstream.calls.length, 1, 'no automatic retry / fallback');
  } finally { await upstream.close(); await ctx.close(); }
});

test('refusals are distinct from failures and never fall back', async () => {
  const upstream = await startUpstream(() => ({ body: { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] } }));
  const ctx = await startSavage();
  try {
    const response = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody(providerFor(upstream)) });
    assert.equal(response.status, 422);
    assert.equal(response.json.error.category, 'provider_refusal');
    assert.equal(upstream.calls.length, 1);
    const telemetry = await api(ctx.base, '/api/telemetry', { method: 'GET' });
    assert.equal(telemetry.json.summary.refusals, 1);
  } finally { await upstream.close(); await ctx.close(); }
});

test('authentication and server errors map to distinct categories', async () => {
  const unauthorized = await startUpstream(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
  const failing = await startUpstream(() => ({ status: 500, body: { error: { message: 'boom' } } }));
  const ctx = await startSavage();
  try {
    const auth = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody(providerFor(unauthorized)) });
    assert.equal(auth.json.error.category, 'authentication_error');
    const server = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody(providerFor(failing)) });
    assert.equal(server.json.error.category, 'server_error');
  } finally { await unauthorized.close(); await failing.close(); await ctx.close(); }
});

test('connection failures are reported as connection_error', async () => {
  const ctx = await startSavage();
  try {
    const provider = { id: 'p1', adapter: 'openai-compatible', endpoint: 'http://127.0.0.1:1/v1', model: 'm' };
    const response = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody(provider) });
    assert.equal(response.status, 502);
    assert.equal(response.json.error.category, 'connection_error');
  } finally { await ctx.close(); }
});

test('SSRF protection: non-allowlisted hosts, private IPs, insecure HTTP and loopback are refused', async () => {
  const ctx = await startSavage();
  try {
    const evil = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody({ id: 'p1', adapter: 'openai-compatible', endpoint: 'https://evil.example.com/v1', model: 'm' }) });
    assert.equal(evil.status, 400);
    assert.match(evil.json.error.message, /not allowlisted/);

    const privateIp = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody({ id: 'p1', adapter: 'openai-compatible', endpoint: 'https://169.254.169.254/latest', model: 'm' }) });
    assert.equal(privateIp.status, 400);

    const insecure = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody({ id: 'p1', adapter: 'openai-compatible', endpoint: 'http://provider.example.com/v1', model: 'm' }) });
    assert.equal(insecure.status, 400);
    assert.match(insecure.json.error.message, /HTTP/);

    const traversal = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody({ id: 'p1', adapter: 'openai-compatible', endpoint: 'https://user:pass@example.com/v1', model: 'm' }) });
    assert.equal(traversal.status, 400);
  } finally { await ctx.close(); }

  const lockedDown = await startSavage({ allowLoopback: false });
  try {
    const loopback = await api(lockedDown.base, '/api/proxy/p1/chat', { body: chatBody({ id: 'p1', adapter: 'custom-openai', endpoint: 'http://127.0.0.1:11434/v1', model: 'm' }) });
    assert.equal(loopback.status, 400);
    assert.match(loopback.json.error.message, /Loopback/);
  } finally { await lockedDown.close(); }
});

test('provider id mismatch, unknown adapters and missing endpoints are rejected', async () => {
  const ctx = await startSavage();
  try {
    const mismatch = await api(ctx.base, '/api/proxy/p1/chat', { body: { provider: { id: 'other', adapter: 'openai-compatible', endpoint: 'https://x.test/v1', model: 'm' }, messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.json.error.message, /mismatch/);

    const unknown = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody({ id: 'p1', adapter: 'not-real', endpoint: 'https://x.test/v1', model: 'm' }) });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error.message, /Unknown adapter/);

    const noEndpoint = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody({ id: 'p1', adapter: 'openai-compatible', endpoint: '', model: 'm' }) });
    assert.equal(noEndpoint.status, 400);
  } finally { await ctx.close(); }
});

test('client custom headers cannot override Authorization', async () => {
  const upstream = await startUpstream(() => ({ body: { choices: [{ message: { content: 'ok' } }] } }));
  const ctx = await startSavage();
  try {
    await api(ctx.base, '/api/credentials/p1', { method: 'PUT', body: { secret: 'vault-secret' } });
    const provider = providerFor(upstream, { customHeaders: { Authorization: 'Bearer attacker', 'X-Trace': 'yes' } });
    const response = await api(ctx.base, '/api/proxy/p1/chat', { body: chatBody(provider) });
    assert.equal(response.status, 200);
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer vault-secret');
    assert.equal(upstream.calls[0].headers['x-trace'], 'yes');
  } finally { await upstream.close(); await ctx.close(); }
});

test('client disconnect aborts the upstream provider call', async () => {
  let aborted = false;
  const adapter = {
    id: 'fake', label: 'Fake', supportsStreaming: true, supportsListModels: true,
    async sendMessage(config, messages, options) {
      return await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new NormalizedError({ category: 'timeout', cancelled: true, message: 'cancelled by client' }));
        }, { once: true });
      });
    },
    normalizeError: error => error,
  };
  const ctx = await startSavage({ registry: new ProviderRegistry().register(adapter) });
  try {
    const controller = new AbortController();
    const request = fetch(`${ctx.base}/api/proxy/p1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.base },
      body: JSON.stringify(chatBody({ id: 'p1', adapter: 'fake', endpoint: 'http://127.0.0.1:1/v1', model: 'm' })),
      signal: controller.signal,
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    controller.abort();
    await assert.rejects(request);
    for (let attempt = 0; attempt < 40 && !aborted; attempt += 1) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(aborted, true, 'the server must abort the upstream call when the browser disconnects');
  } finally { await ctx.close(); }
});

test('a provider stream error is forwarded as a normalized SSE error event', async () => {
  const upstream = await startUpstream(() => ({ headers: { 'Content-Type': 'text/event-stream' }, raw: 'data: {"error":{"message":"upstream exploded"}}\n\n' }));
  const ctx = await startSavage();
  try {
    const response = await fetch(`${ctx.base}/api/proxy/p1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ctx.base },
      body: JSON.stringify(chatBody(providerFor(upstream), { stream: true })),
    });
    const text = await response.text();
    const events = text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.replace(/^data:\s*/, '')));
    const failure = events.find(event => event.type === 'error');
    assert.ok(failure, 'an error event must be sent instead of a silent close');
    assert.equal(failure.error.category, 'server_error');
  } finally { await upstream.close(); await ctx.close(); }
});

test('proxy strips reserved custom headers and rejects header injection', async () => {
  const upstream = await startUpstream(() => ({ body: { choices: [{ message: { content: 'ok' } }] } }));
  const ctx = await startSavage();
  try {
    const cleaned = await api(ctx.base, '/api/proxy/p1/chat', {
      body: chatBody(providerFor(upstream, { customHeaders: { Host: 'evil.test', Cookie: 'a=b', 'X-Trace': 'yes' } })),
    });
    assert.equal(cleaned.status, 200, cleaned.text);
    assert.notEqual(upstream.calls[0].headers.host, 'evil.test');
    assert.equal(upstream.calls[0].headers.cookie, undefined);
    assert.equal(upstream.calls[0].headers['x-trace'], 'yes');

    const injected = await api(ctx.base, '/api/proxy/p1/chat', {
      body: chatBody(providerFor(upstream, { customHeaders: { 'X-Bad': 'a\r\nInjected: 1' } })),
    });
    assert.equal(injected.status, 400);
    assert.match(injected.json.error.message, /line breaks/);
    assert.equal(upstream.calls.length, 1, 'no upstream call for a rejected header');
  } finally { await upstream.close(); await ctx.close(); }
});

test('static hosting exposes only public frontend files', async () => {
  const ctx = await startSavage();
  try {
    const index = await fetch(`${ctx.base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /SAVAGE/);
    assert.equal((await fetch(`${ctx.base}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/data/vault.json`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/tests/proxy.test.js`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/app.js`)).status, 200);
    assert.equal((await fetch(`${ctx.base}/src/provider-registry.js`)).status, 200);
  } finally { await ctx.close(); }
});
