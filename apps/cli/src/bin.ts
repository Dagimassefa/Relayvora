#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on first load. It is expected and would pollute
// `--json` consumers reading stderr, so drop that one warning and pass everything else through.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/i.test(message)) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// Imported dynamically so the filter above is installed before node:sqlite loads.
const { main } = await import('./program.js');
process.exitCode = await main(process.argv);
