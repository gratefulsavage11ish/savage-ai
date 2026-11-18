import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeChunks, loadCassette } from '../tools/conformance/cassette.js';
import { createReplaySession } from '../tools/conformance/replay.js';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { HuggingFaceAdapter } from '../src/adapters/huggingface.js';
import { ProviderRegistry } from '../src/provider-registry.js';
import { ChatService } from '../src/chat-service.js';
import { Telemetry } from '../src/telemetry.js';

const cassetteRoot = fileURLToPath(new URL('./conformance/cassettes', import.meta.url));

async function cassetteFiles() {
  const files = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.json')) files.push(full);
    }
  }
  await walk(cassetteRoot);
  return files.sort();
}

function relativeName(file) {
  return path.relative(cassetteRoot, file).split(path.sep).join('/');
}

async function cassette(name) {
  return loadCassette(path.join(cassetteRoot, name));
}

test('committed provider cassettes are valid and credential-free', async () => {
  const files = await cassetteFiles();
  assert.ok(files.length >= 3, 'expected several recorded provider cassettes');
  let live = 0;
  for (const file of files) {
    const name = relativeName(file);
    const recorded = await loadCassette(file);
    if (recorded.provenance.kind === 'live') live += 1;
    assert.ok(!Number.isNaN(Date.parse(recorded.recordedAt)), name);
    for (const interaction of recorded.interactions) {
      for (const [header, value] of Object.entries(interaction.request.headers)) {
        if (/authorization|api[-_]?key|cookie|token|secret/i.test(header)) {
          assert.equal(value, '[REDACTED]', `${name} ${header} must be redacted`);
        }
        assert.ok(!/Bearer\s+\S+/i.test(value), `${name} ${header} must not contain a bearer token`);
      }
    }
  }
  assert.ok(live >= 3, 'expected several live provider recordings');
});

test('live OpenAI-compatible model discovery replays without a key', async () => {
  const recorded = await cassette('pollinations/models.json');
  const session = createReplaySession(recorded);
  const result = await new OpenAICompatibleAdapter().listModels(session.provider({ fetchImpl: session.fetch }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map(model => model.id), ['openai-fast']);
  assert.match(recorded.interactions[0].request.url, /\/models$/);
  session.assertConsumed();
});

test('live keyless completion replays through the OpenAI-compatible adapter', async () => {
  const recorded = await cassette('pollinations/chat.json');
  const session = createReplaySession(recorded);
  const result = await new OpenAICompatibleAdapter().sendMessage(
    session.provider({ fetchImpl: session.fetch }), session.messages(), session.options(),
  );
  assert.equal(result.ok, true);
  assert.ok(result.responseText.trim().length > 0);
  assert.ok(result.usage.totalTokens > 0);
  assert.ok(result.requestId);
  assert.equal(result.model, recorded.provenance.model);
  assert.match(recorded.interactions[0].request.url, /\/chat\/completions$/);
  session.assertConsumed();
});

test('live streaming completion replays tokens and completion state', async () => {
  const recorded = await cassette('pollinations/chat-stream.json');
  const session = createReplaySession(recorded);
  const tokens = [];
  const result = await new OpenAICompatibleAdapter().sendMessage(
    session.provider({ fetchImpl: session.fetch }),
    session.messages(),
    { ...session.options(), onToken: delta => tokens.push(delta) },
  );
  assert.equal(result.streamed, true);
  assert.equal(result.complete, true);
  assert.equal(result.terminatedBy, 'done');
  assert.ok(tokens.length > 0);
  assert.equal(tokens.join(''), result.responseText);
  assert.match(recorded.interactions[0].response.headers['content-type'], /^text\/event-stream/);
  session.assertConsumed();
});

test('live Hugging Face 401 replays as authentication_error', async () => {
  const recorded = await cassette('huggingface/chat-unauthorized.json');
  const session = createReplaySession(recorded);
  await assert.rejects(
    () => new HuggingFaceAdapter().sendMessage(
      session.provider({ fetchImpl: session.fetch }), session.messages(), session.options(),
    ),
    error => error.category === 'authentication_error' && error.status === 401,
  );
  session.assertConsumed();
});

test('live rate-limit response is retryable and never falls back', async () => {
  const recorded = await cassette('llm7/chat-rate-limited.json');
  const session = createReplaySession(recorded);
  const registry = new ProviderRegistry().register(new OpenAICompatibleAdapter());
  const service = new ChatService(registry, new Telemetry());
  await assert.rejects(
    () => service.send(session.provider({ fetchImpl: session.fetch }), session.messages(), session.options()),
    error => (
      error.category === 'rate_limit'
      && error.status === 429
      && error.retryable === true
      && error.code === null
    ),
  );
  session.assertConsumed();
});

test('recorded responses retain the provider payload and headers', async () => {
  const recorded = await cassette('pollinations/chat.json');
  const interaction = recorded.interactions[0];
  const body = JSON.parse(Buffer.concat(decodeChunks(interaction.response.chunks)).toString('utf8'));
  assert.equal(body.object, 'chat.completion');
  assert.ok(Array.isArray(body.choices) && body.choices.length > 0);
  assert.ok(body.choices[0].message.content.length > 0);
  assert.match(interaction.response.headers['content-type'], /application\/json/);
});
