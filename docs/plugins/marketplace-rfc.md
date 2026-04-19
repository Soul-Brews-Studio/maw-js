# Plugin marketplace — RFC (federated search vs central registry)

Status: DRAFT — discussion, no code lands from this doc alone.
Tracking issue: [#623](https://github.com/Soul-Brews-Studio/maw-js/issues/623)
Prerequisite: [#402 — plugins must work standalone](https://github.com/Soul-Brews-Studio/maw-js/issues/402)
Owner: marketplace-scoper (team go-5-r5-0419)
Date: 2026-04-19

## Problem

70+ plugins exist under `src/commands/plugins/` and shipped via
`maw plugin build`. Discovery today is essentially:

1. Read the source tree on a given oracle, or
2. Query the community registry manifest (`registry.json`) — a single JSON file
   that only lists plugins their authors explicitly PR'd in.

Adopting a plugin that another oracle has written and uses locally — but never
published to the manifest — is **manual**: you ask in chat, they send you a
tarball or a GitHub URL, you `maw plugin install` it.

We want to make peer-to-peer plugin discovery first-class without committing
to an "app store" we'd have to moderate.

## Prior art (today, in-tree)

- `maw plugin init <name> --ts` — scaffold a TS plugin
  (`src/commands/plugins/plugin/init-impl.ts`).
- `maw plugin build [dir]` — bundle + pack a plugin
  (`src/commands/plugins/plugin/build-impl.ts`).
- `maw plugin install <name|dir|.tgz|URL>` — install; plain name → registry
  lookup via `registry-resolve.ts`.
- `maw plugin search <q>` — substring match over the registry manifest
  (`runSearchCmd` in `src/commands/plugins/plugin/index.ts`).
- `maw plugin info <name>` — show registry entry for a plugin.
- `maw plugin registry` — print registry URL + cached entry count.
- Community registry manifest — `https://maw.soulbrews.studio/registry.json`,
  override via `MAW_REGISTRY_URL`, cached 5 min at `~/.maw/registry-cache.json`
  (`registry-fetch.ts`). Schema v1: `{schemaVersion, updated, plugins: {name: {version, source, sha256, summary, author, license, homepage?, addedAt}}}`.
- `plugins.lock` — sha256 pins are the actual trust boundary
  (`registry-fetch.ts` header note: *"registry trust is advisory"*).
- `maw oracle scan --remote` — walks GitHub orgs for `*-oracle` repos
  (`src/commands/plugins/oracle/impl-scan.ts`). Proven mechanism for "discover
  what other oracles exist."
- `maw peers` — persistent peer registry + federation transport (already in use
  for `maw hey`, `work-with`, etc.).

So we already have:
- a minimal central registry (append-only JSON, PR'd by humans);
- a working federation transport to peers;
- a remote scan that enumerates oracles across GitHub orgs.

The marketplace question is "how do we bridge plugin discovery onto peers
rather than only the central manifest."

## Shape A — Federated search

**Idea**: `maw plugin search <q>` additionally walks known peers (from
`peers.json` and/or `maw oracle scan --remote`), asks each for their plugin
manifest, and merges the results.

### Concept

- Each oracle exposes `GET /plugins/manifest.json` (or equivalent
  peer-transport verb) listing the plugins it has locally under
  `src/commands/plugins/` — name, version, summary, source path/URL, optional
  sha256.
- `maw plugin search <q> [--peers] [--remote]` fans out, dedupes by
  `{name, version}`, and prints a merged hit list with the peer that offered
  each hit.
- `maw plugin install <name>@<peer>` fetches a tarball directly from the
  named peer via the same transport, then hands off to the existing
  `install-impl.ts` pipeline (still subject to `plugins.lock` sha256 pinning).
- No central moderator. The community manifest stays as a "known-good" set;
  peers augment it.

### Mock CLI output

```
$ maw plugin search oracle

  registry (maw.soulbrews.studio):
    oracle          1.4.0   oracle mgmt — list, scan, about, prune, register
    oracle-scan     0.3.1   scan github orgs for *-oracle repos

  peers (3 queried, 3 responded in 0.6s):
    oracle-lens     0.2.0   2d federation lens        @mawui
    oracle-mood     0.1.0   emotional state telemetry @david
    oracle          1.5.0-beta @arra (newer than registry)

  hint: `maw plugin install oracle-lens@mawui` to fetch from a peer
```

```
$ maw plugin search --peers-only tarot

  peers (3 queried, 3 responded in 0.4s):
    tarot-daily     0.1.0   daily card draw → ψ/inbox  @neo
    tarot-spread    0.2.0   3-card / celtic-cross      @neo

  no registry hits
```

### Cost

~200 LOC, mostly in `src/commands/plugins/plugin/`:
- new `search-peers.ts` — fan out over `peers.json`, collect manifests, merge.
- new peer handler — "list my local plugins" (a `getLocalPluginManifest()`
  scan of `src/commands/plugins/<name>/plugin.json`).
- extend `runSearchCmd` with `--peers` / `--remote` / `--peers-only` flags.
- extend `install-impl.ts` with `@<peer>` suffix parsing → peer tarball fetch.

No new infrastructure, no new hostname, no new trust anchor, no new team
ownership. Reuses: `peers.json`, peer transport, `plugins.lock` sha256 pins.

### Risks

- **Peer churn** — peers go offline; short timeouts + `(offline)` markers.
- **Peer trust** — untrusted peer offers malicious plugin. Mitigation: sha256
  pin on install (existing `plugins.lock` flow) + prompt before installing
  from a previously-unused peer.
- **Name collisions** — two peers ship same-named plugins. Mitigation: search
  output always shows `@<peer>`; install requires disambiguation.
- **Discovery scope** — what's "known peers"? (1) `peers.json` only (fastest,
  misses strangers); (2) `peers.json` + oracles from `maw oracle scan --remote`
  (broader, slower); (3) explicit `--peer <name>` only. Recommended: 1 by
  default, 2 behind `--broad`, 3 always available.

## Shape B — Central registry

**Idea**: Full `plugins.mawjs.io` — a hosted service with signed artifacts,
versioned API, search endpoint, publish/unpublish verbs, moderation, a web
UI. Think npm-lite scoped to maw plugins.

### Concept

- New service: registry API + artifact CDN + web UI.
- Sigstore / minisign signing on every published tarball.
- `maw plugin publish <dir>` — push a built tarball to the registry; registry
  verifies signer's claimed identity (GitHub OIDC or keypair).
- `maw plugin search <q>` hits the registry's search API (ranked,
  faceted, categories, downloads).
- Registry is canonical; `plugins.lock` still pins sha256 as defense-in-depth.
- Web UI at `plugins.mawjs.io` browses plugins, lists maintainers, shows
  README / changelog.

### Cost

Months:
- server: API + search index (Meilisearch/Typesense) + artifact storage +
  signing verification + moderation tooling.
- client: publish/unpublish verbs; ranked search; category metadata; browse.
- ops: someone maintains this forever. DNS, TLS, abuse reports, takedowns,
  author identity recovery, compromised-key revocation.
- legal: ToS, DMCA, trademark, PII, GDPR if EU users publish.

### Risks

- **Trust anchor** — a central registry is a single point of compromise; if
  the signing key / DB is owned, every user's next `maw plugin install` can
  ship a backdoor. Mitigated by signing + reproducible builds, but the attack
  surface grows.
- **Governance** — who decides what's allowed, what gets taken down, which
  namespaces are reserved? Introduces a political layer the project doesn't
  have today.
- **Philosophical fit** — maw is federation-first ("External Brain, Not
  Command"; "Patterns Over Intentions"). A central index is the opposite
  shape of every other maw primitive (peers, fleet, oracle-scan).
- **Lock-in** — once everyone's on `plugins.mawjs.io`, moving off it (hosting
  cost, domain loss, policy drift) becomes a painful migration.

## Comparison

| Axis                 | Shape A — Federated | Shape B — Central registry |
| -------------------- | ------------------- | -------------------------- |
| Friction to publish  | zero (every peer is already a publisher by default) | `maw plugin publish` + signer setup + account |
| Friction to discover | `maw plugin search --peers` queries N peers in parallel | single GET, ranked results, likely faster |
| Dev cost             | ~200 LOC in-tree    | months of server + client + ops |
| Ongoing ops          | none beyond `peers.json` | DNS/TLS/search infra/moderation forever |
| Trust anchor         | per-peer (already have sha256 pins) | central signing key + CA |
| Governance           | none needed         | ToS, takedowns, reserved names, abuse |
| Moderation surface   | self-selected peer graph | public submission inbox |
| Offline behavior     | degrades to registry-only search | fails (or falls back to local cache) |
| Philosophical fit    | high — reuses peers, fleet, oracle-scan | low — introduces a command layer |
| Reversibility        | delete the two new files | migrate users off the domain |

## Recommendation

**Ship Shape A first.** Revisit Shape B only if:

1. Shape A adoption proves there's real demand for cross-oracle plugin
   sharing (i.e. people actually install plugins from each other's peers),
   **and**
2. The federated approach visibly breaks down — e.g. churn / latency / trust
   issues that central infra would have solved.

Reasons:

- Reuses every primitive we already have (`peers.json`, peer transport,
  sha256 pins, manifest format) in ~200 LOC.
- Reversible — delete two files if it's wrong. Shape B commits to years of ops.
- Shape B can be built *on top of* Shape A later (one well-known peer that
  happens to host a canonical manifest) without invalidating install paths.
- Federation-first is the shape of every other maw primitive.

## Prerequisite — #402

Plugins must load standalone before either shape ships. Today some plugins
use `src/...` relative imports that only resolve inside the maw-js tree and
break once installed to `~/.maw/plugins/<name>/`. Shape A worsens this by
encouraging installs from peers the caller can't audit. #402 assumed to
land first.

## Non-goals (this RFC)

- Plugin categories, ratings, reviews, downloads telemetry (Shape B concern).
- Changes to `plugins.lock` — sha256 pinning is unchanged.
- A web UI.
- Removing the existing community `registry.json` — it stays as the curated
  "known-good" set and survives both shapes.

## Open questions

1. Do we add peer plugin manifests as a new `peers.json` capability, or scan
   on demand? (Recommended: scan on demand, cache per-peer for 5 min like the
   existing registry cache.)
2. Should `maw plugin search --peers` include the originating peer's `oracle`
   identity (e.g. `@neo`) or their host (e.g. `@white.fleet.local`)? The name
   is friendlier; the host is harder to spoof. Probably both, formatted as
   `@<oracle>(<host>)`.
3. What happens when a peer reports a plugin with the same name but different
   `sha256` than `plugins.lock` has pinned? Today the lock wins silently;
   under Shape A we should probably warn loudly.
4. Federation auth: does "I'm peer X" need stronger proof than `peers.json`
   currently provides before we trust their plugin manifest? See ongoing
   federation work for the broader picture.

## What "next" looks like

If the team agrees Shape A is the right call:

1. Close the design phase by resolving the four open questions above.
2. File an implementation issue with a concrete API:
   - new peer verb: `plugin.listManifest` → `RegistryManifest`-shaped subset
   - new CLI flags: `--peers`, `--peers-only`, `--broad`, `--peer <name>`
   - new install syntax: `<name>@<peer>`
3. Land behind a feature flag (`MAW_PLUGIN_PEER_SEARCH=1`) for a release, then
   default on.

If Shape A ships and demand clearly outgrows it, revive this RFC for Shape B.
