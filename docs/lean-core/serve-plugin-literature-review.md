# Literature Review: can `maw serve` become a plugin?

Status: discovery artifact (not an implementation proposal)

## Short answer

`maw serve` is still core gateway/kernel behavior, not an ordinary feature plugin.

A full extraction into a normal plugin is not currently feasible because the host process is what provides listener ownership, routing, auth boundaries, websocket upgrade plumbing, plugin lifecycle execution, and PID/status/stop semantics.

A **partial extraction** path is already working: keep a thin gateway host in core and move feature routes/surfaces behind serve registries and serve plugins.

## Evidence summary

`maw serve` currently owns or coordinates:

- CLI dispatch + process lifecycle (`serve`, `status`, `stop`, PID lock/takeover).
- Root HTTP listener + bind-host policy + optional TLS.
- Global CORS preflight behavior.
- `/api/*` dispatch ordering (engine proxy -> auth-preserving legacy path -> serve route registry -> legacy API).
- Federation-facing receive surfaces and startup warnings.
- Transport router wiring + long-lived maintenance timers.
- Serve lifecycle hooks and plugin system startup.

Key files:

- `src/cli/route-tools.ts`
- `src/cli/instance-pid.ts`
- `src/core/server.ts`
- `src/core/bind-host.ts`
- `src/core/serve-route-registry.ts`
- `src/core/serve-ws-registry.ts`
- `src/api/index.ts`
- `src/plugin/lifecycle.ts`

## Current extraction status (alpha snapshot)

The architecture has moved from hardcoded feature routes toward plugin-owned registration:

- Serve HTTP route registry is in core (`ServeRouteRegistry`) with plugin ownership/scoping.
- Serve websocket registry is in core (`ServeWsRegistry`).
- In-tree serve plugins now own multiple formerly hardcoded surfaces (for example `serve-views`, `serve-identity`, `serve-federation`, `serve-triggers`, `serve-worktrees`, `serve-debug`, `serve-ws`).

This means `server.ts` is increasingly a gateway/kernel rather than a feature route container.

## Core/kernel boundaries that should remain core

1. Listener/bind/TLS ownership (`Bun.serve` lifecycle).
2. PID/status/stop and signal cleanup contract.
3. Auth/CORS policy boundary and request dispatch ordering.
4. Engine plugin proxying and registration plumbing.
5. WebSocket upgrade kernel and ws registry dispatch.
6. Serve lifecycle orchestration + startup rollback behavior.

## What can continue moving out

1. Leaf `/api/*` modules and operator convenience endpoints.
2. UI/static fallback handling.
3. Federation route pack(s), after host policy seams remain explicit.
4. Additional long-lived services as plugin-owned processes via `engine.serve`.

## Recommended direction

1. Keep `maw serve` as the user-facing command for compatibility.
2. Treat internals as a **gateway host** model.
3. Continue extracting feature surfaces to serve registries/plugins.
4. Preserve stable kernel contracts for federation + SDK clients.
5. Re-evaluate only after core is mostly listener/auth/proxy/lifecycle primitives.

## Open design questions

1. Should `maw serve` remain a compatibility alias forever (even after deeper decomposition)?
2. Which federation endpoints are kernel-immutable versus plugin-pack owned?
3. Should websocket route registration be fully plugin-registerable for external plugins, or remain limited to trusted/in-tree kernels?
4. How should lifecycle teardown ownership be exposed for plugin-started timers/watchers?

## Related docs/issues

- `docs/federation/getting-started.md`
- `docs/federation/0001-peer-identity.md`
- `docs/lean-core/0001-plugin-tier-philosophy.md`
- `docs/lean-core/0002-aliases-vs-tier.md`
- Issue thread: `Soul-Brews-Studio/maw-js#2408`
