# rust-echo — external engine plugin (PoC, #2566)

A ~180-line, **dependency-free** Rust binary that proves the maw *engine-plugin
gateway IPC contract*: an external process, in any language, can register a URL
prefix with `maw serve` and have requests reverse-proxied to it over loopback
HTTP. No SDK, no shared library — just a socket.

This is **Phase 1**: the echo server. It registers `/api/rust-echo`, answers a
health check, and echoes every proxied request (method, path, headers, body)
back as JSON. The gateway *selector* (choosing a plugin per engine/route) is out
of scope here.

Source of truth for the protocol below: `src/core/engine-plugin-registry.ts`,
`src/api/engine.ts`, and the proxy dispatch in `src/core/server.ts`.

---

## The wire protocol

Everything is plain HTTP/1.1 on loopback. Two parties:

- **maw serve** — the gateway, listening on `http://127.0.0.1:<MAW_PORT>` (default `3456`).
- **the plugin** — your process, listening on its own loopback port (or unix socket).

### 1. Register — `POST /api/_engine/register`

The plugin announces a prefix and the upstream maw should proxy it to.

```jsonc
// request body
{
  "plugin":   "rust-echo",                    // required, /^[a-z0-9-]+$/
  "prefix":   "/api/rust-echo",               // required, must start /api/, not /api/_engine
  "upstream": "http://127.0.0.1:56966",       // required, loopback http:// OR unix:///abs/path.sock
  "events":   ["agent-idle"],                 // optional, feed events to receive
  "eventPath":"/events",                      // optional, default /events
  "health":   "/health"                       // optional, GET path maw polls for liveness
}
```

```jsonc
// 201 Created
{ "ok": true, "bound": true, "registration": { "plugin": "...", "prefix": "...", "upstream": "...", "registeredAt": "ISO-8601", ... } }
// 400 on invalid body: { "ok": false, "error": "<reason>" }
```

**Validation** (from `registerEnginePlugin` / `normalize*`):
- `prefix` must start with `/api/`, must be more than just `/api/`, may **not** bind `/api/_engine*`, and must be a clean absolute path (no whitespace, `//`, or `..`). A trailing slash is stripped.
- `upstream` must be **loopback** `http://` (`127.0.0.1`, `localhost`, `::1`) **or** `unix:///absolute/path.sock`. Unix sockets must end in `.sock` and live under `tmpdir`/`/tmp` or `MAW_HOME` (so a plugin can't make maw a reverse proxy for, e.g., `/var/run/docker.sock`).
- One live binding **per plugin**: re-registering (e.g. after a restart) atomically replaces the previous prefix.

**Auth**: `/_engine/register` and `/_engine/unregister` are protected writes, but
**loopback callers are trusted by default** (`trustLoopback`), so a plugin on
`127.0.0.1` needs no token. If the operator sets `trustLoopback: false`, the
register call must carry the federation HMAC headers (out of scope for this PoC).

### 2. Proxy — any request matching the prefix

maw matches the **longest** registered prefix for `pathname` (`findEnginePluginRegistration`),
strips it, and forwards the suffix to the upstream (`proxyEnginePluginRequest`):

```
client →  POST /api/rust-echo/hi          (to maw:MAW_PORT)
maw    →  POST /hi                         (to upstream;  /api/rust-echo  →  empty suffix becomes "/")
```

maw, on the forwarded request:
- **deletes** the `host` header,
- **sets** `x-maw-engine-plugin: <plugin>` and `x-forwarded-prefix: <prefix>`,
- forwards the body for every method except `GET`/`HEAD`,
- uses `redirect: "manual"` (no auto-follow).

The upstream's response is returned to the client verbatim (status, headers,
body) **plus** the same two `x-maw-engine-plugin` / `x-forwarded-prefix` headers.
If the upstream is unreachable, maw replies **`503 {"ok":false,"error":"engine_plugin_unavailable",...}`** and **unbinds** the plugin.

### 3. Health — optional `GET <health>`

If `health` was registered, maw polls `GET upstream+health` (~every 5s, 1s
timeout) with the two `x-maw-*` headers. A non-2xx or a connection error
**unbinds** the plugin. Return `200` to stay registered.

### 4. Events — optional `POST <eventPath>`

If the plugin registered `events: [...]`, maw `POST`s each matching feed event as
JSON to `upstream+eventPath` (default `/events`). Delivery failure unbinds the plugin.

### 5. Unregister / list

- `POST /api/_engine/unregister` with `{ "plugin": "rust-echo" }` **or** `{ "prefix": "/api/rust-echo" }`.
- `GET /api/_engine/registrations` (public) → `{ ok, registrations: [...] }`.

---

## Run it

```bash
cargo build --release            # in this directory

# point it at a running maw serve (default port 3456):
MAW_PORT=3456 ./target/release/rust-echo
#   or:        ./target/release/rust-echo 3456

# exercise the gateway:
curl localhost:3456/api/rust-echo/hi -H 'X-Demo: 1' -d 'pong'
```

Expected echo (prefix stripped to `/hi`, gateway headers injected):

```json
{"plugin":"rust-echo","echo":{
  "method":"POST","path":"/hi","body":"pong",
  "headers":{ "...":"...", "x-demo":"1",
              "x-maw-engine-plugin":"rust-echo",
              "x-forwarded-prefix":"/api/rust-echo" }}}
```

## Reproduce the proof

`./smoke-test.sh` boots an **isolated** `maw serve` on a throwaway port + state
dir (it does not touch your real fleet), runs the plugin, asserts the echo
round-trip and the injected headers, then tears everything down. It skips
cleanly if `cargo` or `bun` is unavailable.

This was the verification run for #2566: registration shows up in
`/api/_engine/registrations`, `POST /api/rust-echo/hi` echoes `method:POST
path:/hi body:pong`, and both `x-maw-engine-plugin` and `x-forwarded-prefix`
are present.
