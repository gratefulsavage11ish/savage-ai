import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestLifecycle } from '../src/request-lifecycle.js';

test('begin freezes a provider snapshot that later edits cannot change', () => {
  const provider = { id: 'p1', name: 'Provider', adapter: 'openai-compatible', model: 'model-a' };
  const lifecycle = new RequestLifecycle();
  const request = lifecycle.begin(provider);

  provider.model = 'model-b';
  provider.name = 'Renamed';

  assert.equal(request.provider.model, 'model-a');
  assert.equal(request.provider.name, 'Provider');
  assert.ok(Object.isFrozen(request.provider), 'snapshot must be immutable');
});

test('a newer request makes the previous one stale', () => {
  const lifecycle = new RequestLifecycle();
  const first = lifecycle.begin({ id: 'a', model: 'm' });
  assert.equal(lifecycle.isCurrent(first), true);

  const second = lifecycle.begin({ id: 'b', model: 'm' });
  assert.equal(lifecycle.isCurrent(first), false);
  assert.equal(lifecycle.isStale(first), true);
  assert.equal(lifecycle.isCurrent(second), true);
  assert.equal(lifecycle.active.provider.id, 'b');
});

test('finishing a request clears it and rejects late work', () => {
  const lifecycle = new RequestLifecycle();
  const request = lifecycle.begin({ id: 'a', model: 'm' });
  lifecycle.finish(request);
  assert.equal(lifecycle.active, null);
  assert.equal(lifecycle.isCurrent(request), false);
});

test('abort reaches the controller attached to the active request', () => {
  const lifecycle = new RequestLifecycle();
  let aborts = 0;
  const controller = { abort: () => { aborts += 1; } };
  const request = lifecycle.begin({ id: 'a', model: 'm' }, { controller });
  lifecycle.abort();
  assert.equal(aborts, 1);
  lifecycle.finish(request);
  lifecycle.abort(); // nothing active: must not throw
  assert.equal(aborts, 1);
});

test('begin refuses a provider without an id', () => {
  assert.throws(() => new RequestLifecycle().begin({}), TypeError);
});
