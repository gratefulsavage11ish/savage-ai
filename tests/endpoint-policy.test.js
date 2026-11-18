import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, hostAllowed, assertEndpointUrl, assertEndpointResolvesSafely } from '../src/endpoint-policy.js';

test('private, loopback and link-local IPv4 ranges are detected', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', 'example.com']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('IPv6 loopback, unique-local, link-local and zone ids are detected', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', '[fe80::1%25eth0]']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('IPv4-mapped and 6to4 IPv6 forms are unwrapped', () => {
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true, 'hex form of 127.0.0.1');
  assert.equal(isPrivateAddress('::ffff:0a00:0001'), true, 'hex form of 10.0.0.1');
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateAddress('2002:7f00:0001::'), true, '6to4 embedding 127.0.0.1');
});

test('allowlist suffix matches respect label boundaries', () => {
  const options = { adapter: 'openai-compatible', allowedHosts: ['example.com'] };
  assert.equal(hostAllowed('example.com', options), true);
  assert.equal(hostAllowed('api.example.com', options), true);
  assert.equal(hostAllowed('notexample.com', options), false);
  assert.equal(hostAllowed('example.com.attacker.net', options), false);
  assert.equal(hostAllowed('evil-example.com', options), false);
});

test('custom allowlist hosts are accepted for an otherwise unknown adapter', () => {
  const url = assertEndpointUrl('https://providers.internal.test/v1', { adapter: 'openai-compatible', allowedHosts: ['providers.internal.test'] });
  assert.equal(url.host, 'providers.internal.test');
  assert.throws(
    () => assertEndpointUrl('https://providers.internal.test/v1', { adapter: 'openai-compatible' }),
    error => error.category === 'invalid_request' && /not allowlisted/.test(error.message),
  );
});

test('loopback, private addresses, credentials and plain HTTP are refused', () => {
  assert.throws(() => assertEndpointUrl('http://localhost:11434/v1', { adapter: 'custom-openai' }), /Loopback/);
  assert.throws(() => assertEndpointUrl('https://169.254.169.254/latest', { adapter: 'openai-compatible', allowedHosts: ['169.254.169.254'] }), /Private/);
  assert.throws(() => assertEndpointUrl('https://user:pass@example.com/v1', { adapter: 'openai-compatible', allowedHosts: ['example.com'] }), /Credentials/);
  assert.throws(() => assertEndpointUrl('http://provider.example.com/v1', { adapter: 'openai-compatible', allowedHosts: ['provider.example.com'] }), /HTTP/);
});

test('bracketed IPv6 loopback is gated by allowLoopback', () => {
  assert.throws(() => assertEndpointUrl('http://[::1]:11434/v1', { adapter: 'custom-openai' }), /Loopback/);
  const url = assertEndpointUrl('http://[::1]:11434/v1', { adapter: 'custom-openai', allowLoopback: true });
  assert.equal(url.port, '11434');
});

test('an IPv4-mapped IPv6 endpoint cannot smuggle a loopback address', () => {
  assert.throws(
    () => assertEndpointUrl('https://[::ffff:127.0.0.1]/v1', { adapter: 'openai-compatible', allowedHosts: ['::ffff:127.0.0.1'], allowLoopback: true }),
    /Private/,
  );
});

test('malformed IPv6 endpoints are rejected, not guessed at', () => {
  assert.throws(() => assertEndpointUrl('https://[::1/v1', { adapter: 'openai-compatible' }), /not a valid URL/);
});

test('resolved private addresses are refused; public ones pass', async () => {
  const url = new URL('https://provider.example.com/v1');
  await assert.rejects(
    () => assertEndpointResolvesSafely(url, { lookup: async () => [{ address: '10.0.0.5' }] }),
    error => error.category === 'invalid_request' && /private/i.test(error.message),
  );
  await assert.rejects(
    () => assertEndpointResolvesSafely(url, { lookup: async () => [{ address: '::1' }] }),
    error => error.category === 'invalid_request',
  );
  await assertEndpointResolvesSafely(url, { lookup: async () => [{ address: '93.184.216.34' }] });
});

test('resolution failures are connection errors and loopback stays gated', async () => {
  const url = new URL('https://provider.example.com/v1');
  await assert.rejects(
    () => assertEndpointResolvesSafely(url, { lookup: async () => { throw new Error('ENOTFOUND'); } }),
    error => error.category === 'connection_error',
  );
  await assert.rejects(
    () => assertEndpointResolvesSafely(new URL('http://localhost:1234/v1'), {}),
    error => error.category === 'invalid_request' && /Loopback/.test(error.message),
  );
});
