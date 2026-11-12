import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBill, billRange } from '../src/billing/engine.js';
import { canonical, sha256 } from '../src/hash.js';

const cfg = {
  version: 't',
  perKwh: { generation: 1, transmission: 0, systemLoss: 0, universalCharges: 0, fitAll: 0 },
  distributionTiers: [{ upToKwh: 200, distribution: 1, supply: 0, metering: 0 }, { upToKwh: null, distribution: 2, supply: 0, metering: 0 }],
  fixedPerMonth: { supply: 10, metering: 0 },
  vat: { rate: 0.1, appliesTo: ['generation', 'distribution'] },
};

test('applies the tier for the whole consumption and VAT on listed lines', () => {
  const b = computeBill(100, cfg);
  // generation 100 + distribution 100 + supply 10 + vat 0.1*(200) = 230
  assert.equal(b.total, 230);
  const b2 = computeBill(250, cfg);
  // generation 250 + distribution 500 + supply 10 + vat 75 = 835
  assert.equal(b2.total, 835);
});

test('range is monotonic', () => {
  const r = billRange({ low: 150, base: 200, high: 260 }, cfg);
  assert.ok(r.low <= r.base && r.base <= r.high);
});

test('rejects invalid kWh', () => {
  assert.throws(() => computeBill(-1, cfg), RangeError);
  assert.throws(() => computeBill(Number.NaN, cfg), RangeError);
});

test('canonical JSON is key-order independent', () => {
  assert.equal(sha256(canonical({ b: 1, a: { d: 2, c: 3 } })), sha256(canonical({ a: { c: 3, d: 2 }, b: 1 })));
  assert.notEqual(sha256(canonical({ a: 1 })), sha256(canonical({ a: 2 })));
});
