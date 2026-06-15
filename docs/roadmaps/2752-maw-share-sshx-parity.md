# #2752 maw share ← sshx parity roadmap

## Requirements summary

`maw share` remains the native lightweight read-only viewer. sshx parity is delivered as additive, opt-in serve-hook plugins that compose into the existing `maw serve` daemon instead of replacing share or creating a second daemon.

## RALPLAN-DR summary

### Principles
- Preserve the read-only `maw share` charter unless a later issue explicitly approves multi-user write sharing.
- Keep add-ons small, opt-in, and independently shippable.
- Put UI-heavy work in viewers; keep maw as the authenticated data relay.
- Reuse the existing share slug/token/auth model for all collaboration side channels.

### Decision drivers
1. Avoid expanding the trusted write/RCE surface by default.
2. Keep each add-on easy to test with route-level and real-entry smokes.
3. Let `maw serve` remain the single relay process for share, presence, chat, and cursors.

### Viable options
- **Option A — small opt-in data plugins (chosen):** one plugin per side channel (`share-presence`, `share-chat`, `share-cursors`). Pros: low blast radius, easy rollback, aligns with existing serve hooks. Cons: multiple endpoint contracts for frontend to consume.
- **Option B — monolithic collaborative share plugin:** one plugin owns all sshx parity. Pros: one frontend contract. Cons: larger trusted surface and harder phased delivery.
- **Option C — delegate to sshx:** integrate by launching/embedding sshx. Pros: fastest feature parity. Cons: violates “nothing is deleted”, adds operational dependency, and does not improve native share.

## Phased roadmap

| Phase | Scope | maw responsibility | Acceptance |
| --- | --- | --- | --- |
| P-A1 presence | Already landed as `share-presence` (#2773). | `/ws/share/:slug/presence`, viewer IDs/names, snapshots. | Opt-in, read-only, token-verified. |
| P-A2 chat | Ephemeral chat relay for valid share viewers. | `/ws/share/:slug/chat`, sanitized viewer names/text, no persistence. | Opt-in via `maw share --chat`, read-only, token-verified. |
| P-A3 cursors | Read-only cursor presence. | Relay normalized cursor positions only. | Opt-in, rate-limited, no pane writes. |
| P-B canvas | Infinite canvas, move/resize/zoom/pan. | No core daemon work unless metadata gaps appear. | Viewer feature backed by share metadata. |
| P-C polish | Toolbar, better errors, toasts. | Serve metadata/error affordances as needed. | No raw “Share not found” in polished clients. |
| P-D write collaboration | Multi-user input + predictive echo. | Separate charter decision; builds on `serve-control`, not default share. | Explicit write token, audit/rate limits, separate issue. |

## First implemented slice in this PR

Implement **P-A2 `share-chat`** because `share-presence` has already merged and chat is the next small sshx parity add-on that does not require write-sharing.

## Acceptance criteria

- `maw share --chat` posts `{ chat: true }` to the daemon and `/api/share/:slug` returns `chat: true` only for chat-enabled shares.
- `share-chat` registers `/ws/share/:slug/chat` only when the opt-in plugin is enabled.
- Chat WebSockets verify the existing share token/proof before joining.
- Chat is denied for valid shares that were not created with `--chat`.
- Chat payloads are ephemeral, sanitized, length-bounded, broadcast to current viewers, and do not import tmux or pane write helpers.
- Existing share, presence, and control behavior remains unchanged.

## Implementation steps

1. Extend `src/vendor/mpr-plugins/share/impl.ts` and `src/vendor/mpr-plugins/share/index.ts` with a `chat` share flag, CLI `--chat`, daemon create request support, and metadata exposure.
2. Add `src/vendor/mpr-plugins/share-chat/` as an extra-tier serve-hook plugin with `/ws/share/:slug/chat`.
3. Add unit and standalone boundary coverage for chat, plus share CLI/metadata coverage for `--chat`.
4. Verify with targeted tests, isolated tests as practical, and `bun run build`.

## ADR

**Decision:** Deliver sshx parity as additive serve-hook plugins, with this PR shipping `share-chat` as the next first slice after presence.

**Drivers:** read-only safety, small independent PRs, reuse of existing share auth.

**Alternatives considered:** monolithic collaborative share, replacing share with sshx, and jumping directly to multi-user write-sharing.

**Why chosen:** `share-chat` provides visible collaborative value while keeping maw’s trusted surface small and read-only-compatible.

**Consequences:** Frontends consume another side-channel endpoint; later cursor/write phases can follow the same pattern.

**Follow-ups:** `share-cursors`, viewer UI for chat/presence, and a separate write-collaboration charter issue.
