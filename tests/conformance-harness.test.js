import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import {
  CassetteError,
  createCassette,
  decodeChunks,
  encodeChunk,
  loadCassette,
  sanitizeHeaders,
  sha256,
  validateCassette,
  writeCassette,
} from '../tools/conformance/cassette.js';
import { createRecordingFetch } from '../tools/conformance/recorder.js';
import { ConformanceReplayError, createReplayFetch, createReplaySession } from '../tools/conformance/replay.js';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { tempDir } from './helpers.js';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startLocal(handler) {
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await handler(req, res, Buffer.concat(chunks).toString('utf8'));
    })().catch(error => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.destroy(error);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function localCassette(upstream, interactions, overrides = {}) {
  return createCassette({
    provenance: {
      kind: 'local',
      provider: 'local-test',
      adapter: 'openai-compatible',
      endpoint: `${upstream.url}/v1`,
      model: 'm',
      auth: 'env:TEST_KEY',
      note: 'Local test double, not real provider traffic.',
      ...overrides,
    },
    interactions,
  });
}

test('cassette chunk encoding preserves split UTF-8 byte-for-byte', () => {
  const bytes = Buffer.from('AéB', 'utf8');
  const first = encodeChunk(bytes.subarray(0, 2)); // ends mid-codepoint
  const second = encodeChunk(bytes.subarray(2));
  assert.ok(first.base64, 'invalid UTF-8 must be stored as base64');
  assert.ok(second.base64, 'invalid UTF-8 must be stored as base64');
  assert.deepEqual(Buffer.concat(decodeChunks([first, second])), bytes);
  assert.deepEqual(encodeChunk(Buffer.from('plain', 'utf8')), { text: 'plain' });
});

test('sensitive headers and secret-bearing values are redacted', () => {
  const result = sanitizeHeaders({
    Authorization: 'Bearer super-secret-key',
    Cookie: 'session=abc',
    'X-Trace': 'contains super-secret-key',
    'Content-Type': 'application/json',
  }, { secrets: ['super-secret-key'], redactHeaderNames: ['x-private'] });
  assert.equal(result.headers.authorization, '[REDACTED]');
  assert.equal(result.headers.cookie, '[REDACTED]');
  assert.equal(result.headers['x-trace'], '[REDACTED]');
  assert.equal(result.headers['content-type'], 'application/json');
  assert.ok(result.redacted >= 3);
});

test('a recorded JSON response replays byte-faithfully without the credential', async () => {
  const payload = {
    id: 'req_local',
    choices: [{ message: { content: 'hello from local' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };
  let upstreamHeaders;
  const upstream = await startLocal((req, res) => {
    upstreamHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_local' });
    res.end(JSON.stringify(payload));
  });
  const dir = await tempDir('savage-cassette-');
  const file = path.join(dir, 'json.json');
  try {
    const recorder = createRecordingFetch({ secrets: ['super-secret-key'] });
    const config = {
      id: 'local-test',
      endpoint: `${upstream.url}/v1`,
      model: 'm',
      apiKey: 'super-secret-key',
      customHeaders: { 'X-Trace': 'trace-1' },
      fetchImpl: recorder,
    };
    const messages = [{ role: 'user', content: 'hi' }];
    const first = await new OpenAICompatibleAdapter().sendMessage(config, messages, { maxTokens: 16 });
    await recorder.flush();

    assert.equal(upstreamHeaders.authorization, 'Bearer super-secret-key');
    assert.equal(first.responseText, 'hello from local');
    assert.equal(first.usage.totalTokens, 6);
    assert.equal(first.requestId, 'req_local');

    await writeCassette(file, localCassette(upstream, recorder.interactions), { secrets: ['super-secret-key'] });
    const raw = await fs.readFile(file, 'utf8');
    assert.ok(!raw.includes('super-secret-key'), 'the cassette must not contain the credential');
    const stored = JSON.parse(raw);
    assert.equal(stored.interactions[0].request.headers.authorization, '[REDACTED]');
    assert.equal(stored.interactions[0].request.headers['x-trace'], 'trace-1');
    assert.equal(
      Buffer.concat(decodeChunks(stored.interactions[0].response.chunks)).toString('utf8'),
      JSON.stringify(payload),
    );

    const session = createReplaySession(await loadCassette(file));
    const second = await new OpenAICompatibleAdapter().sendMessage(
      session.provider({ fetchImpl: session.fetch }), session.messages(), session.options(),
    );
    assert.equal(second.responseText, first.responseText);
    assert.deepEqual(second.usage, first.usage);
    assert.equal(second.requestId, first.requestId);
    session.assertConsumed();
  } finally {
    await upstream.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a recorded SSE stream replays the same tokens and chunk boundaries', async () => {
  const frames = [
    'data: {"id":"s1","choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"id":"s1","choices":[{"delta":{"content":"lo"}}],"usage":{"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ];
  const upstream = await startLocal(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer super-secret-key');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frames[0]);
    await delay(10);
    res.write(frames[1]);
    await delay(10);
    res.end(frames[2]);
  });
  const dir = await tempDir('savage-cassette-');
  const file = path.join(dir, 'stream.json');
  try {
    const recorder = createRecordingFetch({ secrets: ['super-secret-key'] });
    const messages = [{ role: 'user', content: 'hi' }];
    const tokens = [];
    const result = await new OpenAICompatibleAdapter().sendMessage({
      id: 'local-test',
      endpoint: `${upstream.url}/v1`,
      model: 'm',
      apiKey: 'super-secret-key',
      fetchImpl: recorder,
    }, messages, { stream: true, maxTokens: 16, onToken: delta => tokens.push(delta) });
    await recorder.flush();

    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.equal(result.responseText, 'Hello');
    assert.equal(result.complete, true);
    assert.equal(result.terminatedBy, 'done');
    assert.equal(result.usage.totalTokens, 7);

    await writeCassette(file, localCassette(upstream, recorder.interactions), { secrets: ['super-secret-key'] });
    const stored = await loadCassette(file);
    const body = Buffer.concat(decodeChunks(stored.interactions[0].response.chunks)).toString('utf8');
    assert.equal(body, frames.join(''));
    assert.equal(stored.interactions[0].response.headers['content-type'], 'text/event-stream');

    const session = createReplaySession(stored);
    const replayTokens = [];
    const replayed = await new OpenAICompatibleAdapter().sendMessage(
      session.provider({ fetchImpl: session.fetch }),
      session.messages(),
      { ...session.options(), onToken: delta => replayTokens.push(delta) },
    );
    assert.deepEqual(replayTokens, tokens);
    assert.equal(replayed.responseText, result.responseText);
    assert.equal(replayed.complete, true);
    assert.equal(replayed.usage.totalTokens, 7);
    session.assertConsumed();
  } finally {
    await upstream.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('response bodies are scrubbed when a provider echoes the credential', async () => {
  const upstream = await startLocal((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid key super-secret-key' } }));
  });
  const dir = await tempDir('savage-cassette-');
  const file = path.join(dir, 'echo.json');
  try {
    const recorder = createRecordingFetch({ secrets: ['super-secret-key'] });
    await assert.rejects(
      () => new OpenAICompatibleAdapter().sendMessage({
        id: 'local-test',
        endpoint: `${upstream.url}/v1`,
        model: 'm',
        apiKey: 'super-secret-key',
        fetchImpl: recorder,
      }, [{ role: 'user', content: 'hi' }]),
      error => error.category === 'authentication_error',
    );
    await recorder.flush();
    await writeCassette(file, localCassette(upstream, recorder.interactions), { secrets: ['super-secret-key'] });
    const raw = await fs.readFile(file, 'utf8');
    assert.ok(!raw.includes('super-secret-key'));
    const stored = JSON.parse(raw);
    const body = Buffer.concat(decodeChunks(stored.interactions[0].response.chunks)).toString('utf8');
    assert.match(body, /\[REDACTED\]/);
  } finally {
    await upstream.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the writer refuses a cassette that still contains a secret', async () => {
  const dir = await tempDir('savage-cassette-');
  const file = path.join(dir, 'leak.json');
  try {
    const cassette = createCassette({
      provenance: {
        kind: 'local', provider: 'local-test', adapter: 'openai-compatible',
        endpoint: 'https://example.test/v1', model: 'm', auth: 'env:TEST_KEY',
      },
      interactions: [{
        request: { method: 'GET', url: 'https://example.test/v1/models', headers: { authorization: '[REDACTED]' }, bodyText: null, bodyHash: null },
        response: { status: 200, statusText: 'OK', headers: {}, chunks: [encodeChunk(Buffer.from('leaked super-secret-key'))], bytes: 24, truncated: false },
        timingMs: 1,
      }],
    });
    await assert.rejects(
      () => writeCassette(file, cassette, { secrets: ['super-secret-key'] }),
      error => error instanceof CassetteError && /credential value/.test(error.message),
    );
    assert.equal(await fs.access(file).then(() => true, () => false), false);

    const urlLeak = structuredClone(cassette);
    urlLeak.interactions[0].request.url = 'https://example.test/v1/models?key=super-secret-key';
    urlLeak.interactions[0].response.chunks = [encodeChunk(Buffer.from('ok'))];
    await assert.rejects(
      () => writeCassette(path.join(dir, 'url-leak.json'), urlLeak, { secrets: ['super-secret-key'] }),
      error => error instanceof CassetteError && /credential value/.test(error.message),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('replay is strict and never falls back to the network', async () => {
  const body = '{"model":"m"}';
  const cassette = createCassette({
    provenance: {
      kind: 'local', provider: 'local-test', adapter: 'openai-compatible',
      endpoint: 'https://example.test/v1', model: 'm', auth: 'none',
    },
    interactions: [{
      request: {
        method: 'POST', url: 'https://example.test/v1/chat/completions',
        headers: { 'content-type': 'application/json' }, bodyText: body, bodyHash: sha256(Buffer.from(body)),
      },
      response: { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, chunks: [encodeChunk(Buffer.from('{"choices":[]}'))], bytes: 14, truncated: false },
      timingMs: 1,
    }],
  });
  const replay = createReplayFetch(cassette);
  await assert.rejects(
    () => replay('https://not-recorded.test/v1/chat/completions', { method: 'POST', body }),
    error => error instanceof ConformanceReplayError && /never falls back/.test(error.message),
  );
  await assert.rejects(
    () => replay('https://example.test/v1/chat/completions', { method: 'POST', body: '{"model":"other"}' }),
    error => error instanceof ConformanceReplayError && /body must match/.test(error.message),
  );
  const response = await replay('https://example.test/v1/chat/completions', { method: 'POST', body });
  assert.equal(await response.text(), '{"choices":[]}');
  await assert.rejects(
    () => replay('https://example.test/v1/chat/completions', { method: 'POST', body }),
    error => error instanceof ConformanceReplayError && /No unused recorded response/.test(error.message),
  );
});

test('cassette validation rejects broken files and body-hash mismatches', async () => {
  assert.throws(() => validateCassette({ schemaVersion: 99 }), CassetteError);
  const cassette = createCassette({
    provenance: {
      kind: 'local', provider: 'local-test', adapter: 'openai-compatible',
      endpoint: 'https://example.test/v1', model: 'm', auth: 'none',
    },
    interactions: [{
      request: { method: 'GET', url: 'https://example.test/v1/models', headers: {}, bodyText: null, bodyHash: null },
      response: { status: 200, statusText: 'OK', headers: {}, chunks: [], bytes: 0, truncated: false },
      timingMs: 1,
    }],
  });
  const broken = structuredClone(cassette);
  broken.interactions[0].request.bodyText = '{"model":"m"}';
  assert.throws(() => validateCassette(broken), /bodyHash/);

  const dir = await tempDir('savage-cassette-');
  try {
    const file = path.join(dir, 'broken.json');
    await fs.writeFile(file, '{not json');
    await assert.rejects(() => loadCassette(file), CassetteError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the recording CLI documents environment-only credentials', async () => {
  const { stdout } = await run(process.execPath, [path.join(projectRoot, 'tools/conformance/record.mjs'), '--help']);
  assert.match(stdout, /--key-env/);
  assert.match(stdout, /never a flag/);
  assert.match(stdout, /HF_TOKEN/);
});
