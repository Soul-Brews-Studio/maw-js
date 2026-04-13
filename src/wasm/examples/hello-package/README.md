# hello-package

Reference maw WASM plugin demonstrating all three invocation surfaces: **CLI**, **API**, and **peer**.

## Build

```bash
cd src/wasm/examples/hello-package
pnpm install
pnpm asbuild:release   # → build/release.wasm (~8 KB)
```

## Install

Copy or symlink `plugin.json` + `build/release.wasm` into a directory on the
maw plugin path, then register via `maw install`:

```bash
maw install ./src/wasm/examples/hello-package/plugin.json
```

Or reference the path directly in `maw.config.json`:

```json
{
  "plugins": ["./src/wasm/examples/hello-package/plugin.json"]
}
```

## Invoke

### CLI surface

```bash
maw hello-pkg
# hello-package via CLI
#   node:    my-node
#   version: 1.0.0
#   agents:  neo, mawjs
```

The plugin receives `{ source: "cli", args: ["..."] }` and prints a
human-readable greeting with node identity.

### API surface

```bash
curl http://localhost:3000/api/plugins/hello-package
# {"plugin":"hello-package","surface":"api","node":"my-node","version":"1.0.0","message":"Hello from WASM API surface"}
```

POST is also accepted (body is forwarded as `args`):

```bash
curl -X POST http://localhost:3000/api/plugins/hello-package \
     -H 'Content-Type: application/json' \
     -d '{"key":"value"}'
```

### Peer surface

Triggered when a federation peer forwards a message to this plugin:

```bash
maw hey node:peer hello-pkg
# hello-package via peer from my-node
#   peers: 3/4 reachable
```

The plugin receives `{ source: "peer", args: { from, msg } }` and prints
federation context (reachable peer count).

## InvokeContext

The maw runtime writes this JSON into WASM linear memory before calling `handle()`:

```ts
{ source: "cli" | "api" | "peer"; args: string[] | Record<string, unknown> }
```

## plugin.json

```json
{
  "name": "hello-package",
  "version": "1.0.0",
  "wasm": "./build/release.wasm",
  "sdk": "^1.0.0",
  "description": "Reference plugin demonstrating CLI, API, and peer surfaces",
  "author": "Soul-Brews-Studio",
  "cli": { "command": "hello-pkg", "help": "Say hello from WASM via any surface" },
  "api": { "path": "/api/plugins/hello-package", "methods": ["GET", "POST"] }
}
```

## SDK reference

See [`maw-plugin-sdk-assemblyscript`](../../maw-plugin-sdk-assemblyscript/README.md)
for the full API surface (`maw.print`, `maw.identity`, `maw.federation`, etc.).
