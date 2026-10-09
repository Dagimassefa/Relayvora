export interface OutputOptions {
  json?: boolean;
}

/** Prints machine-readable JSON with `--json`, otherwise the human rendering. */
export function emit<T>(options: OutputOptions, data: T, human: (data: T) => string): void {
  process.stdout.write(options.json ? `${JSON.stringify(data, null, 2)}\n` : `${human(data)}\n`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
