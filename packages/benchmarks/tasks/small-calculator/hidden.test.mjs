// Hidden acceptance tests: never shown to the agents; run after step B to score the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './calc.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('precedence', () => close(evaluate('2 + 3 * 4'), 14));
test('left associativity', () => close(evaluate('10 - 4 - 3'), 3));
test('division chain', () => close(evaluate('100 / 10 / 5'), 2));
test('parentheses', () => close(evaluate('2 + 3 * (4 - 1) / 2'), 6.5));
test('nested parentheses', () => close(evaluate('((1 + 2) * (3 + 4))'), 21));
test('unary minus', () => close(evaluate('-3 + 5'), 2));
test('unary minus on group', () => close(evaluate('-(2.5 * 4) + 1'), -9));
test('decimals', () => close(evaluate('0.1 + 0.2'), 0.3));
test('whitespace tolerant', () => close(evaluate('  7*  6 '), 42));
test('division by zero throws', () => assert.throws(() => evaluate('1 / 0')));
test('trailing operator throws', () => assert.throws(() => evaluate('2 +')));
test('unbalanced parenthesis throws', () => assert.throws(() => evaluate('(1 + 2')));
test('garbage throws', () => assert.throws(() => evaluate('2 $ 3')));
