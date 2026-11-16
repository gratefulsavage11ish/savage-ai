#!/usr/bin/env node
// SAVAGE AI development server.
// - Encrypted credential vault (AES-256-GCM) + credential API
// - Real provider proxy (no fallback, SSRF-guarded, streamed when requested)
// - Static hosting for the frontend
// This is a DEVELOPMENT scaffold: add auth, KMS, rate limiting per user, and
// audit retention before production. See README.md.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { createDefaultRegistry } from './src/provider-registry.js';
import { ChatService } from './src/chat-service.js';
import { NormalizedError, ERROR_CATEGORIES } from './src/errors.js';
import { assertEndpointUrl, assertEndpointResolvesSafely } from './src/endpoint-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 1024 * 1024;

function parseKey(key) {
  const raw = String(key || '').trim();
  if (!raw) throw new Error('Missing credential key.');
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('SAVAGE_CREDENTIAL_KEY must be 32 bytes (64 hex characters, e.g. `openssl rand -hex 32`).');
  return buf;
}

class AesVault {
  constructor(key) { this.key = parseKey(key); }
  encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }
  decrypt(entry) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.ct, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new NormalizedError({ category: 'server_error', message: 'Credential vault could not be decrypted (wrong key or corrupt vault).' });
    }
  }
}

export class FileCredentialVault {
  constructor({ file, key }) {
    this.file = file; this.kind = 'encrypted-file-dev'; this.insecure = false; this.cipher = new AesVault(key);
    this.queue = Promise.resolve();
  }
  async #load() {
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')).entries || {}; }
    catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  }
  async #save(entries) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${crypto.randomBytes(6).toString('hex')}`;
    const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries });
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
  async set(id, value) {
    const run = this.queue.then(async () => { const entries = await this.#load(); entries[id] = this.cipher.encrypt(JSON.stringify(value ?? {})); await this.#save(entries); });
    this.queue = run.catch(() => {}); await run;
  }
  async get(id) { const entries = await this.#load(); return entries[id] ? JSON.parse(this.cipher.decrypt(entries[id])) : null; }
  async has(id) { return Boolean((await this.#load())[id]); }
  async delete(id) {
    const run = this.queue.then(async () => { const entries = await this.#load(); if (!entries[id]) return; delete entries[id]; await this.#save(entries); });
    this.queue = run.catch(() => {}); await run;
  }
  async list() { return Object.keys(await this.#load()); }
}

// Non-persistent fallback so `node server.mjs` starts without a key. Credentials
// are still encrypted in memory, but lost on restart. Never use in production.
export class MemoryCredentialVault {
  constructor({ key = crypto.randomBytes(32) } = {}) { this.map = new Map(); this.kind = 'memory-dev'; this.insecure = true; this.cipher = new AesVault(typeof key === 'string' ? key : key.toString('hex')); }
  async set(id, value) { this.map.set(id, this.cipher.encrypt(JSON.stringify(value ?? {}))); }
  async get(id) { return this.map.has(id) ? JSON.parse(this.cipher.decrypt(this.map.get(id))) : null; }
  async has(id) { return this.map.has(id); }
  async delete(id) { this.map.delete(id); }
  async list() { return [...this.map.keys()]; }
}

export function createVaultFromEnv(env = process.env, dataDir = path.join(__dirname, 'data')) {
  if (env.SAVAGE_CREDENTIAL_KEY) return new FileCredentialVault({ file: path.join(dataDir, 'vault.json'), key: env.SAVAGE_CREDENTIAL_KEY });
  return new MemoryCredentialVault();
}

export class AuditLog {
  constructor(file = null) { this.file = file; this.events = []; }
  async record(event) {
    const entry = { ts: new Date().toISOString(), ...event };
    this.events.push(entry);
    if (this.events.length > 1000) this.events = this.events.slice(-1000);
    if (this.file) {
      try { await fs.mkdir(path.dirname(this.file), { recursive: true }); await fs.appendFile(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch { /* audit must not break requests */ }
    }
  }
  summary() {
    const events = this.events;
    const ok = events.filter(e => e.outcome === 'ok').length;
    const byCategory = {};
    for (const e of events) if (e.category) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    return {
      requests: events.length, successes: ok, failures: events.length - ok,
      availability: events.length ? Number(((ok / events.length) * 100).toFixed(1)) : 100,
      avgLatencyMs: events.length ? Math.round(events.reduce((s, e) => s + (e.latencyMs || 0), 0) / events.length) : 0,
      totalCost: Number(events.reduce((s, e) => s + (e.cost || 0), 0).toFixed(6)),
      refusals: byCategory.provider_refusal || 0, rateLimits: byCategory.rate_limit || 0,
      byCategory,
    };
  }
  tail(limit = 50) { return this.events.slice(-limit).reverse(); }
}

export class RateLimiter {
  constructor({ windowMs = 60_000, max = 240 } = {}) { this.windowMs = windowMs; this.max = max; this.buckets = new Map(); }
  check(key) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) { bucket = { start: now, count: 0 }; this.buckets.set(key, bucket); if (this.buckets.size > 10_000) this.buckets.clear(); }
    bucket.count += 1;
    return { allowed: bucket.count <= this.max, remaining: Math.max(0, this.max - bucket.count), retryAfterMs: this.windowMs - (now - bucket.start) };
  }
}

const STATUS_BY_CATEGORY = {
  invalid_request: 400, authentication_error: 401, provider_refusal: 422, rate_limit: 429,
  model_unavailable: 404, timeout: 504, connection_error: 502, server_error: 502, unknown_error: 502,
};
const asNormalized = (err) => (err instanceof NormalizedError ? err : new NormalizedError({ category: 'unknown_error', message: err?.message || 'Unexpected server error.' }));

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}
const sendError = (res, err) => {
  const n = asNormalized(err);
  sendJson(res, n.status && n.status >= 400 ? n.status : STATUS_BY_CATEGORY[n.category] || 500, { ok: false, error: n.toJSON() });
};

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new NormalizedError({ category: 'invalid_request', message: 'Request body too large.' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new NormalizedError({ category: 'invalid_request', message: 'Request body must be valid JSON.' }); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const isPublicPath = (p) => p === '/index.html' || p === '/app.js' || p === '/styles.css' || (/^\/src\/[A-Za-z0-9._/-]+\.js$/.test(p) && !p.includes('..'));

export function createSavageServer({
  staticRoot = __dirname,
  vault = new MemoryCredentialVault(),
  audit = new AuditLog(path.join(staticRoot, 'data', 'audit.log')),
  registry = createDefaultRegistry(),
  fetchImpl = globalThis.fetch,
  allowedHosts = String(process.env.SAVAGE_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean),
  allowLoopback = process.env.SAVAGE_ALLOW_LOCAL !== '0',
  lookup = dns.lookup,
  rateLimiter = new RateLimiter(),
  logger = console,
} = {}) {
  const service = new ChatService(registry, null);

  function assertCsrf(req) {
    const site = String(req.headers['sec-fetch-site'] || '');
    if (site && !['same-origin', 'none'].includes(site)) throw new NormalizedError({ category: 'invalid_request', message: 'Cross-site request blocked.' });
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { throw new NormalizedError({ category: 'invalid_request', message: 'Invalid Origin header.' }); }
      if (originHost !== req.headers.host) throw new NormalizedError({ category: 'invalid_request', message: 'Origin does not match this server (CSRF protection).' });
    }
    if (req.method !== 'DELETE' && !String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
      throw new NormalizedError({ category: 'invalid_request', message: 'Content-Type must be application/json.' });
    }
  }

  function sanitizeHeaders(input) {
    if (input == null || input === '') return undefined;
    let headers = input;
    if (typeof headers === 'string') { try { headers = JSON.parse(headers); } catch { throw new NormalizedError({ category: 'invalid_request', message: 'Custom headers must be valid JSON.' }); } }
    if (typeof headers !== 'object' || Array.isArray(headers)) throw new NormalizedError({ category: 'invalid_request', message: 'Custom headers must be a JSON object.' });
    const banned = new Set(['authorization', 'host', 'content-length', 'connection', 'transfer-encoding', 'cookie', 'set-cookie', 'x-forwarded-for']);
    const out = {};
    for (const [key, value] of Object.entries(headers).slice(0, 50)) {
      if (banned.has(key.toLowerCase())) continue;
      if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) throw new NormalizedError({ category: 'invalid_request', message: `Invalid header name "${key}".` });
      out[key] = String(value).slice(0, 2048);
    }
    return Object.keys(out).length ? out : undefined;
  }

  function sanitizeProvider(input, providerId) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(providerId)) throw new NormalizedError({ category: 'invalid_request', message: 'Invalid provider id.' });
    if (!input || typeof input !== 'object') throw new NormalizedError({ category: 'invalid_request', message: 'Missing provider configuration.' });
    if (input.id !== providerId) throw new NormalizedError({ category: 'invalid_request', message: 'Provider id mismatch.' });
    const adapter = String(input.adapter || '');
    if (!registry.has(adapter)) throw new NormalizedError({ category: 'invalid_request', message: `Unknown adapter "${adapter}".` });
    const endpoint = String(input.endpoint || '').trim();
    if (!endpoint) throw new NormalizedError({ category: 'invalid_request', message: 'Provider endpoint is required.' });
    const model = input.model ? String(input.model).slice(0, 200) : '';
    let pricing = null;
    if (input.pricing) {
      const inputPer1M = Number(input.pricing.inputPer1M ?? 0), outputPer1M = Number(input.pricing.outputPer1M ?? 0);
      if (!Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M) || inputPer1M < 0 || outputPer1M < 0) throw new NormalizedError({ category: 'invalid_request', message: 'Invalid pricing configuration.' });
      pricing = { inputPer1M, outputPer1M };
    }
    const timeoutMs = Math.min(120_000, Math.max(1_000, Number(input.timeoutMs) || 60_000));
    return { id: providerId, name: String(input.name || providerId).slice(0, 120), adapter, endpoint, model, pricing, timeoutMs, enabled: true, customHeaders: sanitizeHeaders(input.customHeaders), fetchImpl };
  }

  function sanitizeMessages(input) {
    if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw new NormalizedError({ category: 'invalid_request', message: 'messages must be a non-empty array (max 100).' });
    let total = 0;
    const messages = input.map((m) => {
      if (!m || typeof m !== 'object') throw new NormalizedError({ category: 'invalid_request', message: 'Each message must be an object.' });
      if (!['system', 'user', 'assistant'].includes(m.role)) throw new NormalizedError({ category: 'invalid_request', message: 'Message role must be system, user or assistant.' });
      if (typeof m.content !== 'string' || !m.content) throw new NormalizedError({ category: 'invalid_request', message: 'Message content must be a non-empty string.' });
      total += m.content.length;
      if (total > 200_000) throw new NormalizedError({ category: 'invalid_request', message: 'Conversation is too large.' });
      return { role: m.role, content: m.content.slice(0, 32_000) };
    });
    return messages;
  }

  function sanitizeOptions(input = {}) {
    const options = { stream: Boolean(input.stream) };
    if (input.temperature != null) { const t = Number(input.temperature); if (Number.isFinite(t)) options.temperature = Math.min(2, Math.max(0, t)); }
    if (input.maxTokens != null) { const m = Number(input.maxTokens); if (Number.isFinite(m)) options.maxTokens = Math.min(32_000, Math.max(1, Math.floor(m))); }
    return options;
  }

  async function guardEndpoint(provider) {
    const url = assertEndpointUrl(provider.endpoint, { adapter: provider.adapter, allowedHosts, allowLoopback });
    await assertEndpointResolvesSafely(url, { lookup, allowLoopback });
    return url;
  }

  async function withCredential(provider) {
    const credential = await vault.get(provider.id).catch((err) => { throw asNormalized(err); });
    if (credential?.secret) provider.apiKey = credential.secret;
    const merged = { ...(credential?.headers || {}), ...(provider.customHeaders || {}) };
    if (Object.keys(merged).length) provider.customHeaders = merged;
    provider.hasCredential = Boolean(credential?.secret);
    return provider;
  }

  const sseWrite = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  async function proxyChat(req, res, provider, body, auditBase) {
    const messages = sanitizeMessages(body.messages);
    const options = sanitizeOptions(body.options);
    const started = Date.now();
    if (options.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      try {
        const result = await service.send(provider, messages, { ...options, onToken: (delta, full) => sseWrite(res, { type: 'token', text: delta, full }) });
        await audit.record({ ...auditBase, outcome: 'ok', latencyMs: result.latencyMs, usage: result.usage, cost: result.cost, requestId: result.requestId, streamed: true });
        sseWrite(res, { type: 'done', result });
      } catch (err) {
        const n = asNormalized(err);
        await audit.record({ ...auditBase, outcome: 'error', category: n.category, latencyMs: Date.now() - started, streamed: true });
        sseWrite(res, { type: 'error', error: n.toJSON() });
      }
      return res.end();
    }
    try {
      const result = await service.send(provider, messages, options);
      await audit.record({ ...auditBase, outcome: 'ok', latencyMs: result.latencyMs, usage: result.usage, cost: result.cost, requestId: result.requestId });
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      const n = asNormalized(err);
      await audit.record({ ...auditBase, outcome: 'error', category: n.category, latencyMs: Date.now() - started });
      throw n;
    }
  }

  async function handleApi(req, res, url) {
    const ip = req.socket.remoteAddress || 'unknown';
    const limit = rateLimiter.check(ip);
    if (!limit.allowed) { res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000))); throw new NormalizedError({ category: 'rate_limit', message: 'Too many requests. Slow down.' }); }
    if (req.method !== 'GET' && req.method !== 'HEAD') assertCsrf(req);

    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const resource = parts[1];

    if (resource === 'health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true, service: 'savage-ai', version: '2.0.0', mode: 'development',
        vault: vault.kind, persistent: vault.kind === 'encrypted-file-dev', auth: false,
        adapters: registry.list(), errorCategories: Object.values(ERROR_CATEGORIES),
        warnings: [
          'No authentication: anyone who can reach this server can use stored credentials.',
          ...(vault.insecure ? ['Credential vault is in-memory (set SAVAGE_CREDENTIAL_KEY to persist encrypted credentials).'] : []),
          ...(allowLoopback ? ['Loopback provider endpoints are enabled (SAVAGE_ALLOW_LOCAL=0 disables).'] : []),
        ],
      });
    }

    if (resource === 'credentials') {
      if (parts.length === 2 && req.method === 'GET') {
        const ids = await vault.list();
        return sendJson(res, 200, { ok: true, providers: ids.map(id => ({ id, configured: true })) });
      }
      const providerId = parts[2] ? decodeURIComponent(parts[2]) : '';
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(providerId)) throw new NormalizedError({ category: 'invalid_request', message: 'Invalid provider id.' });
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, id: providerId, configured: await vault.has(providerId) });
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        const secret = typeof body.secret === 'string' ? body.secret : '';
        if (secret.length > 8192) throw new NormalizedError({ category: 'invalid_request', message: 'Credential is too large.' });
        const headers = sanitizeHeaders(body.headers);
        if (!secret && !headers) throw new NormalizedError({ category: 'invalid_request', message: 'Nothing to store: provide a secret and/or headers.' });
        const existing = (await vault.get(providerId).catch(() => null)) || {};
        await vault.set(providerId, { secret: secret || existing.secret || '', headers: headers ?? existing.headers });
        await audit.record({ providerId, action: 'credentials.put', outcome: 'ok', ip, hasHeaders: Boolean(headers), secretUpdated: Boolean(secret) });
        return sendJson(res, 200, { ok: true, id: providerId, configured: true });
      }
      if (req.method === 'DELETE') {
        await vault.delete(providerId);
        await audit.record({ providerId, action: 'credentials.delete', outcome: 'ok', ip });
        return sendJson(res, 200, { ok: true, id: providerId, configured: false });
      }
      return sendJson(res, 405, { ok: false, error: { category: 'invalid_request', message: 'Method not allowed.' } });
    }

    if (resource === 'telemetry' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, summary: audit.summary(), events: audit.tail(50) });
    }

    if (resource === 'proxy') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { category: 'invalid_request', message: 'Method not allowed.' } });
      const providerId = decodeURIComponent(parts[2] || '');
      const action = parts[3];
      if (!['chat', 'models', 'test'].includes(action) || parts.length !== 4) throw new NormalizedError({ category: 'invalid_request', message: 'Unknown proxy route.' });
      const body = await readJson(req);
      const provider = sanitizeProvider(body.provider, providerId);
      await guardEndpoint(provider);
      await withCredential(provider);
      const auditBase = { providerId, action, adapter: provider.adapter, model: provider.model, ip };
      if (action === 'chat') return proxyChat(req, res, provider, body, auditBase);
      const started = Date.now();
      try {
        const result = action === 'models' ? await service.listModels(provider) : await service.test(provider);
        await audit.record({ ...auditBase, outcome: 'ok', latencyMs: result.latencyMs ?? Date.now() - started });
        return sendJson(res, 200, { ok: true, result });
      } catch (err) {
        const n = asNormalized(err);
        await audit.record({ ...auditBase, outcome: 'error', category: n.category, latencyMs: Date.now() - started });
        throw n;
      }
    }

    return sendJson(res, 404, { ok: false, error: { category: 'invalid_request', message: `Unknown API route: ${url.pathname}` } });
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: { category: 'invalid_request', message: 'Method not allowed.' } });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { ok: false, error: { category: 'invalid_request', message: 'Malformed path.' } }); }
    if (pathname === '/') pathname = '/index.html';
    if (!isPublicPath(pathname)) return sendJson(res, 404, { ok: false, error: { category: 'invalid_request', message: 'Not found.' } });
    const full = path.resolve(staticRoot, `.${pathname}`);
    const root = path.resolve(staticRoot);
    if (full !== root && !full.startsWith(root + path.sep)) return sendJson(res, 403, { ok: false, error: { category: 'invalid_request', message: 'Forbidden.' } });
    try {
      const content = await fs.readFile(full);
      const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'", 'Content-Length': content.length });
      return res.end(req.method === 'HEAD' ? undefined : content);
    } catch (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: { category: 'invalid_request', message: 'Not found.' } });
      throw err;
    }
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { return sendJson(res, 400, { ok: false, error: { category: 'invalid_request', message: 'Malformed URL.' } }); }
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await serveStatic(req, res, url);
    } catch (err) {
      const n = asNormalized(err);
      if (n.category !== 'invalid_request' || n.status) logger.warn?.(`[savage] ${n.category}: ${n.message}`);
      if (!res.headersSent) sendError(res, n);
      else res.end();
    }
  });

  server.requestTimeout = 130_000;
  server.headersTimeout = 70_000;
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const vault = createVaultFromEnv();
  if (vault.insecure) console.warn('[SAVAGE] SAVAGE_CREDENTIAL_KEY not set — using an in-memory vault. Credentials will NOT survive a restart.');
  const server = createSavageServer({ vault });
  const port = Number(process.env.PORT) || 3001;
  server.listen(port, '0.0.0.0', () => {
    console.log(`[SAVAGE] dev server listening on http://0.0.0.0:${port}`);
    console.log(`[SAVAGE] vault: ${vault.kind}${vault.insecure ? ' (set SAVAGE_CREDENTIAL_KEY for encrypted persistence)' : ''}`);
    console.log('[SAVAGE] no authentication enabled — development only.');
  });
}
