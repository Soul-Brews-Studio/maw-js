# Rust Gateway Binary Contract

This document defines the interface between the TypeScript `maw serve` launcher and
`packages/maw-gateway`, the Rust gateway binary. The goal is to keep the gateway
boundary stable while Phase 3 evolves from an HTTP reverse proxy to a richer IPC
front door.

## Process model

`maw serve --gateway rust` is still orchestrated by the TypeScript CLI:

1. TypeScript selects the Rust gateway via `src/core/gateway.ts`.
2. TypeScript starts the Bun backend on a backend port, currently `PORT + 1`.
3. TypeScript starts `maw-gateway` on the public gateway port and passes the
   backend port to it.
4. The Rust process owns the public listener. Bun owns internal application
   handlers behind the Rust process.

The Rust gateway must be safe to supervise as a child process: stdout/stderr are
machine-observed during startup, and process exit is treated as gateway failure.

## CLI surface

The supported invocation shape is:

```sh
maw-gateway serve [--port PORT] [--backend PORT] [--verbose]
```

### `serve`

Required subcommand. Any other first argument is a usage error and exits nonzero.

### `--port PORT`

Public Rust listener port.

- Default: `3456` when omitted.
- Accepted forms: `--port 3456` and `--port=3456`.
- This is the port clients connect to for HTTP and WebSocket traffic.

### `--backend PORT`

Internal Bun backend port.

- Accepted forms: `--backend 3457` and `--backend=3457`.
- When `maw-gateway` is launched by TypeScript, this is currently `--port + 1`.
- The same value is also exposed to the child environment as
  `MAW_BACKEND_PORT`.
- When omitted, the Rust process may run only Rust-native routes; proxy routes
  should fail explicitly rather than silently routing somewhere else.

### `--verbose`

Verbose logging opt-in for the Rust process.

- The flag is part of the gateway contract even if a specific implementation
  has not yet expanded logging behavior.
- Implementations should treat it as additive logging only. It must not change
  routing, health semantics, or readiness output.
- Short verbosity flags are owned by `maw serve`; the binary contract reserves
  the long `--verbose` form.

Unknown flags are usage errors. Usage errors must write a concise usage message
to stderr and exit nonzero.

## Readiness signal

The readiness signal is stdout line:

```text
listening on :PORT
```

Where `PORT` is the public Rust listener port.

The TypeScript supervisor waits for this exact substring before considering the
Rust gateway ready. This line must be emitted only after the public listener is
bound and able to accept connections.

Other logging may appear before or after readiness, but it must not replace or
rename this readiness line.

## Environment allowlist

The TypeScript launcher intentionally passes a narrow environment to the Rust
child. Secrets such as API keys must not be forwarded by default.

Allowed environment variables are:

- `PATH` — lets the process and any controlled child tools resolve binaries.
- `HOME` — preserves normal OS/user lookup behavior.
- `MAW_GATEWAY_BIN` — optional launcher override used by tests and local dev.
- `PORT` — public Rust listener port, matching `--port`.
- `MAW_BACKEND_PORT` — internal Bun backend port, matching `--backend`.
- `MAW_HOME` — maw state/config home override.
- `XDG_CONFIG_HOME` — config-root override used by maw config loading.

If new environment variables are needed, add them deliberately to the allowlist
and document why they are safe to expose to the Rust child.

## Route ownership

The Rust gateway is the public network front door. Route ownership is split as
follows.

### Rust-native routes

`GET /api/health` is Rust-native and must not proxy to Bun.

The health response is JSON and must identify the Rust gateway, for example:

```json
{
  "ok": true,
  "gateway": "rust",
  "port": 3456,
  "backend_port": 3457
}
```

During Phase 3 the stable intent is to expose backend identity as Bun on the
backend port. Implementations may add a higher-level field such as
`"backend": "bun:3457"`, but must preserve the Rust gateway identity.

### Proxied routes

Everything except Rust-native routes is owned by the Bun backend and should be
proxied to `http://127.0.0.1:BACKEND_PORT`.

This includes, but is not limited to:

- ordinary API routes such as `GET /api/ui-state`
- JSON POST routes such as `POST /api/ask`
- missing routes, whose status/body should reflect the Bun backend response
- WebSocket upgrade routes such as `/ws` and `/ws/*`

The proxy must preserve request method, path, query string, body, and relevant
headers such as cookies and authorization headers. It should avoid leaking
hop-by-hop headers when forwarding.

### Backend failure behavior

If the Rust gateway is running but the Bun backend is unavailable, proxied HTTP
routes must return an explicit gateway error such as `502 Bad Gateway` or
`503 Service Unavailable`. The Rust process must not crash just because the
backend is down.

If the backend exits after the gateway is ready, subsequent proxied requests
should also return `502`/`503` until the supervisor restarts or replaces the
backend.

## WebSocket proxy contract

WebSocket routes are transparent proxy routes to Bun.

- A client connecting to `ws://HOST:PORT/ws` or `ws://HOST:PORT/ws/*` connects
  to the Rust public port.
- Rust upgrades the client connection and opens a corresponding backend
  WebSocket connection to the Bun backend.
- Frames from client to backend and backend to client are forwarded without
  changing payload contents.
- Close frames and connection errors should cleanly close both sides.

The WebSocket proxy should share the same backend failure behavior as HTTP:
connection failure should be visible to the client, not crash the Rust process.

## IPC direction

The current Phase 3 IPC contract is HTTP/WebSocket reverse proxying:

```text
client -> Rust gateway (:PORT) -> Bun backend (:MAW_BACKEND_PORT)
```

Future phases may replace or supplement the internal hop with a Unix domain
socket or another structured IPC channel. That future IPC should preserve the
same public contract:

- Rust remains the public listener.
- `/api/health` remains Rust-native.
- Bun-owned application routes remain reachable through the Rust gateway.
- The readiness signal remains `listening on :PORT` on stdout.
- The TypeScript launcher remains responsible for explicit environment
  allowlisting and child-process supervision unless a later contract replaces it.

## Operational notes

- Before starting the Rust gateway, TypeScript may clear existing processes on
  the public and backend ports as a best-effort takeover step.
- The Rust binary should not assume privileged ports or external network access;
  current listeners bind loopback.
- Logs may be consumed by humans and tests. Keep readiness machine-stable and
  route logs best-effort.
