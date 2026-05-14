# Federation Routing Syntax

How `maw hey <target>` resolves the target string — the colon-form overload,
how cross-node forwarding emerges from a one-line split, and the two footguns
that surface when an agent name overlaps with something already named locally.

> Companion doc to [`docs/federation.md`](../federation.md) (the HTTP API
> reference). This doc covers the **client-side resolution** that happens
> before any HTTP call.

## TL;DR

- `node:agent` — federation routing (cross-node, e.g. `mba:homekeeper`)
- `session:window.pane` — local tmux canonical (e.g. `101-mawjs:0`)
- **These COLLIDE** — same shape, different meaning. `resolveTarget` (in
  [`src/core/routing.ts`](../../src/core/routing.ts)) disambiguates by trying
  local resolution first, then peer routing.

If you want to be unambiguous, write `node:agent` only when you mean a peer.
For local targets, prefer the bare name (`homekeeper`) or the numeric tmux
form (`101-mawjs:0`).

## Syntax Overload

A single `<query>` string can mean any of four things, depending on shape:

| Query | Most-likely meaning | Resolver step |
|---|---|---|
| `homekeeper` | local agent (bare name) | Step 1 — `findWindow` |
| `101-mawjs:0` | local tmux `session:window-index` | Step 1 — `findWindow` (numeric winPart) |
| `mawjs:oracle` | local tmux `session:window-name` | Step 1 — `findWindow` (named winPart) |
| `mba:homekeeper` | peer `node:agent` | Step 2 — `node:prefix` |

`resolveTarget` runs these in order ([`routing.ts:65`](../../src/core/routing.ts)),
short-circuiting on the first hit:

1. **Step 1 — Local first**: `findWindow(writable, query)` against the local
   tmux session list. Includes the fleet-config priority pass
   ([`routing.ts:83-99`](../../src/core/routing.ts)).
2. **Step 2 — `node:prefix`**: only fires if Step 1 returned `null` AND the
   query contains a `:`. Splits on the **first** colon
   ([`routing.ts:101-132`](../../src/core/routing.ts)) and looks the node up
   in `namedPeers`/`peers`.
3. **Step 3a — Manifest lookup**: bare-name resolution against the unified
   `OracleManifest` (sub-PR 3 of #841;
   [`routing.ts:134-146`](../../src/core/routing.ts)).
4. **Step 3b — Agents map**: bare-name fallback against `config.agents`
   ([`routing.ts:148-165`](../../src/core/routing.ts)).

The "local first" ordering is what produces both footguns below — when the
query looks like `oracle-world:100-pulse`, Step 1 may incorrectly claim it
before Step 2 ever sees the colon.

## Transitive Forwarding (Emergent)

Step 2 splits the query on the **first** colon only:

```ts
// routing.ts:103-105
const colonIdx = query.indexOf(":");
const nodeName = query.slice(0, colonIdx);
const agentName = query.slice(colonIdx + 1);
```

`agentName` is everything after the first `:` — passed verbatim as the
peer's `target` field ([`routing.ts:127`](../../src/core/routing.ts)). The
peer then runs its own local `resolveTarget` on that string.

This produces **transitive N-part syntax for free**. The codebase doesn't
implement multi-hop routing explicitly; the first-colon split + "peer's
local resolveTarget runs again" pattern composes into a cascade:

```
m5 sends:           mba:101-mawjs:0
m5 splits:          node=mba,  target="101-mawjs:0"
mba receives:       "101-mawjs:0"
mba resolves:       Step 1 findWindow → local tmux session:window
```

And recursively:

```
m5 sends:           mba:oracle-world:101-mawjs:0
m5 splits:          node=mba,  target="oracle-world:101-mawjs:0"
mba receives:       "oracle-world:101-mawjs:0"
mba resolves:       Step 2 (mba doesn't host "oracle-world" locally)
                    → forwards as node=oracle-world, target="101-mawjs:0"
oracle-world receives: "101-mawjs:0" → local tmux
```

This is **emergent**, not designed — there is no "multi-hop forwarder"
module. It only works because every hop's `resolveTarget` is identical and
the wire format passes the rest verbatim. Don't accidentally regress it.

## Footgun #1 — agent name collides with namedPeer name

**Symptom.** A bare query like `oracle-world` resolves to a local agent
when an `agents`/manifest entry AND a `namedPeer` both carry the same name.

**Why.** Step 3b's agents-map lookup ([`routing.ts:148-151`](../../src/core/routing.ts))
matches the bare name against `config.agents` and returns immediately if
found. `namedPeers` is never consulted for bare-name routing — only when
the query carries the `node:agent` colon form (Step 2). So a config that
has both `agents.oracle-world = local` and `namedPeers[].name = "oracle-world"`
silently picks the local agent.

The user's intent is ambiguous from the string alone. The current resolver
just commits to "local wins."

**Workaround.** Use the explicit colon form when you mean the peer:

```bash
maw hey oracle-world:some-agent  # unambiguous → peer routing (Step 2)
maw hey oracle-world             # ambiguous → resolves local
```

**Future fix.** Surface this at config-load time (fleet doctor warning), so
the user knows their config has a collision *before* a send silently goes
to the wrong place. See [#1323](https://github.com/Soul-Brews-Studio/maw-js/issues/1323).

## Footgun #2 — tmux session strip-prefix shadow

**Symptom.** A query like `oracle-world:100-pulse` resolves to a local
tmux session (e.g. `30-oracle-world`) instead of routing to the
`oracle-world` peer — *because the local session name has an oracle-style
`NN-` prefix that strips to match the query*.

**Why.** `matchSession` in `find-window.ts` ([`find-window.ts:56-68`](../../src/core/runtime/find-window.ts))
tries three strategies, in order, even in strict mode:

```ts
// find-window.ts:60-66
// 1. Exact
for (const s of sessions) if (s.name.toLowerCase() === p) return s;
// 2. Oracle-name (strip "NN-" prefix)
for (const s of sessions) if (s.name.toLowerCase().replace(/^\d+-/, "") === p) return s;
// 3. Substring (skip in strict mode — prevents "white" matching "whitekeeper")
if (!strict) {
  for (const s of sessions) if (s.name.toLowerCase().includes(p)) return s;
}
```

Strict mode (passed from `findWindow`'s `session:window` branch) suppresses
strategy 3, but **strategies 1 and 2 still fire**. A local session named
`30-oracle-world` matches the query part `oracle-world` via strip-prefix
on line 62.

`findWindow` then enters its `session:window` branch ([`find-window.ts:75-89`](../../src/core/runtime/find-window.ts)),
finds no matching window, and falls through.

**Pre-PR-#1322 bug.** The bottom fallback at the end of `findWindow` used
to return the raw query string in this case, which made `resolveTarget`
treat it as a local hit and never try Step 2 peer routing.

**PR #1322 fix.** The fallback ([`find-window.ts:136-148`](../../src/core/runtime/find-window.ts))
now returns `null` when the session matched but the window part didn't
resolve and isn't a literal numeric tmux index:

```ts
// find-window.ts:141-148 — PR #1322
if (query.includes(":")) {
  const [sessPart, winPart] = query.toLowerCase().split(":", 2);
  const sessExists = matchSession(sessions, sessPart, true);
  if (!sessExists) return null;
  if (!winPart) return query;
  if (/^\d+$/.test(winPart)) return query;
  return null;  // ← was: return query
}
```

Returning `null` lets `resolveTarget` Step 2 take over and route to the
peer ([`routing.ts:101-132`](../../src/core/routing.ts)).

**Future fix.** Reorder: when the query has a `:` AND the prefix matches a
known peer in `namedPeers`, run Step 2 *before* Step 1. The matched-peer
case is a strong signal of intent that local resolution can't claim
without the user spelling it out. See [#1324](https://github.com/Soul-Brews-Studio/maw-js/issues/1324).

## Recommended Patterns

| Use case | Pattern |
|---|---|
| Send to peer agent | `maw hey node:agent` (explicit, never ambiguous) |
| Send to local agent | `maw hey agent-name` (bare; resolves via Step 1) |
| Send to specific local window | `maw hey session:window` (local) |
| Send to specific window on peer | `maw hey node:session:window` (transitive — see above) |
| Send to specific local pane | `maw hey session:window.pane` (e.g. `101-mawjs:0.1`) |

Prefer the **explicit** form (`node:agent`) when crossing nodes — it costs
one extra word and removes every ambiguity above.

## Future Work

- **Step 0 reorder.** Peer-name match takes priority when the query has
  `:` and the prefix matches a `namedPeer`. See
  [#1324](https://github.com/Soul-Brews-Studio/maw-js/issues/1324).
- **Explicit local override.** `local:foo` as an unambiguous way to force
  Step 1 even when `foo` collides with a peer name.
- **Fleet doctor collision warning.** Surface agent/peer/session name
  collisions at config-load time. See
  [#1323](https://github.com/Soul-Brews-Studio/maw-js/issues/1323).
- **Config schema RFC.** Normalize `maw.config.json` so `agents` /
  `namedPeers` / `peers` can't drift into shapes that produce these
  collisions silently. See
  [`ψ/inbox/2026-05-14_rfc-normalize-maw-config-schema.md`](https://github.com/Soul-Brews-Studio/mawjs-oracle)
  in the mawjs-oracle vault.

## History

- **2026-05-14** — Footguns #1 and #2 discovered cross-node from
  `m5:oracle-worlds-machine` while routing `maw hey` traffic into
  `oracle-world`. PR #1322 fixed Footgun #2's `find-window.ts` fallback
  (return `null` instead of the raw query when the session matched via
  strip-prefix but the window didn't resolve). This doc captures both
  footguns + the transitive-forwarding behavior so the next contributor
  doesn't have to re-derive them from the resolver code.
