import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, formatCsv, recordsFromCsv } from './csv.js';

test('basic records', () => assert.deepEqual(recordsFromCsv('name,qty\nTea,2\nCoffee,3'), [{ name: 'Tea', qty: '2' }, { name: 'Coffee', qty: '3' }]));
test('quoted delimiters and CRLF', () => assert.deepEqual(recordsFromCsv('name,note\r\nTea,"a,b"\r\n'), [{ name: 'Tea', note: 'a,b' }]));
test('quoted newlines', () => assert.deepEqual(recordsFromCsv('a,b\n"line\none",x'), [{ a: 'line\none', b: 'x' }]));
test('escaped quotes', () => assert.deepEqual(recordsFromCsv('a\n"say ""hi"""'), [{ a: 'say "hi"' }]));
test('empty input and header only', () => { assert.deepEqual(recordsFromCsv(''), []); assert.deepEqual(recordsFromCsv('a,b'), []); });
test('preserves whitespace and empty values', () => assert.deepEqual(recordsFromCsv('a,b\n x ,'), [{ a: ' x ', b: '' }]));
test('duplicate headers rejected', () => assert.throws(() => recordsFromCsv('a,a\n1,2')));
test('empty header rejected', () => assert.throws(() => recordsFromCsv('a,\n1,2')));
test('too few fields rejected', () => assert.throws(() => recordsFromCsv('a,b\n1')));
test('too many fields rejected', () => assert.throws(() => recordsFromCsv('a\n1,2')));
test('prototype names are ordinary own properties', () => {
  const [row] = recordsFromCsv('__proto__,constructor\nx,y');
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(Object.hasOwn(row, '__proto__'), true);
  assert.equal(Object.hasOwn(row, 'constructor'), true);
  assert.deepEqual(Object.keys(row), ['__proto__', 'constructor']);
  assert.equal(row.__proto__, 'x'); assert.equal(row.constructor, 'y');
});
test('malformed quoted field rejected', () => assert.throws(() => recordsFromCsv('a\n"unfinished')));
test('characters after closing quote rejected', () => assert.throws(() => recordsFromCsv('a\n"ok"bad')));
test('existing CSV round trip preserved', () => {
  const rows = [['a', 'b'], ['x,y', 'say "hi"'], ['line\nnext', '']];
  assert.deepEqual(parseCsv(formatCsv(rows)), rows);
});
