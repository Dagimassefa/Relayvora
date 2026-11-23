// Minimal target app for real Kane runs. No dependencies: `node fixtures/demo-app/server.mjs`.
// Items are kept in server memory, so they survive a page refresh but not a server restart.
import http from 'node:http';

const port = Number(process.env.PORT ?? 3000);
const items = [];

const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Demo List</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}li{padding:.25rem 0}</style>
</head>
<body>
<h1>Demo List</h1>
<form id="add"><label for="name">Item</label> <input id="name" name="name" autocomplete="off" required> <button type="submit">Save</button></form>
<p id="count"></p>
<ul id="items"></ul>
<script>
async function load() {
  const list = await (await fetch('/api/items')).json();
  document.getElementById('items').replaceChildren(...list.map((name) => Object.assign(document.createElement('li'), { textContent: name })));
  document.getElementById('count').textContent = list.length + (list.length === 1 ? ' item' : ' items');
}
document.getElementById('add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('name');
  await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: input.value }) });
  input.value = '';
  await load();
});
load();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  } else if (req.method === 'GET' && req.url === '/api/items') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
  } else if (req.method === 'POST' && req.url === '/api/items') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 10_000) req.destroy(); });
    req.on('end', () => {
      try {
        const name = String(JSON.parse(body).name ?? '').trim().slice(0, 200);
        if (!name) return res.writeHead(400).end();
        items.push(name);
        res.writeHead(201).end();
      } catch { res.writeHead(400).end(); }
    });
  } else {
    res.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Demo app on http://localhost:${port}`));
