import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSavageServer, FileCredentialVault, AuditLog, RateLimiter } from '../server.mjs';

export const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function tempDir(prefix = 'savage-test-') { return fs.mkdtemp(path.join(os.tmpdir(), prefix)); }

// Minimal fake provider. handler(req, parsedBody, call) -> { status, body, headers, raw }
export async function startUpstream(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = rawBody; }
    const call = { method: req.method, url: req.url, headers: req.headers, body, raw: rawBody };
    calls.push(call);
    const out = (await handler(req, body, call)) || {};
    res.writeHead(out.status || 200, { 'Content-Type': 'application/json', ...(out.headers || {}) });
    res.end(out.raw !== undefined ? out.raw : JSON.stringify(out.body ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`, baseUrl: `http://127.0.0.1:${port}/v1`, calls,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

export async function startSavage(overrides = {}) {
  const dir = await tempDir();
  const vault = overrides.vault || new FileCredentialVault({ file: path.join(dir, 'vault.json'), key: crypto.randomBytes(32).toString('hex') });
  const server = createSavageServer({
    staticRoot: projectRoot,
    vault,
    audit: new AuditLog(path.join(dir, 'audit.jsonl')),
    allowedHosts: ['127.0.0.1'],
    allowLoopback: true,
    rateLimiter: new RateLimiter({ max: 10_000 }),
    ...overrides,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, server, vault, dir,
    close: async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); },
  };
}

export async function api(base, pathname, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && method !== 'HEAD' ? { Origin: base } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { res, status: res.status, text, json };
}
