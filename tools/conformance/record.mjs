#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseArgs } from 'node:util';
import { BUILTIN_PROVIDERS, createDefaultRegistry } from '../../src/provider-registry.js';
import { createCassette, isSensitiveHeader, writeCassette } from './cassette.js';
import { createRecordingFetch } from './recorder.js';

const HELP = `Record real provider traffic into a sanitized conformance cassette.

Usage:
  npm run record:conformance -- --provider <id> [options]

Examples:
  # Keyless public OpenAI-compatible endpoint
  npm run record:conformance -- --provider pollinations \\
    --adapter openai-compatible --endpoint https://text.pollinations.ai/openai \\
    --model openai-fast --operation chat --out tests/conformance/cassettes/pollinations/chat.json

  # Authenticated provider: the key is read from the environment, never a flag
  HF_TOKEN=... npm run record:conformance -- --provider huggingface \\
    --operation chat --stream --out tests/conformance/cassettes/huggingface/chat.json

Options:
  --provider <id>        Provider id used in the cassette provenance (required)
  --adapter <id>         Adapter id (default: the built-in adapter for the provider)
  --endpoint <url>       Provider base URL (default: built-in provider endpoint)
  --model <id>           Model id (default: built-in provider model)
  --operation <name>     "chat" (default) or "models"
  --stream               Record a streaming chat request
  --out <path>           Cassette path (default: tests/conformance/cassettes/<provider>/<operation>.json)
  --prompt <text>        Chat prompt (default: "Reply with exactly: SAVAGE conformance check.")
  --max-tokens <n>       Chat max_tokens (default: 32)
  --timeout <ms>         Request timeout (default: 60000)
  --key-env <VAR>        Environment variable holding the provider key
  --header "Name: value" Extra request header (repeatable)
  --redact-header <name> Header to redact (repeatable)
  --note <text>          Provenance note stored in the cassette
  --force                Replace an existing cassette
  -h, --help             Show this help

Keys are only read from environment variables (--key-env, SAVAGE_RECORD_KEY, or
provider conventions such as HF_TOKEN and VENICE_API_KEY). They are redacted
from the cassette; recording fails closed if a credential still appears.`;

function usageError(message) {
  throw new Error(`${message}\n\n${HELP}`);
}

function parseHeaders(values = []) {
  const headers = {};
  for (const raw of values) {
    const separator = raw.indexOf(':');
    if (separator <= 0) usageError(`Invalid --header "${raw}". Expected "Name: value".`);
    const name = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_\`|~-]{1,64}$/.test(name)) usageError(`Invalid header name "${name}".`);
    if (/[\r\n\0]/.test(value)) usageError(`Header "${name}" must not contain line breaks.`);
    headers[name] = value;
  }
  return headers;
}

function resolveKey(adapterId, requestedVariable) {
  if (requestedVariable) {
    const value = process.env[requestedVariable];
    if (!value) usageError(`Environment variable ${requestedVariable} is not set.`);
    return { key: value, variable: requestedVariable };
  }
  const candidates = ['SAVAGE_RECORD_KEY'];
  if (adapterId === 'huggingface') candidates.push('HF_TOKEN', 'HUGGINGFACE_API_KEY');
  else if (adapterId === 'venice') candidates.push('VENICE_API_KEY');
  else candidates.push('OPENAI_API_KEY');
  const variable = candidates.find(name => process.env[name]);
  return { key: variable ? process.env[variable] : undefined, variable: variable || null };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: 'string' },
      adapter: { type: 'string' },
      endpoint: { type: 'string' },
      model: { type: 'string' },
      operation: { type: 'string', default: 'chat' },
      stream: { type: 'boolean', default: false },
      out: { type: 'string' },
      prompt: { type: 'string', default: 'Reply with exactly: SAVAGE conformance check.' },
      'max-tokens': { type: 'string', default: '32' },
      timeout: { type: 'string', default: '60000' },
      'key-env': { type: 'string' },
      header: { type: 'string', multiple: true },
      'redact-header': { type: 'string', multiple: true },
      note: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const provider = values.provider;
  if (!provider) usageError('--provider is required.');
  const builtin = BUILTIN_PROVIDERS.find(item => item.id === provider);
  const adapterId = values.adapter || builtin?.adapter;
  if (!adapterId) usageError('--adapter is required when --provider is not a built-in provider.');
  const endpoint = values.endpoint || builtin?.endpoint;
  const model = values.model || builtin?.model;
  if (!endpoint) usageError('--endpoint is required (or use a built-in provider).');
  if (!model) usageError('--model is required (or use a built-in provider).');

  const operation = values.operation;
  if (operation !== 'chat' && operation !== 'models') usageError('--operation must be "chat" or "models".');
  if (operation === 'models' && values.stream) usageError('--stream only applies to --operation chat.');

  const maxTokens = Number(values['max-tokens']);
  const timeoutMs = Number(values.timeout);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) usageError('--max-tokens must be a positive integer.');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) usageError('--timeout must be a positive integer.');

  const customHeaders = parseHeaders(values.header || []);
  const redactHeaderNames = values['redact-header'] || [];
  const { key, variable } = resolveKey(adapterId, values['key-env']);

  const secrets = [];
  if (key) secrets.push(key);
  for (const [name, value] of Object.entries(customHeaders)) {
    if (isSensitiveHeader(name) || redactHeaderNames.some(item => item.toLowerCase() === name.toLowerCase())) secrets.push(value);
  }

  const recorder = createRecordingFetch({ secrets, redactHeaderNames });
  const registry = createDefaultRegistry();
  const adapter = registry.adapterFor({ adapter: adapterId });
  if (values.stream && !adapter.supportsStreaming) usageError(`Adapter "${adapterId}" does not support streaming.`);
  const config = {
    id: provider,
    adapter: adapterId,
    endpoint,
    model,
    ...(key ? { apiKey: key } : {}),
    ...(Object.keys(customHeaders).length ? { customHeaders } : {}),
    fetchImpl: recorder,
    timeoutMs,
  };

  let outcome;
  try {
    if (operation === 'models') {
      const result = await adapter.listModels(config);
      outcome = { ok: true, result };
    } else {
      const messages = [{ role: 'user', content: values.prompt }];
      const result = await adapter.sendMessage(config, messages, {
        stream: values.stream,
        maxTokens,
        timeoutMs,
        onToken: () => {},
      });
      outcome = { ok: true, result };
    }
  } catch (error) {
    outcome = { ok: false, error: adapter.normalizeError ? adapter.normalizeError(error) : error };
  }

  await recorder.flush();
  if (!recorder.interactions.length) {
    throw new Error('No provider response was recorded. Check the endpoint, network and adapter.');
  }
  if (recorder.stats.truncated) {
    throw new Error(`A response exceeded the ${16 * 1024 * 1024}-byte cassette limit and was truncated; refusing to write an incomplete cassette.`);
  }
  const incomplete = recorder.interactions.filter(interaction => interaction.response.recordError);
  if (incomplete.length) {
    throw new Error(`Recording an HTTP response body failed (${incomplete[0].response.recordError}); refusing to write an incomplete cassette.`);
  }

  const defaultName = operation === 'chat' && values.stream ? 'chat-stream' : operation;
  const output = path.resolve(values.out || `tests/conformance/cassettes/${provider.replace(/[^a-z0-9._-]/gi, '-')}/${defaultName}.json`);
  if (!values.force && await fs.access(output).then(() => true, () => false)) {
    usageError(`Cassette already exists: ${output}. Use --force to replace it.`);
  }

  const cassette = createCassette({
    provenance: {
      kind: 'live',
      provider,
      adapter: adapterId,
      endpoint,
      model,
      auth: variable ? `env:${variable}` : 'none',
      note: values.note || 'Captured from a live provider request.',
    },
    interactions: recorder.interactions,
  });
  const written = await writeCassette(output, cassette, { secrets });

  const relative = path.relative(process.cwd(), output);
  console.log(`Recorded ${recorder.interactions.length} interaction(s) → ${relative}`);
  console.log(`  provider: ${provider} (${adapterId}), model: ${model}`);
  console.log(`  operation: ${operation}${values.stream ? ' (stream)' : ''}`);
  console.log(`  auth: ${variable ? `env:${variable}` : 'none'}`);
  for (const interaction of recorder.interactions) {
    const size = interaction.response.bytes;
    const statusText = interaction.response.statusText ? ` ${interaction.response.statusText}` : '';
    console.log(`  response: HTTP ${interaction.response.status}${statusText}, ${size} byte(s)`);
  }
  if (outcome.ok) {
    if (operation === 'models') console.log(`  models: ${outcome.result.models.length}`);
    else console.log(`  result: ${outcome.result.responseText.length} character(s), streamed=${Boolean(outcome.result.streamed)}`);
  } else {
    const error = outcome.error;
    console.log(`  provider error: ${error.category}${error.code ? `/${error.code}` : ''} (HTTP ${error.status ?? 'n/a'})`);
  }
  console.log(`  redactions: ${recorder.stats.redactions}`);
  console.log(`  cassette: ${written.bytes} byte(s)`);
}

main().catch(error => {
  console.error(`record-conformance: ${error.message}`);
  process.exitCode = 1;
});
