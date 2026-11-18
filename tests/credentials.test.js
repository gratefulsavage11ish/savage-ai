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

test('a corrupt vault fails closed and is never overwritten', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'vault.json');
  const corrupt = '{"version":1,"entries":{oops';
  await fs.writeFile(file, corrupt, { mode: 0o600 });
  const vault = new FileCredentialVault({ file, key: crypto.randomBytes(32).toString('hex') });

  await assert.rejects(
    () => vault.get('p1'),
    error => error.category === 'server_error' && error.code === 'vault_corrupt' && !/JSON|Unexpected|vault\.json/.test(error.message),
  );
  await assert.rejects(() => vault.set('p1', { secret: 'x' }), error => error.code === 'vault_corrupt');
  await assert.rejects(() => vault.delete('p1'), error => error.code === 'vault_corrupt');
  assert.equal(await fs.readFile(file, 'utf8'), corrupt, 'a corrupt vault must not be replaced with an empty one');
  await fs.rm(dir, { recursive: true, force: true });
});

test('an empty or truncated vault file is rejected rather than treated as empty', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'vault.json');
  const vault = new FileCredentialVault({ file, key: crypto.randomBytes(32).toString('hex') });
  for (const content of ['', '   ', '{"version":1,"entries":']) {
    await fs.writeFile(file, content, { mode: 0o600 });
    await assert.rejects(() => vault.list(), error => error.code === 'vault_corrupt', JSON.stringify(content));
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('a wrong key never leaks crypto detail and never rewrites the file', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'vault.json');
  const key = crypto.randomBytes(32).toString('hex');
  const vault = new FileCredentialVault({ file, key });
  await vault.set('p1', { secret: 'sk-secret' });
  const before = await fs.readFile(file, 'utf8');
  const wrong = new FileCredentialVault({ file, key: crypto.randomBytes(32).toString('hex') });
  await assert.rejects(
    () => wrong.get('p1'),
    error => error.category === 'server_error' && error.code === 'vault_decrypt_failed' && !/Unsupported state|auth tag|sk-secret/i.test(error.message),
  );
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.rm(dir, { recursive: true, force: true });
});

test('concurrent writes are serialized and leave a valid vault', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'vault.json');
  const vault = new FileCredentialVault({ file, key: crypto.randomBytes(32).toString('hex') });
  await Promise.all(Array.from({ length: 25 }, (_, index) => vault.set(`p${index}`, { secret: `s${index}` })));
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(parsed.entries).length, 25);
  for (let index = 0; index < 25; index += 1) assert.equal((await vault.get(`p${index}`)).secret, `s${index}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a failed atomic rename leaves the previous vault intact and no temp files', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'vault.json');
  const key = crypto.randomBytes(32).toString('hex');
  await new FileCredentialVault({ file, key }).set('existing', { secret: 'keep' });
  const before = await fs.readFile(file, 'utf8');

  const failingFs = { ...fs, rename: async () => { throw Object.assign(new Error('EXDEV: simulated'), { code: 'EXDEV' }); } };
  const vault = new FileCredentialVault({ file, key, fsImpl: failingFs });
  await assert.rejects(() => vault.set('p1', { secret: 'new' }), error => error.code === 'vault_write_failed');

  assert.equal(await fs.readFile(file, 'utf8'), before, 'the original vault must survive a failed replacement');
  const leftovers = (await fs.readdir(dir)).filter(name => name !== 'vault.json');
  assert.deepEqual(leftovers, [], 'temporary files must be cleaned up');
  await fs.rm(dir, { recursive: true, force: true });
});

test('vault files are owner-only on disk', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'vault.json');
  const vault = new FileCredentialVault({ file, key: crypto.randomBytes(32).toString('hex') });
  await vault.set('p1', { secret: 's' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  await fs.rm(dir, { recursive: true, force: true });
});

test('vault failures are sanitized in API responses', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'vault.json');
  await fs.writeFile(file, 'not json at all', { mode: 0o600 });
  const vault = new FileCredentialVault({ file, key: crypto.randomBytes(32).toString('hex') });
  const ctx = await startSavage({ vault });
  try {
    const read = await api(ctx.base, '/api/credentials/p1', { method: 'GET' });
    assert.equal(read.status, 502);
    assert.equal(read.json.error.category, 'server_error');
    assert.match(read.json.error.message, /Credential vault/);
    assert.ok(!/SyntaxError|Unexpected token|not json at all|vault\.json|\/tmp/.test(read.text), read.text);

    const write = await api(ctx.base, '/api/credentials/p1', { method: 'PUT', body: { secret: 'x' } });
    assert.equal(write.status, 502);
    assert.equal(await fs.readFile(file, 'utf8'), 'not json at all');
  } finally { await ctx.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('credential headers with line breaks are rejected by the API', async () => {
  const ctx = await startSavage();
  try {
    const response = await api(ctx.base, '/api/credentials/p1', { method: 'PUT', body: { secret: 's', headers: { 'X-Bad': 'a\r\nInjected: 1' } } });
    assert.equal(response.status, 400);
    assert.match(response.json.error.message, /line breaks/);
    assert.equal(await ctx.vault.has('p1'), false);
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
