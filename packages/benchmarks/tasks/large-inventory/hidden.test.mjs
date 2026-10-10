// Hidden acceptance tests: never shown to the agents; run after step B to score the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrder } from './src/orders.js';
import { applyDiscount } from './src/pricing.js';

const base = () => createOrder({ items: [{ sku: 'A', qty: 2, unitPrice: 50 }, { sku: 'B', qty: 1, unitPrice: 100 }], shipping: 10 });
const bulk = () => createOrder({ items: [{ sku: 'C', qty: 10, unitPrice: 10 }], shipping: 5 });

test('SAVE10 takes 10% off the subtotal', () => assert.equal(applyDiscount(base(), 'SAVE10').total, 190));
test('FREESHIP removes shipping', () => assert.equal(applyDiscount(base(), 'FREESHIP').total, 200));
test('BULK takes 15% off at 10+ units', () => assert.equal(applyDiscount(bulk(), 'BULK').total, 90));
test('BULK throws under 10 units', () => assert.throws(() => applyDiscount(base(), 'BULK')));
test('unknown code throws', () => assert.throws(() => applyDiscount(base(), 'NOPE')));
test('input order is not mutated', () => {
  const o = base();
  const before = JSON.stringify(o);
  applyDiscount(o, 'SAVE10');
  assert.equal(JSON.stringify(o), before);
});
test('rounds to cents', () => {
  const o = createOrder({ items: [{ sku: 'D', qty: 3, unitPrice: 3.33 }], shipping: 0 });
  assert.equal(applyDiscount(o, 'SAVE10').total, 8.99);
});
