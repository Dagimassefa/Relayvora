import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isListening, parseAppUrl, startRuntime } from '../src/managed-runtime.js';

const demoApp = fileURLToPath(new URL('../../../fixtures/demo-app/server.mjs', import.meta.url));
const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});

describe('managed runtime (real process)', () => {
  it('starts the demo app, waits until it answers, and stops its process tree', async () => {
    const url = parseAppUrl(`http://127.0.0.1:${await freePort()}/`);
    const runtime = await startRuntime({ command: `node "${demoApp}"`, url, cwd: process.cwd(), readyTimeoutSec: 20 });
    try {
      expect(runtime.alive()).toBe(true);
      expect((await fetch(new URL('/api/items', url))).status).toBe(200);
      await expect(startRuntime({ command: `node "${demoApp}"`, url, cwd: process.cwd(), readyTimeoutSec: 5 })).rejects.toThrow(/already listening/);
    } finally { await runtime.stop(); }
    expect(runtime.alive()).toBe(false);
    expect(await isListening(url)).toBe(false);
  });
  it('reports an app that exits before it is ready', async () => {
    const url = parseAppUrl(`http://127.0.0.1:${await freePort()}/`);
    await expect(startRuntime({ command: 'node -e "process.exit(3)"', url, cwd: process.cwd(), readyTimeoutSec: 10 })).rejects.toThrow(/exited before it was ready/);
  });
  it('only accepts local http(s) URLs', () => {
    expect(() => parseAppUrl('http://example.com:3000/')).toThrow(/this machine/);
    expect(() => parseAppUrl('file:///etc/passwd')).toThrow(/http or https/);
    expect(parseAppUrl('http://localhost:3000/').port).toBe('3000');
  });
});
