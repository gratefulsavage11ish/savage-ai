import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

// A cassette is a sanitized, replayable recording of real provider HTTP
// traffic. It stores request identity (method/url/body hash), redacted request
// headers, the provider's status/headers and the exact response bytes split
// into the chunks the network delivered. Replay never calls fetch.
export const CASSETTE_SCHEMA_VERSION = 1;
export const CASSETTE_KIND = 'savage-provider-conformance-cassette';
export const PROVENANCE_KINDS = Object.freeze(['live', 'local', 'synthetic']);

export class CassetteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CassetteError';
  }
}

// Header names whose values are removed before a cassette reaches disk.
const SENSITIVE_HEADER = /(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|auth[-_]?token|access[-_]?token|secret|password|credential|signature|session)/i;

export function isSensitiveHeader(name) {
  return SENSITIVE_HEADER.test(String(name || ''));
}

export function normalizeSecrets(secrets = []) {
  return [...new Set(secrets.map(value => String(value ?? '')).filter(value => value.length >= 4))];
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function') {
    return [...headers.entries()].map(([name, value]) => [String(name), String(value)]);
  }
  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => [String(name), String(value)]);
  }
  const entries = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) entries.push([String(name), String(item)]);
    else entries.push([String(name), String(value)]);
  }
  return entries;
}

export function redactText(value, secrets = []) {
  let text = String(value ?? '');
  let count = 0;
  for (const secret of normalizeSecrets(secrets)) {
    const parts = text.split(secret);
    if (parts.length > 1) {
      count += parts.length - 1;
      text = parts.join('[REDACTED]');
    }
  }
  return { value: text, count };
}

export function containsSecret(value, secrets = []) {
  const text = String(value ?? '');
  return normalizeSecrets(secrets).some(secret => text.includes(secret));
}

export function redactBytes(value, secrets = []) {
  let buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let count = 0;
  for (const secret of normalizeSecrets(secrets)) {
    const needle = Buffer.from(secret, 'utf8');
    if (!needle.length) continue;
    const pieces = [];
    let cursor = 0;
    while (true) {
      const found = buffer.indexOf(needle, cursor);
      if (found === -1) break;
      pieces.push(buffer.subarray(cursor, found), Buffer.from('[REDACTED]', 'utf8'));
      cursor = found + needle.length;
      count += 1;
    }
    if (pieces.length) {
      pieces.push(buffer.subarray(cursor));
      buffer = Buffer.concat(pieces);
    }
  }
  return { buffer, count };
}

export function sanitizeHeaders(headers, { secrets = [], redactHeaderNames = [] } = {}) {
  const explicit = new Set(redactHeaderNames.map(name => String(name).toLowerCase()));
  const filtered = {};
  let redacted = 0;
  let replacements = 0;
  for (const [rawName, rawValue] of headerEntries(headers)) {
    const name = rawName.toLowerCase();
    const value = String(rawValue);
    if (explicit.has(name) || isSensitiveHeader(name) || containsSecret(value, secrets)) {
      filtered[name] = '[REDACTED]';
      redacted += 1;
      continue;
    }
    const result = redactText(value, secrets);
    filtered[name] = result.value;
    replacements += result.count;
  }
  return { headers: filtered, redacted, replacements };
}

export function bodyBytes(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  throw new CassetteError(`Unsupported request body type for conformance recording: ${Object.prototype.toString.call(body)}`);
}

export function bodyHash(body) {
  const bytes = bodyBytes(body);
  return bytes === null ? null : sha256(bytes);
}

// Prefer readable UTF-8 chunks. A chunk that split a multi-byte character (valid
// in SSE traffic) is stored as base64 so replay is byte-exact.
export function encodeChunk(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) ? { text } : { base64: buffer.toString('base64') };
}

export function decodeChunks(chunks = []) {
  return chunks.map(chunk => {
    if (typeof chunk === 'string') return Buffer.from(chunk, 'base64');
    if (chunk && typeof chunk.text === 'string') return Buffer.from(chunk.text, 'utf8');
    if (chunk && typeof chunk.base64 === 'string') return Buffer.from(chunk.base64, 'base64');
    throw new CassetteError('Cassette contains an invalid response chunk.');
  });
}

function fail(message) {
  throw new CassetteError(message);
}

export function validateCassette(cassette) {
  if (!cassette || typeof cassette !== 'object' || Array.isArray(cassette)) fail('Cassette must be a JSON object.');
  if (cassette.schemaVersion !== CASSETTE_SCHEMA_VERSION) fail(`Unsupported cassette schemaVersion: ${cassette.schemaVersion}.`);
  if (cassette.kind !== CASSETTE_KIND) fail('This file is not a SAVAGE provider-conformance cassette.');
  if (typeof cassette.recordedAt !== 'string' || Number.isNaN(Date.parse(cassette.recordedAt))) fail('Cassette recordedAt must be an ISO timestamp.');

  const provenance = cassette.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) fail('Cassette provenance is missing.');
  if (!PROVENANCE_KINDS.includes(provenance.kind)) fail(`provenance.kind must be one of: ${PROVENANCE_KINDS.join(', ')}.`);
  for (const field of ['provider', 'adapter', 'endpoint', 'model']) {
    if (typeof provenance[field] !== 'string' || !provenance[field]) fail(`provenance.${field} must be a non-empty string.`);
  }
  if (typeof provenance.auth !== 'string' || !provenance.auth) fail('provenance.auth must be a string (e.g. "none" or "env:HF_TOKEN").');

  if (!Array.isArray(cassette.interactions) || cassette.interactions.length === 0) fail('Cassette must contain at least one interaction.');
  cassette.interactions.forEach((interaction, index) => {
    const label = `interaction ${index}`;
    if (!interaction || typeof interaction !== 'object') fail(`${label} must be an object.`);
    const request = interaction.request;
    const response = interaction.response;
    if (!request || typeof request !== 'object') fail(`${label} request is missing.`);
    if (typeof request.method !== 'string' || !request.method) fail(`${label} request.method is missing.`);
    if (typeof request.url !== 'string' || !request.url) fail(`${label} request.url is missing.`);
    if (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers)) fail(`${label} request.headers must be an object.`);
    if (request.bodyText !== null && typeof request.bodyText !== 'string') fail(`${label} request.bodyText must be a string or null.`);
    if (request.bodyHash !== null && !/^[a-f0-9]{64}$/.test(String(request.bodyHash))) fail(`${label} request.bodyHash must be a sha256 hex digest or null.`);
    const expectedHash = request.bodyText === null ? null : sha256(Buffer.from(request.bodyText, 'utf8'));
    if (request.bodyHash !== expectedHash) fail(`${label} request.bodyHash does not match bodyText.`);

    if (!response || typeof response !== 'object') fail(`${label} response is missing.`);
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) fail(`${label} response.status is invalid.`);
    if (!response.headers || typeof response.headers !== 'object' || Array.isArray(response.headers)) fail(`${label} response.headers must be an object.`);
    if (!Array.isArray(response.chunks)) fail(`${label} response.chunks must be an array.`);
    try { decodeChunks(response.chunks); } catch (error) { fail(`${label}: ${error.message}`); }
  });
  return cassette;
}

export function createCassette({ provenance = {}, interactions = [], recordedAt = new Date().toISOString() } = {}) {
  const cassette = {
    schemaVersion: CASSETTE_SCHEMA_VERSION,
    kind: CASSETTE_KIND,
    recordedAt,
    provenance: {
      kind: provenance.kind,
      provider: provenance.provider,
      adapter: provenance.adapter,
      endpoint: provenance.endpoint,
      model: provenance.model,
      auth: provenance.auth || 'none',
      ...(provenance.note ? { note: provenance.note } : {}),
    },
    interactions,
  };
  validateCassette(cassette);
  return cassette;
}

function assertNoSecrets(cassette, secrets) {
  const normalized = normalizeSecrets(secrets);
  if (!normalized.length) return;
  const parts = [JSON.stringify(cassette.provenance)];
  for (const interaction of cassette.interactions) {
    parts.push(
      interaction.request.url,
      interaction.request.bodyText || '',
      JSON.stringify(interaction.request.headers),
      JSON.stringify(interaction.response.headers),
    );
    parts.push(...decodeChunks(interaction.response.chunks).map(chunk => chunk.toString('utf8')));
  }
  const haystack = parts.join('\n');
  if (normalized.some(secret => haystack.includes(secret))) {
    // Never include the credential in the error.
    throw new CassetteError('Refusing to write cassette: a credential value was found in the recording.');
  }
}

export async function writeCassette(file, cassette, { secrets = [] } = {}) {
  validateCassette(cassette);
  assertNoSecrets(cassette, secrets);
  const text = `${JSON.stringify(cassette, null, 2)}\n`;
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, text, { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { file, bytes: Buffer.byteLength(text) };
}

export async function loadCassette(file) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new CassetteError(`Could not read cassette ${file}: ${error.message}`);
  }
  return validateCassette(parsed);
}
