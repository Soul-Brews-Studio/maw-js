# `js/http-to-file-access` audit — 4 open alerts (#474)

**Scan date:** 2026-04-19
**Rule:** CodeQL `js/http-to-file-access` — HTTP response content flowing to a
filesystem write sink. The threat model is: an attacker who controls either the
upstream server OR the target file path can plant arbitrary bytes at an
arbitrary path on disk.

**Outcome:** All 4 sites are classified NOT-A-VULNERABILITY with documented
rationale. No source changes required from this audit. The alerts will be
dismissed via the Code Scanning API in a follow-up task (see PR #605 for why
`// lgtm[...]` comments do not close hosted-CodeQL alerts).

---

## Site 1 — `src/commands/plugins/plugin/install-extraction.ts:88`

**Classification:** PLUGIN-INSTALL — legitimate, accepted.

**Sink:**
```ts
const tmp = mkdtempSync(join(tmpdir(), "maw-dl-"));
const filename = basename(new URL(url).pathname) || "plugin.tgz";
const outPath = join(tmp, filename);
writeFileSync(outPath, buf);          // ← line 88
```

**Source:** `buf = new Uint8Array(await res.arrayBuffer())` from
`fetch(url)` where `url` is the plugin-tarball URL. By design, the user is
asking `maw plugin install <url>` to download this exact bytes-on-wire and
save it locally — the response body IS the artifact.

**Why this is not a vulnerability:**

1. **Path is not attacker-influenced.** The directory is a fresh
   `mkdtempSync(tmpdir(), "maw-dl-")` — always under the OS tmp dir, always a
   brand-new prefix-randomized directory owned by this process. The filename
   is `basename(new URL(url).pathname)` — `basename` strips any `../` or
   absolute-path components. A URL like
   `https://evil/../../etc/passwd` yields filename `passwd` under a new temp
   dir, not `/etc/passwd`.
2. **Scheme gate** (line 48): only `http://` and `https://` URLs accepted.
3. **Size cap** before and after buffering (50 MB).
4. **Content-type gate**: must be gzip/tar/octet-stream.
5. **Tarball contents are path-traversal-checked** before extraction
   (`extractTarball`, lines 20–30 — any entry starting with `/` or containing
   `..` rejects the whole tarball).
6. **Adversarial trust lives in `plugins.lock`** (see `#487`), which pins the
   sha256 of the artifact. A tampered upstream cannot pass the hash check, so
   even though the tarball does hit disk, a mismatched artifact never
   installs.

The threat model for the rule assumes attacker-controlled path OR unvalidated
content. Here path is locked to a fresh temp dir and content is hash-verified
before install.

**Action:** Accept. No code change. Dismiss the alert via Code Scanning API
with reason "won't fix" and note "legitimate plugin-download; temp-anchored
path + sha256 pin".

---

## Site 2 — `src/commands/plugins/plugin/registry-fetch.ts:75`

**Classification:** LEGITIMATE CACHE — accepted.

**Sink:**
```ts
function writeCache(url: string, manifest: RegistryManifest): void {
  const p = cachePath();
  mkdirSync(dirname(p), { recursive: true });
  const body: CacheFile = { url, fetchedAt: new Date().toISOString(), manifest };
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");  // ← line 75
}
```

**Source:** `manifest` comes from
```ts
const res = await fetch(target);
const parsed = await res.json();
if (!isManifest(parsed)) throw ...;
writeCache(target, parsed);
```

**Why this is not a vulnerability:**

1. **Path is fixed** (`cachePath()` → `$MAW_REGISTRY_CACHE` or
   `~/.maw/registry-cache.json`). Not derived from the HTTP response at all.
2. **Content is shape-validated** by `isManifest` before it reaches the sink
   (requires `schemaVersion === 1`, `updated: string`, `plugins: object`).
   A non-manifest response throws before the write.
3. **Content is re-JSON-serialized** via `JSON.stringify`, so the bytes on
   disk are well-formed JSON — an attacker cannot inject raw bytes, only
   JSON-encodable values.
4. **Registry trust is advisory** (module header, lines 8–9): the registry
   only tells us "where to fetch `<name>`". The adversarial check is
   `plugins.lock`'s pinned sha256, not the cached manifest.

The cache file is, in effect, a *whitelisted-shape JSON document in a fixed
location*. That's exactly the category the rule is designed to ignore, but it
can't prove the shape-validation in static analysis.

**Action:** Accept. No code change. Dismiss with reason "won't fix" + note
"fixed path, shape-validated manifest, advisory cache only".

---

## Site 3 — `src/commands/plugins/talk-to/impl.ts:185`

**Classification:** LEGITIMATE LOG — accepted.

**Sink:**
```ts
const logDir = join(homedir(), ".oracle");
const logFile = join(logDir, "maw-log.jsonl");
...
const line = JSON.stringify({ ts, from, to: target, target: tmuxTarget,
                              msg: message, host, sid, ch }) + "\n";
try { await mkdir(logDir, { recursive: true }); await appendFile(logFile, line); }
catch (e) { console.error(`... talk-to log write failed: ${e}`); }
```

**Source (of the taint CodeQL sees):** `threadResult?.thread_id` from
`postToThread()` which `fetch()`s the Oracle API. That number ends up in the
`ch: thread:${thread_id}` field.

**Why this is not a vulnerability:**

1. **Path is fixed** (`~/.oracle/maw-log.jsonl`). No component derived from
   HTTP.
2. **Write mode is append**, not create-at-arbitrary-location. The sink can
   only grow a pre-known log file.
3. **Content is `JSON.stringify`'d**, so even a hostile Oracle response
   injecting shell escapes into `thread_id` would produce an escaped JSON
   string, not a raw control sequence.
4. **The Oracle API is a trusted backend** (`ORACLE_URL` env + local config).
   The user chose which Oracle to point at. A compromised upstream that
   feeds us a huge `thread_id` at worst writes a long-but-valid JSON line —
   no traversal, no code execution.
5. The only field that could carry truly attacker-*content* is `msg: message`,
   but that is the argument of `maw talk-to <target> "<message>"` — local CLI
   input, not HTTP response content.

CodeQL taint-propagation sees "fetch → save", which matches the pattern but
misses that the sink path is constant and the content is structured JSON.

**Action:** Accept. No code change. Dismiss with reason "won't fix" + note
"fixed-path JSONL log; thread_id is the only HTTP-derived field and is
JSON-encoded".

---

## Site 4 — `src/commands/shared/workspace-store.ts:88`

**Classification:** FALSE POSITIVE — no HTTP content reaches the file.

**Sink:**
```ts
export function saveWorkspace(ws: WorkspaceConfig): void {
  writeFileSync(configPath(ws.id), JSON.stringify(ws, null, 2) + "\n", "utf-8");
}
```

**Source CodeQL thinks it sees:** `curlFetch()` response feeding into `ws`
before `saveWorkspace(ws)` in `src/commands/shared/workspace-query.ts:85–109`.

**Actual dataflow:**
```ts
// workspace-query.ts — cmdWorkspaceStatus()
const workspaces = loadAllWorkspaces();          // ← local file read (!)
for each ws in workspaces:
  const res = await curlFetch(`${ws.hubUrl}/...`);  // HTTP call
  if (res.ok) {
    ws.lastStatus = "connected";                 // literal, NOT res.data
    saveWorkspace(ws);
  } else {
    ws.lastStatus = "disconnected";              // literal, NOT res.data
    saveWorkspace(ws);
  }
```

The `ws` object comes from `loadAllWorkspaces()`, which reads local config
files only. The HTTP response `res` is **branched on** (`res.ok`), but none
of its fields flow into `ws`. The only mutation before `saveWorkspace` is
`ws.lastStatus = "connected"` or `"disconnected"` — two hard-coded string
literals gated by a `ws.lastStatus: "connected" | "disconnected" | undefined`
union type.

**Path:** `configPath(ws.id)` = `WORKSPACES_DIR/<ws.id>.json`. `ws.id` is the
local workspace ID (loaded from disk). Not HTTP-derived.

**Content:** `JSON.stringify(ws)` where `ws` is a strictly-typed
`WorkspaceConfig` loaded from local disk + a literal string.

CodeQL flags this because control flow touches the `res` variable before the
write, not because data flows from it. This is a classic taint-propagation
false positive.

**Action:** Accept. No code change. Dismiss with reason "false positive" +
note "HTTP response is only branched on (res.ok); ws is loaded from local
disk; only literal 'connected'/'disconnected' is written".

---

## Summary table

| Site | File:Line | Class | Action |
|---|---|---|---|
| 1 | install-extraction.ts:88 | plugin-install legitimate | dismiss "won't fix" |
| 2 | registry-fetch.ts:75 | cache legitimate | dismiss "won't fix" |
| 3 | talk-to/impl.ts:185 | log legitimate | dismiss "won't fix" |
| 4 | workspace-store.ts:88 | false positive | dismiss "false positive" |

## Why no inline `// lgtm[...]` comments

Per `docs/security/lgtm-annotation-investigation.md` and the correction in
`docs/security/codeql-sanitizer-model.md` (2026-04-19), the hosted CodeQL
analyzer does not parse `// lgtm[query-id]`. Closing these alerts requires
either:

- Code Scanning dismissal API (per-alert, cheap, chosen here — see Task #3 of
  the go-5-r2 batch).
- A published sanitizer model pack (structural, not worth it for 4
  already-safe sites).

This audit document is the human-readable rationale the dismissals cite.

## Test strategy

No source changes in this PR — the audit is documentation only. `bun run
test:all` must stay green as a sanity check that the docs-only delta doesn't
break anything.

## Related

- `#474` — CodeQL first-scan cleanup bucket.
- `#487` — `plugins.lock` registry-pinned hashes (adversarial check behind
  Site 1).
- PR #605 — lgtm vs. Code Scanning API decision.
- `docs/security/lgtm-annotation-investigation.md`.
- `docs/security/codeql-sanitizer-model.md`.
