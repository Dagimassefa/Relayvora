// Regression: saving and listing still work. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('save and list', async () => {
  const port = 3200 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.equal((await fetch(`${base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"milk"}' })).status, 201);
    assert.deepEqual(await (await fetch(`${base}/api/items`)).json(), ['milk']);
  } finally { server.kill(); }
});
