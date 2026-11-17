import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry } from '../src/telemetry.js';

test('telemetry summary tracks availability, latency, cost, refusals and per-provider health', () => {
  const telemetry = new Telemetry();
  telemetry.events = [];
  telemetry.record({ ok: true, providerId: 'p1', latencyMs: 100, cost: 0.002, usage: { totalTokens: 10 }, requestId: 'r1', kind: 'chat' });
  telemetry.record({ ok: false, providerId: 'p1', latencyMs: 300, category: 'provider_refusal', kind: 'chat' });
  telemetry.record({ ok: true, providerId: 'p2', latencyMs: 200, cost: 0.001, kind: 'chat' });

  const summary = telemetry.summary();
  assert.equal(summary.requests, 3);
  assert.equal(summary.successRate, 67);
  assert.equal(summary.avgLatency, 200);
  assert.equal(summary.totalCost, 0.003);
  assert.equal(summary.refusals, 1);
  assert.equal(summary.refusalRate, 33);
  assert.equal(summary.byProvider.p1.length, 2);
  assert.equal(summary.byProvider.p2.length, 1);
  assert.equal(telemetry.events[0].providerId, 'p2', 'newest event first');
});
