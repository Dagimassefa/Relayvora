# Demo app for Kane runs

A dependency-free list app used as a real target for `relayvora --verify kane` and `relayvora gate run`.

```sh
node fixtures/demo-app/server.mjs          # http://localhost:3000 (PORT to change)
```

Items are stored in server memory: they survive a page refresh and are cleared when the server restarts.
