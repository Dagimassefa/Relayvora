/** Small task: a session that stays small (~40k tokens per call), so a relay has little to save. */
export default {
  name: 'small-calculator',
  files: {
    'package.json': JSON.stringify({ name: 'calc', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'README.md': '# Calculator\n',
  },
  promptA:
    'Create a small JavaScript calculator in this repo. In calc.js export add, subtract, multiply and divide (divide by zero must throw an Error). Add tests in calc.test.js using node:test and node:assert. Make `npm test` pass. Keep it minimal.',
  promptB:
    'Extend the calculator: export evaluate(expression) from calc.js that parses strings like "2 + 3 * (4 - 1) / 2" with correct operator precedence, parentheses, unary minus and decimals, and throws an Error on invalid input or division by zero. Reuse the existing functions. Add tests for evaluate in calc.test.js. Make `npm test` pass.',
  hiddenTest: 'hidden.test.mjs',
};
