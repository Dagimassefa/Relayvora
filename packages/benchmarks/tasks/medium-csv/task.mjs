export default {
  name: 'medium-csv',
  files: {
    'package.json': JSON.stringify({ name: 'csv-tool', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'README.md': '# CSV utilities\nNo third-party dependencies.\n',
  },
  promptA: 'Implement CSV utilities in csv.js with no dependencies. Export parseCsv(text) returning arrays of string fields, and formatCsv(rows) returning CSV text without a trailing newline. Support comma delimiters, quoted commas, escaped double quotes, quoted newlines, CRLF records, empty fields, and empty input (returns []). Throw on unterminated quotes or characters after a closing quote before a delimiter or newline. Add node:test tests in csv.test.js. Make npm test pass.',
  promptB: 'Extend csv.js with export recordsFromCsv(text). Parse using the existing parseCsv, treat the first row as headers, and return an array of plain objects mapping headers to field strings. Empty input or a header without data returns []. Reject empty or duplicate headers and any data row with a different field count. Preserve whitespace and quoted content in fields. Header names like __proto__ and constructor must work as own enumerable properties without changing object prototypes. Add tests and keep npm test passing.',
  hiddenTest: 'hidden.test.mjs',
};
