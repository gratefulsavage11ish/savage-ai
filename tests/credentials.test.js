import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { FileCredentialVault, MemoryCredentialVault, createVaultFromEnv } from '../server.mjs';
import { startSavage, api, tempDir } from './helpers.js';

test('vault encrypts at rest and decrypts after restart', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'vault.json');
  const key = crypto.randomBytes(32).toString('hex');
  const vault = new FileCredentialVault({ file, key });
  await vault.set('p1', { secret: 'sk-super-secret', headers: { 'X-Org': 'acme' } });
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('sk-super-secret'), 'plaintext secret must not be on disk');
  assert.ok(!raw.includes('acme'), 'plaintext headers must not be on disk');

  const reopened = new FileCredentialVault({ file, key });
  assert.deepEqual(await reopened.get('p1'), { secret: 'sk-super-secret', headers: { 'X-Org': 'acme' } });
  assert.equal(await reopened.has('p1'), true);
  assert.deepEqual(await reopened.list(), ['p1']);

  const wrongKey = new FileCredentialVault({ file, key: crypto.randomBytes(32).toString('hex') });
  await assert.rejects(() => wrongKey.get('p1'), error => error.category === 'server_error');

  await reopened.delete('p1');
  assert.equal(await reopened.get('p1'), null);
  assert.equal(await reopened.has('p1'), false);

  const reopenedAfterDelete = new FileCredentialVault({ file, key });
  assert.deepEqual(await reopenedAfterDelete.list(), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('vault rejects weak keys and supports an in-memory fallback', async () => {
  assert.throws(() => new FileCredentialVault({ file: '/tmp/x', key: 'short' }), /32 bytes/);
  const memory = new MemoryCredentialVault();
  await memory.set('p', { secret: 's' });
  assert.deepEqual(await memory.get('p'), { secret: 's' });
  assert.equal(memory.insecure, true);
  const fromEnv = createVaultFromEnv({});
  assert.equal(fromEnv.kind, 'memory-dev');
  await fromEnv.set('p', { secret: 's' });
  assert.deepEqual(await fromEnv.get('p'), { secret: 's' });
});

test('server never returns credential material and enforces CSRF/JSON', async () => {
  const ctx = await startSavage();
  try {
    let response = await api(ctx.base, '/api/credentials/p1', { method: 'PUT', body: { secret: 'sk-super-secret', headers: { 'X-Org': 'acme' } } });
    assert.equal(response.status, 200);
    assert.equal(response.json.configured, true);

    const raw = await fs.readFile(path.join(ctx.dir, 'vault.json'), 'utf8');
    assert.ok(!raw.includes('sk-super-secret'));
    assert.ok(!raw.includes('acme'));

    response = await api(ctx.base, '/api/credentials/p1', { method: 'GET' });
    assert.deepEqual(response.json, { ok: true, id: 'p1', configured: true });
    assert.ok(!response.text.includes('sk-super-secret'));

    response = await api(ctx.base, '/api/credentials', { method: 'GET' });
    assert.deepEqual(response.json.providers, [{ id: 'p1', configured: true }]);

    response = await api(ctx.base, '/api/credentials/p2', { method: 'PUT' });
    assert.equal(response.status, 400);

    response = await api(ctx.base, '/api/credentials/p2', { method: 'PUT', body: { secret: 'x' }, headers: { Origin: 'https://evil.test' } });
    assert.equal(response.status, 400);
    assert.match(response.json.error.message, /Origin/);

    response = await api(ctx.base, '/api/credentials/p2', { method: 'PUT', body: { secret: 'x' }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(response.status, 400);

    response = await api(ctx.base, '/api/credentials/p1', { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal(response.json.configured, false);

    response = await api(ctx.base, '/api/credentials/p1', { method: 'GET' });
    assert.equal(response.json.configured, false);
  } finally { await ctx.close(); }
});

test('updating a credential keeps the existing secret when only headers change', async () => {
  const ctx = await startSavage();
  try {
    await api(ctx.base, '/api/credentials/p1', { method: 'PUT', body: { secret: 'sk-keep', headers: { 'X-A': '1' } } });
    await api(ctx.base, '/api/credentials/p1', { method: 'PUT', body: { headers: { 'X-B': '2' } } });
    const stored = await ctx.vault.get('p1');
    assert.equal(stored.secret, 'sk-keep');
    assert.deepEqual(stored.headers, { 'X-B': '2' });
  } finally { await ctx.close(); }
});
