/**
 * Large task: step A reads a ~20-module codebase to document it, so the session grows large
 * (well over 100k tokens per call). Step B is a focused feature that touches one or two files.
 * This is the case a relay is meant for: the next step does not need most of the old context.
 */

const ENTITIES = [
  ['products', 'product', ['sku', 'name', 'category', 'weightKg', 'active']],
  ['customers', 'customer', ['email', 'name', 'tier', 'country', 'active']],
  ['suppliers', 'supplier', ['code', 'name', 'country', 'leadTimeDays', 'active']],
  ['warehouses', 'warehouse', ['code', 'city', 'capacity', 'region', 'active']],
  ['stock', 'stockItem', ['sku', 'warehouse', 'quantity', 'reorderLevel', 'active']],
  ['returns', 'returnRequest', ['orderId', 'reason', 'status', 'refundAmount', 'active']],
  ['payments', 'payment', ['orderId', 'method', 'amount', 'status', 'active']],
  ['invoices', 'invoice', ['orderId', 'number', 'amount', 'dueDays', 'active']],
  ['employees', 'employee', ['email', 'name', 'role', 'warehouse', 'active']],
  ['carriers', 'carrier', ['code', 'name', 'maxWeightKg', 'region', 'active']],
  ['categories', 'category', ['slug', 'name', 'parent', 'sortOrder', 'active']],
  ['reviews', 'review', ['sku', 'customer', 'rating', 'status', 'active']],
  ['coupons', 'campaign', ['code', 'name', 'startsAt', 'endsAt', 'active']],
  ['purchaseOrders', 'purchaseOrder', ['supplier', 'sku', 'quantity', 'status', 'active']],
  ['transfers', 'transfer', ['sku', 'fromWarehouse', 'toWarehouse', 'quantity', 'active']],
  ['audits', 'auditEntry', ['actor', 'action', 'target', 'severity', 'active']],
  ['alerts', 'alert', ['kind', 'target', 'threshold', 'severity', 'active']],
  ['regions', 'region', ['code', 'name', 'currency', 'taxRate', 'active']],
  ['tickets', 'ticket', ['subject', 'customer', 'priority', 'slaHours', 'active']],
  ['shipments', 'shipment', ['orderId', 'carrier', 'status', 'weightKg', 'active']],
  ['routes', 'route', ['code', 'origin', 'destination', 'distanceKm', 'active']],
  ['vehicles', 'vehicle', ['plate', 'model', 'depot', 'capacityKg', 'active']],
  ['contracts', 'contract', ['supplier', 'title', 'status', 'valueAmount', 'active']],
  ['departments', 'department', ['code', 'name', 'manager', 'headcount', 'active']],
  ['budgets', 'budget', ['department', 'period', 'owner', 'limitAmount', 'active']],
  ['assets', 'asset', ['tag', 'kind', 'location', 'valueAmount', 'active']],
  ['maintenance', 'maintenanceJob', ['asset', 'kind', 'status', 'costAmount', 'active']],
  ['schedules', 'schedule', ['name', 'owner', 'cron', 'retryCount', 'active']],
  ['locations', 'location', ['code', 'name', 'warehouse', 'capacity', 'active']],
  ['batches', 'batch', ['sku', 'lotCode', 'status', 'quantity', 'active']],
  ['recalls', 'recall', ['sku', 'reason', 'severity', 'affectedQuantity', 'active']],
  ['certifications', 'certification', ['supplier', 'standard', 'status', 'validDays', 'active']],
  ['inspections', 'inspection', ['location', 'inspector', 'result', 'scoreValue', 'active']],
  ['devices', 'device', ['serial', 'kind', 'warehouse', 'batteryLevel', 'active']],
];

const cap = (s) => s[0].toUpperCase() + s.slice(1);

function entityModule([plural, singular, fields]) {
  const T = cap(singular);
  const required = fields.slice(0, 3);
  const numeric = fields.filter((f) => /Kg|Km|Days|Hours|capacity|quantity|Quantity|Level|Amount|amount|rating|sortOrder|threshold|taxRate|headcount|Count|Value/.test(f));
  return `// ${plural}.js: in-memory store and helpers for ${plural}.
import { assertString, assertNumber, nextId } from './validation.js';
import { recordAudit } from './audit-log.js';

/** @typedef {{ id: string, ${fields.map((f) => `${f}: any`).join(', ')}, createdAt: string, updatedAt: string }} ${T} */

const store = new Map();

/**
 * Validates the fields of a ${singular}. Throws an Error naming the first invalid field.
 * @param {Partial<${T}>} input
 * @param {{ partial?: boolean }} [options]
 */
export function validate${T}(input, options = {}) {
  if (input === null || typeof input !== 'object') throw new Error('${singular} must be an object');
${required.map((f) => `  if (!options.partial || '${f}' in input) {\n    ${numeric.includes(f) ? `assertNumber(input.${f}, '${f}')` : `assertString(input.${f}, '${f}')`};\n  }`).join('\n')}
${numeric
  .filter((f) => !required.includes(f))
  .map((f) => `  if ('${f}' in input && input.${f} !== undefined) assertNumber(input.${f}, '${f}');`)
  .join('\n')}
  if ('active' in input && typeof input.active !== 'boolean') throw new Error('active must be a boolean');
  return true;
}

/**
 * Creates a ${singular} and stores it.
 * @param {Omit<${T}, 'id' | 'createdAt' | 'updatedAt'>} input
 * @returns {${T}}
 */
export function create${T}(input) {
  validate${T}(input);
  const now = new Date().toISOString();
  const record = { id: nextId('${singular.slice(0, 3)}'), active: true, ...input, createdAt: now, updatedAt: now };
  store.set(record.id, record);
  recordAudit('create', '${singular}', record.id);
  return { ...record };
}

/** Returns a copy of the ${singular} with this id, or null. */
export function get${T}(id) {
  const record = store.get(id);
  return record ? { ...record } : null;
}

/**
 * Updates fields of an existing ${singular}. Unknown ids throw.
 * @param {string} id
 * @param {Partial<${T}>} changes
 */
export function update${T}(id, changes) {
  const current = store.get(id);
  if (!current) throw new Error(\`${singular} \${id} not found\`);
  validate${T}(changes, { partial: true });
  const updated = { ...current, ...changes, id, updatedAt: new Date().toISOString() };
  store.set(id, updated);
  recordAudit('update', '${singular}', id);
  return { ...updated };
}

/** Soft-deletes a ${singular} (sets active to false). Returns true if it existed. */
export function deactivate${T}(id) {
  const current = store.get(id);
  if (!current) return false;
  store.set(id, { ...current, active: false, updatedAt: new Date().toISOString() });
  recordAudit('deactivate', '${singular}', id);
  return true;
}

/** Permanently removes a ${singular}. Returns true if it existed. */
export function remove${T}(id) {
  const existed = store.delete(id);
  if (existed) recordAudit('remove', '${singular}', id);
  return existed;
}

/**
 * Lists ${plural}, optionally filtered by exact field values and paginated.
 * @param {{ where?: Partial<${T}>, includeInactive?: boolean, offset?: number, limit?: number }} [query]
 */
export function list${cap(plural)}(query = {}) {
  const { where = {}, includeInactive = false, offset = 0, limit = 50 } = query;
  const rows = [...store.values()].filter((r) => (includeInactive || r.active) && Object.entries(where).every(([k, v]) => r[k] === v));
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { total: rows.length, items: rows.slice(offset, offset + limit).map((r) => ({ ...r })) };
}

/** Case-insensitive search over the text fields of ${plural}. */
export function search${cap(plural)}(text) {
  const needle = String(text).toLowerCase();
  return [...store.values()]
    .filter((r) => r.active && [${fields.filter((f) => !numeric.includes(f) && f !== 'active').map((f) => `r.${f}`).join(', ')}].some((v) => String(v ?? '').toLowerCase().includes(needle)))
    .map((r) => ({ ...r }));
}

/** Counts ${plural} grouped by the given field. */
export function count${cap(plural)}By(field) {
  const counts = {};
  for (const r of store.values()) {
    if (!r.active) continue;
    const key = String(r[field] ?? 'unknown');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
${numeric.length > 0 ? `
/** Sum, min, max and average of a numeric field across active ${plural}. */
export function summarize${cap(plural)}(field = '${numeric[0]}') {
  const values = [...store.values()].filter((r) => r.active && typeof r[field] === 'number').map((r) => r[field]);
  if (values.length === 0) return { count: 0, sum: 0, min: null, max: null, average: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return { count: values.length, sum, min: Math.min(...values), max: Math.max(...values), average: sum / values.length };
}
` : ''}
/** Exports active ${plural} as CSV with a header row. */
export function export${cap(plural)}Csv() {
  const columns = ['id', ${fields.map((f) => `'${f}'`).join(', ')}];
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\\n]/.test(s) ? \`"\${s.replace(/"/g, '""')}"\` : s;
  };
  const rows = [...store.values()].filter((r) => r.active).map((r) => columns.map((c) => escape(r[c])).join(','));
  return [columns.join(','), ...rows].join('\\n');
}

/** Imports ${plural} from CSV produced by export${cap(plural)}Csv. Returns the number imported. */
export function import${cap(plural)}Csv(csv) {
  const [header, ...lines] = String(csv).trim().split(/\\r?\\n/);
  const columns = header.split(',');
  let imported = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const values = line.split(',');
    const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
    delete row.id;
${numeric.map((f) => `    if (row.${f} !== undefined) row.${f} = Number(row.${f});`).join('\n')}
    if (row.active !== undefined) row.active = row.active === 'true';
    create${T}(row);
    imported++;
  }
  return imported;
}

/** Removes every ${singular}; for tests. */
export function reset${cap(plural)}() {
  store.clear();
}
`;
}

const CORE = {
  'src/validation.js': `// validation.js: shared argument checks and id generation.
let counter = 0;

/** Throws unless value is a non-empty string. */
export function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(\`\${name} must be a non-empty string\`);
}

/** Throws unless value is a finite number. */
export function assertNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(\`\${name} must be a finite number\`);
}

/** Throws unless value is a positive integer. */
export function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(\`\${name} must be a positive integer\`);
}

/** Sequential ids with a prefix, e.g. ord-1. */
export function nextId(prefix) {
  counter += 1;
  return \`\${prefix}-\${counter}\`;
}
`,
  'src/audit-log.js': `// audit-log.js: append-only record of changes.
const entries = [];

/** Records that an actor performed an action on a target. */
export function recordAudit(action, kind, id, actor = 'system') {
  entries.push({ at: new Date().toISOString(), action, kind, id, actor });
}

/** Entries for one record, oldest first. */
export function auditTrail(kind, id) {
  return entries.filter((e) => e.kind === kind && e.id === id).map((e) => ({ ...e }));
}

/** Number of recorded entries. */
export function auditCount() {
  return entries.length;
}
`,
  'src/money.js': `// money.js: currency arithmetic in whole cents to avoid floating point drift.

/** Rounds to 2 decimal places (half away from zero). */
export function round2(amount) {
  return Math.sign(amount) * Math.round(Math.abs(amount) * 100 + Number.EPSILON) / 100;
}

/** Sums amounts, rounding the result. */
export function sum(amounts) {
  return round2(amounts.reduce((total, a) => total + a, 0));
}

/** Applies a percentage (0-100) to an amount and rounds. */
export function percentOf(amount, percent) {
  return round2((amount * percent) / 100);
}

/** Formats an amount like "ETB 1,234.50". */
export function formatMoney(amount, currency = 'ETB') {
  return \`\${currency} \${round2(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\`;
}
`,
  'src/orders.js': `// orders.js: order construction. Orders are plain objects; functions never mutate their inputs.
import { assertNumber, assertPositiveInteger, assertString, nextId } from './validation.js';
import { lineTotal, subtotal } from './pricing.js';
import { round2 } from './money.js';

/**
 * @typedef {{ sku: string, qty: number, unitPrice: number }} OrderItem
 * @typedef {{ id: string, items: OrderItem[], subtotal: number, shipping: number, total: number }} Order
 */

function validateItem(item) {
  assertString(item.sku, 'sku');
  assertPositiveInteger(item.qty, 'qty');
  assertNumber(item.unitPrice, 'unitPrice');
  if (item.unitPrice < 0) throw new Error('unitPrice must not be negative');
}

/**
 * Creates an order. total = subtotal + shipping.
 * @param {{ items: OrderItem[], shipping?: number }} input
 * @returns {Order}
 */
export function createOrder({ items, shipping = 0 }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('an order needs at least one item');
  items.forEach(validateItem);
  assertNumber(shipping, 'shipping');
  const copy = items.map((i) => ({ ...i }));
  const sub = subtotal(copy);
  return { id: nextId('ord'), items: copy, subtotal: sub, shipping: round2(shipping), total: round2(sub + shipping) };
}

/** Returns a new order with an item added (merging quantities for the same sku). */
export function addItem(order, item) {
  validateItem(item);
  const items = order.items.map((i) => ({ ...i }));
  const existing = items.find((i) => i.sku === item.sku && i.unitPrice === item.unitPrice);
  if (existing) existing.qty += item.qty;
  else items.push({ ...item });
  return recalculate({ ...order, items });
}

/** Returns a new order without the given sku. */
export function removeItem(order, sku) {
  const items = order.items.filter((i) => i.sku !== sku).map((i) => ({ ...i }));
  if (items.length === 0) throw new Error('an order needs at least one item');
  return recalculate({ ...order, items });
}

/** Total number of units across all lines. */
export function itemCount(order) {
  return order.items.reduce((n, i) => n + i.qty, 0);
}

/** Recomputes subtotal and total from the items and shipping. */
export function recalculate(order) {
  const sub = subtotal(order.items);
  return { ...order, subtotal: sub, total: round2(sub + order.shipping) };
}

/** One summary line per item, e.g. "2 x A-1 @ 50.00 = 100.00". */
export function describeOrder(order) {
  return order.items.map((i) => \`\${i.qty} x \${i.sku} @ \${i.unitPrice.toFixed(2)} = \${lineTotal(i).toFixed(2)}\`);
}
`,
  'src/pricing.js': `// pricing.js: line and order price calculations.
import { round2, sum, percentOf } from './money.js';

/** Price of one order line. */
export function lineTotal(item) {
  return round2(item.qty * item.unitPrice);
}

/** Sum of all line totals. */
export function subtotal(items) {
  return sum(items.map(lineTotal));
}

/** Tax on an amount at a percentage rate. */
export function taxFor(amount, ratePercent) {
  if (ratePercent < 0) throw new Error('tax rate must not be negative');
  return percentOf(amount, ratePercent);
}

/** Price after a volume tier: 5% off from 50 units, 8% off from 100 units. */
export function tieredUnitPrice(unitPrice, qty) {
  if (qty >= 100) return round2(unitPrice * 0.92);
  if (qty >= 50) return round2(unitPrice * 0.95);
  return unitPrice;
}
`,
  'src/shipping.js': `// shipping.js: shipping cost by weight and region.
import { round2 } from './money.js';

const RATES = { local: { base: 5, perKg: 1.2 }, national: { base: 9, perKg: 1.8 }, international: { base: 25, perKg: 4.5 } };

/** Shipping cost for a parcel. Throws for unknown regions or non-positive weights. */
export function shippingCost(weightKg, region = 'national') {
  const rate = RATES[region];
  if (!rate) throw new Error(\`unknown region \${region}\`);
  if (!(weightKg > 0)) throw new Error('weight must be positive');
  return round2(rate.base + rate.perKg * Math.ceil(weightKg));
}

/** Regions with a rate defined. */
export function shippingRegions() {
  return Object.keys(RATES);
}
`,
  'test/orders.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrder, addItem, itemCount } from '../src/orders.js';

test('createOrder computes subtotal and total', () => {
  const o = createOrder({ items: [{ sku: 'A', qty: 2, unitPrice: 50 }], shipping: 10 });
  assert.equal(o.subtotal, 100);
  assert.equal(o.total, 110);
});

test('addItem merges quantities and does not mutate', () => {
  const o = createOrder({ items: [{ sku: 'A', qty: 1, unitPrice: 5 }] });
  const o2 = addItem(o, { sku: 'A', qty: 2, unitPrice: 5 });
  assert.equal(itemCount(o2), 3);
  assert.equal(itemCount(o), 1);
});
`,
};

const files = {
  'package.json': JSON.stringify({ name: 'inventory', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# Inventory\n\nIn-memory inventory and ordering system. Modules live in src/, tests in test/.\n',
  ...CORE,
  ...Object.fromEntries(ENTITIES.map((e) => [`src/${e[0]}.js`, entityModule(e)])),
};

export default {
  name: 'large-inventory',
  files,
  promptA:
    'Read every module in src/ (all of them, in full) and write docs/ARCHITECTURE.md. For each module, list its exported functions with a one-line description each, and which other modules it imports. End with a short section on how orders, pricing, money and shipping fit together. Do not change any code.',
  promptB:
    'Add discount codes: export applyDiscount(order, code) from src/pricing.js. Orders are the objects created by createOrder in src/orders.js. Codes: "SAVE10" takes 10% off the subtotal; "FREESHIP" makes shipping 0; "BULK" takes 15% off the subtotal when the order has at least 10 units in total, and throws an Error otherwise. Any other code throws an Error. Return a new order whose total is the discounted subtotal plus shipping, rounded to cents; never mutate the input order. Add tests in test/pricing.test.js and make `npm test` pass.',
  hiddenTest: 'hidden.test.mjs',
};
