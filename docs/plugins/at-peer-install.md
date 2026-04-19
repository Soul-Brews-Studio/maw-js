# `@peer` install syntax — design + error matrix

> Ship-scope follow-up to #631 (federated search) and companion to #588
> (install pipeline). Implements:
>
> ```
> maw plugin install <name>@<peer>
> ```
>
> Resolves the peer's manifest via `searchPeers`, downloads its tarball,
> feeds it through the existing `installFromTarball` path. `plugins.lock`
> remains the trust root — `@peer` is a *discovery convenience*, not a
> bypass.

---

## 1. Shape of the user flow

```text
$ maw plugin install ping@mawjs-parent
→ searching mawjs-parent for 'ping'…
→ mawjs-parent advertises: ping@1.0.0 (sha256: 9a34…)
→ downloading http://mawjs-parent.internal:2700/api/plugin/download/ping…
→ verifying artifact hash…
✓ ping@1.0.0 installed
  sdk: ^1.0.0 ✓ (maw 26.4.x)
  mode: installed (sha256: 9a34…)
  dir: ~/.maw/plugins/ping
  source: mawjs-parent (http://mawjs-parent.internal:2700)
try: maw ping
```

The leading `→` lines are progress notes; the `✓` block is the existing
`printInstallSuccess` output with a new `source:` row.

---

## 2. Parse rules — when does `@peer` trigger?

Order of source-type detection in `detectMode()` is preserved. A new
`kind: "peer"` branch is inserted **before** the fallback-to-dir rule.

A string is `@peer` iff ALL of:

- does not start with `http://` or `https://`   (URL beats @peer)
- does not end with `.tgz` or `.tar.gz`         (tarball beats @peer)
- does not start with `/`, `./`, or `../`       (explicit path beats @peer)
- contains exactly one `@` character
- the substring after `@` is a non-empty identifier `[A-Za-z0-9][A-Za-z0-9._-]*`
- the substring before `@` is a non-empty plugin name `[a-z][a-z0-9-]*`

Examples:

| input                       | kind      | why                                    |
|-----------------------------|-----------|----------------------------------------|
| `./ping/`                   | dir       | starts with `./`                       |
| `ping-1.0.0.tgz`            | tarball   | ends with `.tgz`                       |
| `http://x/ping.tgz`         | url       | `http://` prefix                       |
| `ping@mawjs-parent`         | peer      | two valid identifiers split by `@`     |
| `ping@node-A.internal`      | peer      | allowed chars in peer                  |
| `ping@1.0.0`                | peer*     | syntactically valid — resolver rejects |
| `@foo@bar`                  | error     | two `@` signs                          |
| `ping@`                     | error     | empty peer                             |
| `./ping@mawjs-parent`       | dir       | starts with `./`, no peer resolution   |

`*` for `ping@1.0.0`: parser accepts; resolver calls searchPeers, the
peer named `1.0.0` is not found in `namedPeers` → clean `unknown peer`
error. We do **not** try to disambiguate this in the parser. "Use a
semver-looking peer name" is self-inflicted.

---

## 3. Wire path

```
cmdPluginInstall(args)
  └─ detectMode(src) → { kind: "peer", name, peer }
       └─ resolvePeerInstall({ name, peer })           NEW
            ├─ searchPeers(name, { peer })             existing (#631)
            ├─ pick hit where hit.name === name
            ├─ error if 0 hits / > 1 hit / peer error
            └─ return { downloadUrl, peerSha256, peerName, peerNode }
       └─ installFromUrl(downloadUrl, …opts)           existing (#588)
            └─ installFromTarball (…)                  existing
                 └─ verifyArtifactHash → plugins.lock gate → move into root
```

Post-install cross-check (Phase A, in resolvePeerInstall caller):
compare `peerSha256` (from searchPeers) against `manifest.artifact.sha256`
in the installed tarball. If they differ → WARN + ABORT (leave the
install in place for now — the lock gate already refused it if plugins.lock
disagrees; this is an extra diagnostic only when lock didn't trigger).

---

## 4. Peer-side additions

### 4.1. `PeerPluginEntry.downloadUrl` (additive)

`src/api/plugin-list-manifest.ts` — current schema v1 response today is
`{name, version, summary?, author?, sha256?}`. Add:

```ts
export interface PeerPluginEntry {
  name: string;
  version: string;
  summary?: string;
  author?: string;
  sha256?: string | null;
  downloadUrl?: string;   // NEW
}
```

The peer computes `downloadUrl` as a relative path — e.g.
`/api/plugin/download/ping` — and the client joins it against the
peer's base URL. This keeps the manifest portable across base-URL
changes and avoids leaking the peer's idea of its own hostname.

`schemaVersion` stays at `1`: the field is additive and older clients
ignoring it still work. The `isManifest` type guard in `search-peers.ts`
only checks for `name`/`version` on entries, so no change needed there.

### 4.2. `GET /api/plugin/download/:name` endpoint

New file: `src/api/plugin-download.ts`. Mounted in `src/api/index.ts`
alongside `pluginListManifestApi`.

Behaviour:

1. Lookup `discoverPackages()` for an entry with `manifest.name === :name`.
2. 404 with JSON `{ error: "plugin not installed", name }` if absent.
3. Reject plugins whose install dir is a symlink (dev `--link`) — these
   are the author's working tree; serving them defeats sha256 semantics.
   Response: 409 `{ error: "plugin is --link (dev)", name }`.
4. `tar -czf - -C <pluginDir> .` → stream as `application/gzip`.
5. Header `Content-Disposition: attachment; filename="<name>-<version>.tgz"`.
6. Guarded by the existing federationAuth HMAC middleware (inherited via
   `src/api/index.ts` mount point — no new auth surface).

The tarball sha256 is **not** what the client verifies — the client
extracts the tarball and hashes `manifest.artifact.path` (the actual
plugin code file). That hash is deterministic across re-tars because
it's a hash of a single file, not of the archive.

---

## 5. Failure modes (error matrix)

| scenario                                         | where caught                                | message                                                                 | exit |
|--------------------------------------------------|---------------------------------------------|-------------------------------------------------------------------------|------|
| peer not in `namedPeers`                         | `resolvePeers()` (existing)                 | `unknown peer '<peer>' — not in namedPeers`                             | 1    |
| peer offline / unreachable                       | `searchPeers` → `errors[]`                  | `peer '<peer>' unreachable — check URL, retry with: maw plugin install <name>@<peer>` | 1    |
| peer responded, plugin not in its manifest       | `resolvePeerInstall` hit-filter             | `no plugin named '<name>' on peer '<peer>'.\navailable: <list>`         | 1    |
| peer returned multiple versions of the same name | `resolvePeerInstall` hit-filter             | should not occur (peer has one install per name); if it does → ambiguity error listing versions | 1    |
| peer returned downloadUrl but served non-gzip    | `downloadTarball` content-type gate         | `unexpected content-type …` (existing)                                  | 1    |
| peer-advertised sha256 ≠ installed-artifact sha256 | post-install cross-check                  | `sha256 mismatch vs peer manifest — refusing install.\n  peer said: …\n  actual:    …`  | 1    |
| plugin not in plugins.lock, no `--pin`           | existing `installFromTarball` lock gate     | existing (`plugin '<name>' not in plugins.lock — run: maw plugin pin …`) | 1    |
| plugins.lock sha256 ≠ downloaded artifact sha256 | existing lock gate                          | existing (`lockfile hash did not match — this is the real adversarial check`) | 1    |
| SDK mismatch                                     | existing SDK gate                           | existing `formatSdkMismatchError`                                       | 1    |

---

## 6. Non-goals for this PR

- **Peer discovery UX**: `maw plugin install ping` (no `@peer`) still
  means local sources only. Future ticket may fall through to searching
  all peers if nothing matches locally — out of scope here.
- **Version suffix**: `maw plugin install ping@1.0.0@mawjs-parent` —
  deferred. The peer currently exposes only one install per name, so
  there's no need yet.
- **--pin-from-peer**: accepting the peer-advertised sha256 directly
  into plugins.lock without re-download. Unsafe if peer lies; out of
  scope.
- **Caching tarballs on peer**: current design re-tars on each request.
  If that becomes a bottleneck, a build-time cache in
  `~/.maw/tarball-cache/` is a follow-up, not a blocker.

---

## 7. Test plan

### 7.1. Unit

- `parse name@peer` — exhaustive table against the §2 rules.
- `resolvePeerInstall` with injected `searchPeers` — 0 hits, 1 hit,
  peer-error, multi-hit-same-name.
- peer-sha256 cross-check mismatch behaviour.

### 7.2. Integration (the 2-port demo referenced in the task)

`test/integration/plugin-install-at-peer.test.ts`:

1. Spin up TWO maw-js API servers on localhost:5701 + localhost:5702
   with different `MAW_PLUGINS_DIR`s.
2. Seed port 5701 with a built `ping` plugin (artifact + sha256).
3. Configure port 5702's config with a `namedPeer` pointing at 5701.
4. Run `cmdPluginInstall(["ping@local5701"])` from 5702's process env.
5. Assert `~/.maw/plugins/ping/plugin.json` exists with matching
   sha256 + version on the 5702 side.
6. Tear down both servers.

This is the "NOT done until PR + CI green + 2-port demo succeeds"
acceptance criterion from the task.

---

## 7.3. PIN-consent gate (#644 Phase 3)

When `MAW_CONSENT=1`, `cmdPluginInstall` gates `<name>@<peer>` installs
from untrusted peers behind a PIN handshake before any artifact bytes
are fetched:

```text
$ MAW_CONSENT=1 maw plugin install ping@mawjs-parent
→ mawjs-parent (mawjs-parent) advertises: ping@1.0.0 (sha256: 9a34beefdead…)
⏸  consent required → plugin-install
   peer:   mawjs-parent (mawjs-parent)  [http://mawjs-parent.internal:2700]
   plugin: ping@1.0.0  sha256:9a34beef…
   request id: 5f2c…
   PIN (relay OOB to mawjs-parent operator): K7X3M9
   expires: 2026-04-19T17:22:00.000Z

   on mawjs-parent: maw consent approve 5f2c… K7X3M9
   then re-run: maw plugin install ping@mawjs-parent
```

Flow:

1. `resolvePeerInstall` returns the advertised version + sha256 + peer URL.
2. `maybeGatePluginInstall` checks `trust.json` for
   `myNode → peerNode : plugin-install`. If present → allow.
3. Otherwise, POST `/api/consent/request` to the peer, mirror the pending
   entry locally, surface the PIN via stderr, exit 2.
4. Operator on the peer runs `maw consent approve <id> <pin>`. That
   writes a trust entry (the PIN is the OOB authentication of the
   initiator's identity — an attacker who impersonates `from` can't
   produce the PIN printed on the real initiator's terminal).
5. Re-running `maw plugin install ping@mawjs-parent` now bypasses the
   gate and proceeds to `installFromUrl`.

Gate scope is intentionally narrow:

- Only gates `kind: "peer"` (`<name>@<peer>`). Local paths, tarballs, and
  raw URLs are unaffected — those are either the operator's own bytes or
  already covered by `plugins.lock`.
- Default OFF — users opt in via `MAW_CONSENT=1`, matching the Phase 1
  (`maw hey`) and Phase 2 (`maw team invite`) convention.
- Trust key is scoped to `plugin-install` — a trust entry for `hey` does
  NOT authorize plugin installs (see `ConsentAction` in
  `src/core/consent/store.ts`).
- When the peer doesn't advertise its node name (legacy), the gate falls
  back to the `namedPeer` nickname for the trust key so the entry is
  still usable.

Trust entries live in `~/.maw/trust.json`; revoke via the existing
`maw consent revoke` command (or delete the key manually).

---

## 8. File ownership

- `src/commands/plugins/plugin/install-impl.ts` — new `@peer` dispatch branch
- `src/commands/plugins/plugin/install-source-detect.ts` — extend `Mode` + `detectMode`
- `src/commands/plugins/plugin/install-peer-resolver.ts` — NEW, resolver + sha256 cross-check
- `src/commands/plugins/plugin/install-peer-resolver.test.ts` — NEW, unit tests
- `src/api/plugin-list-manifest.ts` — add `downloadUrl` to entries
- `src/api/plugin-download.ts` — NEW, `/plugin/download/:name` endpoint
- `src/api/index.ts` — mount the new endpoint
- `test/integration/plugin-install-at-peer.test.ts` — NEW, 2-port demo
- `src/core/consent/gate-plugin-install.ts` — NEW (#644 Phase 3), gate helper
- `test/core/consent/gate-plugin-install.test.ts` — NEW (#644 Phase 3), unit tests
- `test/integration/plugin-install-consent.test.ts` — NEW (#644 Phase 3), 2-port consent demo
- `docs/plugins/at-peer-install.md` — this doc

No changes to `plugins.lock` semantics, `installFromTarball`, or
`searchPeers` internals. The wire path is purely additive.
