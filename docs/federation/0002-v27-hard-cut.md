# ADR 0002 / RFC: Federation v27 Hard Cut — Implementation Plan

**Status**: Drafted 2026-04-30. **Do not merge before v27.0.0 release.** This is a design-only document. The corresponding code PR must NOT land on `alpha` before the v27.0.0 cut date — the alpha cycle (`v26.5.x`) is the operator migration window per ADR 0001 §"Migration to v27 — hard cut".
**Tracks**: [#843](https://github.com/Soul-Brews-Studio/maw-js/issues/843)
**Parent**: [#804](https://github.com/Soul-Brews-Studio/maw-js/issues/804) Step 6 (deadline-shaped)
**ADR-of-record**: [`0001-peer-identity.md`](./0001-peer-identity.md)
**Author**: design agent on team `cleanup-misc-907-843`

---

## Context

ADR 0001 committed to a hard cut at `v27.0.0`:

> No `legacy: true` flag. The alpha cycle (v26.5.x) is the migration window. Peers running pre-RFC code at v27.0.0 release are refused with a clear error pointing to this ADR.
>
> This mirrors #785's deprecation→hard-error pattern. A flag we don't delete is a flag we maintain forever.

By the time this design lands as code, Steps 1–5 of the RFC have shipped on `alpha` between `v26.4.29-alpha.3` and `v26.4.29-alpha.8` (#806/#808/#810/#809+#811/#813). Step 6 is the only remaining piece, and it's deadline-shaped — not technically blocked, just temporally gated on the v27.0.0 release boundary.

**What "hard cut" means here, concretely:** at v27.0.0 the federation auth handler refuses **all** unsigned cross-node messages, on **both** removable paths:

1. **Legacy v1 (body-unsigned) fleet-HMAC** — a captured v1 signature lets an attacker swap the body within the 5-min window. v2 closed this; v3 hardened further. v27 deletes v1 entirely.
2. **O6 row 1 — "no cache + unsigned → accept (legacy bootstrap)"** — the alpha-window TOFU concession that lets a peer with no cached pubkey establish trust without signing. v27 requires signed first contact for TOFU.

Loopback (CLI on same host) and unconfigured-token (single-node, peers-empty) remain pass-through — those code paths are unchanged because they're not federation, they're local-or-disabled. The hard cut is scoped to **cross-node, peers-configured** posture.

---

## Affected code (file:line)

All line numbers are **anchors at HEAD of `alpha` as of 2026-04-30**. The implementer at v27 cut time should re-locate them — function names and behavioral comments are the durable references.

### 1. `src/lib/federation-auth.ts:73` — `sign()` body-unsigned path

**Current (lines 75–80):**

```ts
export function sign(token: string, method: string, path: string, timestamp: number, bodyHash = ""): string {
  const payload = bodyHash
    ? `${method}:${path}:${timestamp}:${bodyHash}`
    : `${method}:${path}:${timestamp}`;
  return createHmac("sha256", token).update(payload).digest("hex");
}
```

**Intended change:** make `bodyHash` required (no default). The v1 (omitted-body-hash) call shape disappears at the type level — every caller must supply a hash, even if the body is empty (`hashBody("")` returns `""`, and the canonical payload becomes `METHOD:PATH:TIMESTAMP:` with the trailing colon, which is fine — the verifier expects exactly that). The `sign()` signature was already transitional; v27 just removes the default.

```ts
// Post-v27 shape:
export function sign(token: string, method: string, path: string, timestamp: number, bodyHash: string): string {
  const payload = `${method}:${path}:${timestamp}:${bodyHash}`;
  return createHmac("sha256", token).update(payload).digest("hex");
}
```

Same surgery at `verify()` (lines 89–102): drop the `bodyHash = ""` default; require the caller to commit to v2-shape on the verify side too. The version-mismatch tests (see "Tests to remove or modify") already cover the cross-product, so making the parameter required is a one-line type change with downstream propagation.

`signHeaders()` at lines 124–138: remove the `if (bh) headers["X-Maw-Auth-Version"] = "v2";` branch — every outbound request is v2-shape (or v3 on top), so `X-Maw-Auth-Version: v2` is set unconditionally. Better still: drop the version header entirely on outbound (the receiver no longer cares — there is no v1 to fall back to), and have the verifier reject any request that *omits* `X-Maw-Auth-Version: v2` (or v3) as a v1-residue refusal.

### 2. `src/lib/federation-auth.ts:290–331` — middleware v1 acceptance path

**Current (lines 290–332):**

```ts
const sig = c.req.header("x-maw-signature");
const ts = c.req.header("x-maw-timestamp");
const authVersion = (c.req.header("x-maw-auth-version") ?? "v1").toLowerCase();

if (!sig || !ts) {
  return c.json({ error: "federation auth required", reason: "missing_signature" }, 401);
}
// ... timestamp parse ...

let bodyHash = "";
if (authVersion === "v2") {
  // ... read body, compute hash ...
}

if (!verify(token, c.req.method, path, timestamp, sig, bodyHash)) {
  // ... 401 ...
}

// v1 is a deprecation path — warn so operators see the attack surface.
if (authVersion === "v1") {
  console.warn(`[auth] v1 (body-unsigned) accepted for ${c.req.method} ${path} from ${clientIp} — peer should upgrade to v2; body-swap replay is possible until they do`);
}
```

**Intended change:** replace the `(c.req.header("x-maw-auth-version") ?? "v1")` default with an explicit refusal. Any incoming request that does not declare `X-Maw-Auth-Version: v2` (or `v3`) is a pre-v27 peer and must be refused with the v27-cut error (see "Refusal error shape" below). The body-hash branch becomes unconditional. The trailing `if (authVersion === "v1") console.warn(...)` block is **deleted** — it cannot fire because v1 is now refused upstream.

Sketch of the post-v27 shape:

```ts
const sig = c.req.header("x-maw-signature");
const ts = c.req.header("x-maw-timestamp");
const authVersion = (c.req.header("x-maw-auth-version") ?? "").toLowerCase();

if (!sig || !ts) {
  return c.json({ error: "federation auth required", reason: "missing_signature" }, 401);
}
if (authVersion !== "v2" && authVersion !== "v3") {
  return c.json(V27_CUT_ERROR_BODY, 401);  // see Refusal error shape
}
// ... timestamp parse ...

// Body hash is now mandatory (load-bearing for both v2 and v3).
let bodyHash: string;
try {
  const clone = c.req.raw.clone();
  const buf = new Uint8Array(await clone.arrayBuffer());
  bodyHash = hashBody(buf);
} catch (err) {
  // ... existing body_read_failed branch ...
}

if (!verify(token, c.req.method, path, timestamp, sig, bodyHash)) {
  // ... existing reason routing ...
}
// (v1 acceptance log — DELETED.)
```

### 3. `src/lib/federation-auth.ts:487–497` — O6 row 1 (`verifyRequest`)

**Current (lines 487–490):**

```ts
// --- O6 row 1: no cache + unsigned → accept (legacy bootstrap) ---
if (!cached && !signed) {
  return { kind: "accept-legacy", reason: "no-cache-no-sig" };
}
```

**Intended change:** flip from accept to refuse. The TOFU bootstrap concession that let unknown peers establish trust without signing closes at v27. Only signed first contact populates the TOFU cache after this cut.

```ts
// --- O6 row 1 (post-v27): no cache + unsigned → REFUSE (v27 hard-cut) ---
if (!cached && !signed) {
  return {
    kind: "refuse-unsigned",
    reason: "v27-cut-unsigned-bootstrap",
    // No `from` — the sender didn't tell us who they are.
  };
}
```

The `accept-legacy` variant of `FromVerifyDecision` (line 379) becomes dead — leave the type alone for one alpha cycle (so older test fixtures still typecheck) and remove on the cut PR's follow-up. Caller sites that branch on `kind === "accept-legacy"` are limited; `src/lib/elysia-auth.ts:160` only special-cases `accept-tofu-record`, so the deletion is shallow.

Row 2 (`!cached && signed → accept-tofu-record`) **stays** — that's the only path that can populate the TOFU cache going forward. Keeps first-contact bootstrap working *for signed peers*.

### 4. `src/lib/peers/tofu.ts` — TOFU first-contact policy

The TOFU module today (lines 81–103) accepts two no-pubkey shapes:

- `tofu-bootstrap` — peer advertised a pubkey, we cache it
- `legacy-first-contact` — peer omitted pubkey entirely (pre-Step-1 peer)

**Intended change:** delete the `legacy-first-contact` decision. After v27, a peer that returns an `/info` response without a `pubkey` field is refused at the application layer (`maw peers add`, `maw doctor`, the install resolver, etc.) with the same v27-cut error shape as the wire path. Concretely:

- Remove the `kind: "legacy-first-contact"` branch in `evaluatePeerIdentity` (lines 88–103). The `if (!cached) { if (observed) { ... return tofu-bootstrap } else { ... return legacy-first-contact } }` collapses to: if `observed` is missing, return a new `kind: "refuse-no-pubkey"` decision.
- Same for `legacy-after-pinned` (lines 105–115) — it documents itself as "v27 will hard-fail this", and v27 is now. Convert to a refusal alongside `mismatch`.
- `applyTofuDecision` (line 146) gains a `case "refuse-no-pubkey":` that throws a new error type analogous to `PeerPubkeyMismatchError` but with the v27-cut message and a pointer to ADR 0001.

The TOFU bootstrap path (`tofu-bootstrap`, line 92) — peer advertises a pubkey on first contact — **stays unchanged**. That is the only legitimate way to populate the cache going forward.

### 5. `CONTRIBUTING.md` — operator-facing migration note

Add a new section near the top (between **Quick start** and **Before opening a PR**, or as a sibling of **Branch model**), worded to operators who are upgrading their fleet across the v27.0.0 boundary. Suggested text:

```markdown
## Federation v27 hard cut (operator migration)

Starting at **v27.0.0**, every cross-node federation message must be signed.
Unsigned legacy v1 (body-unsigned fleet-HMAC) and the alpha-window "first
contact unsigned" TOFU bootstrap are both refused at the wire with HTTP 401.

If you're upgrading a multi-node fleet:

1. **Upgrade every peer to v26.5.x or later first.** v26.5.x signs by default
   and is forward-compatible with v27 verifiers.
2. **Let each peer make a signed handshake** (any cross-node call works —
   `maw health`, `maw peek`, etc.). This populates the TOFU cache on the
   receiving side.
3. **Then upgrade to v27.0.0.** Signed peers continue to work with no
   operator action.

If you skip step 1 or 2, v27 nodes will refuse the unsigned peer with:

> `federation auth refused: v27 hard-cut active — peer must sign every request.`
> `Upgrade peer to v26.5.x+ and let it sign once, then retry.`
> `See docs/federation/0001-peer-identity.md §"Migration to v27 — hard cut".`

The hard cut mirrors the bare-name removal in #785 — the alpha cycle was the
deprecation window; v27 removes the path entirely. There is no
`legacy: true` flag, no `--allow-unsigned` escape hatch. A flag we don't
delete is a flag we maintain forever.

Pubkey-loss recovery (operator factory-resets a node) remains supported via
`maw peers forget <peer>` to re-TOFU on the next *signed* contact.
```

The release notes for v27.0.0 must link this section.

### 6. `docs/federation/0001-peer-identity.md` — flip status note

The `## Migration to v27 — hard cut` section (lines 102–106) is currently written in future tense:

> Peers running pre-RFC code at v27.0.0 release are refused with a clear error pointing to this ADR.

**Intended change:** flip to past/active tense at v27 cut and append a back-reference to this ADR:

```markdown
### Migration to v27 — hard cut

**Status (post-v27.0.0): active.** Implemented in ADR 0002 / #843. The alpha
cycle (v26.5.x) was the migration window. Peers running pre-RFC code are
refused at the wire with the v27-cut error.

The cut is mirrored at every entry point: the Hono middleware, the Elysia
`fromAuth` plugin, and the TOFU module's first-contact policy.
```

Also update the **Target** field at the head of ADR 0001 (line 6) from `v26.5.x alpha cycle, hard-cut at v27.0.0` to `v26.5.x alpha cycle, hard-cut active since v27.0.0` once the cut PR merges.

---

## Refusal error shape

**HTTP status: 401.** Same status as every other auth refusal in `federation-auth.ts` — keeps the operator's mental model unchanged ("401 from federation = my auth is wrong"), avoids needing client-side branching on a new code, and is consistent with what `verifyRequest`'s caller (`src/lib/elysia-auth.ts:147`) already returns for refusals. We considered 403 (semantically: "you're authenticated but not allowed") but the v27 cut is fundamentally an authentication failure (the request is unsigned), not an authorization one.

**Body shape:**

```json
{
  "error": "federation auth refused: v27 hard-cut active",
  "reason": "v27_cut_unsigned",
  "kind": "refuse-unsigned",
  "operator_action": "upgrade peer to v26.5.x+ and let it sign once, then retry",
  "adr": "docs/federation/0001-peer-identity.md#migration-to-v27--hard-cut"
}
```

Define a single `V27_CUT_ERROR_BODY` constant in `federation-auth.ts` and reuse it from all three refusal sites (middleware v1 path, `verifyRequest` O6 row 1, `tofu.ts` no-pubkey path) so the wire shape is identical regardless of which surface refuses.

The existing `console.warn` lines (e.g. line 325) gain a v27-cut variant that prints the peer IP + path + reason at refusal time, so operators have a breadcrumb when their fleet partially-upgrades and breaks.

---

## Tests to add

`test/federation-auth.test.ts` and `test/isolated/from-signing-verify.test.ts` are the right homes — the existing structure already has named cases per O6 row.

- **`legacy v1 fleet-HMAC unsigned → refused (was accepted)`**
  Build a v1-shape request (no `X-Maw-Auth-Version` header, body-unsigned signature). Assert HTTP 401 with `reason: "v27_cut_unsigned"`. Currently, this would be accepted with the warning at line 331.

- **`first-contact unsigned → refused (was accepted)`**
  Empty TOFU cache (`lookupPubkey: () => undefined`), no `x-maw-from` / `x-maw-signature` / `x-maw-signed-at` headers. Assert `decision.kind === "refuse-unsigned"` and `reason: "v27-cut-unsigned-bootstrap"`. Today this returns `accept-legacy`.

- **`first-contact signed → still accepted (TOFU intact for signed bootstraps)`**
  Empty cache, full from-signing trio with a valid HMAC. Assert `decision.kind === "accept-tofu-record"`. This **must stay green** through the cut — it's the load-bearing case proving we didn't break legitimate first-contact.

- **`tofu.ts: peer with no `pubkey` field → refused`** (new test in `test/peers-tofu.test.ts` or wherever existing TOFU tests live — there are tests asserting `legacy-first-contact` today; mirror them with the post-v27 refusal shape).

- **Regression sweep — every signed-path test in `test/isolated/from-signing-verify.test.ts` (rows 2/4) and `test/isolated/from-signing-outgoing.test.ts` (v3 outbound) stays green.**

---

## Tests to remove or modify

These assert v1/legacy acceptance — they must be deleted or rewritten to assert refusal.

- **`test/federation-auth.test.ts:113`** — `"empty/undefined/null body → empty string (v1 marker)"`. The v1 marker concept goes away. Either delete or repurpose to assert that empty-body v2 still hashes to `""` (the underlying primitive is unchanged; only the v1/v2 distinction at the protocol level disappears).

- **`test/federation-auth.test.ts:157`** — `"v1 sig + any body-hash on verify → false (version mismatch)"`. Delete — there is no v1 sig to mismatch against.

- **`test/federation-auth.test.ts:165`** — `"v2 sig verified as v1 (no body hash) → false (version mismatch)"`. Delete — same reasoning.

- **`test/federation-auth.test.ts:171`** — `"v1 sig + no bodyHash on verify → true (backward compat path)"`. **Critical to delete** — this asserts the exact behavior we're cutting.

- **`test/federation-auth.test.ts:188`** — `"no body → v1 headers (no version header)"`. Update to assert v2 headers (with `X-Maw-Auth-Version: v2`) regardless of body presence.

- **`test/federation-auth.test.ts:201`** — `"empty body string → v1 (no version header; matches 'no body')"`. Same: rewrite to assert v2.

- **`test/isolated/from-signing-verify.test.ts:67`** — `"O6 row 1: no cache + unsigned → accept (legacy TOFU bootstrap)"`. Rewrite the assertion: was `expect(decision.kind).toBe("accept-legacy")`, becomes `expect(decision.kind).toBe("refuse-unsigned")` and `expect(isRefuseDecision(decision)).toBe(true)`.

- **`test/isolated/from-signing-outgoing.test.ts:294`** — `"no `from` option → only legacy v1/v2 headers, no v3 (back-compat)"`. The `from`-less outbound shape is still legitimate (single-node operators stay on token), but the test description / assertion may need to flip — the receiver no longer accepts v1, so an outbound-only test of the *header shape* is fine, but any receiver-side counterpart that asserts "the peer accepts this" must be updated.

- **`test/isolated/federation-auth.test.ts:354`** (`allowPeersWithoutToken: true → legacy behavior preserved`) and lines 393/398/405 (`trustLoopback` defaults) — these are about *unrelated* legacy posture (token-less + opt-in, loopback bypass). They are **not** v1-acceptance tests and should stay untouched. Listed here only to flag them as false positives if a `grep "legacy"` sweep is used to find tests-to-update.

A `grep -rn "v1\|accept-legacy\|legacy-first-contact" test/` sweep at cut time will surface any laggers added between now and v27.

---

## Migration timing checklist

Operationally, the cut PR is opened as a draft **before** v27.0.0 cut day, kept draft until cut day, then flipped ready-for-review and merged at the cut moment. The checkbox sequence:

- [ ] Stable `v26.5.x` released and operating in the wild for **≥ 4 weeks** (operator notice window — long enough for slow-moving fleets to upgrade, short enough that we're not blocked indefinitely).
- [ ] CalVer date for `v27.0.0` picked and announced (likely 2026-05-XX per #843; final date to be locked when the alpha cycle settles).
- [ ] CONTRIBUTING.md migration section (see §5 above) merged into `alpha` *before* the cut PR opens — operators read it during the deprecation window, not after.
- [ ] Release notes for `v27.0.0` include the migration section by reference (link to `CONTRIBUTING.md#federation-v27-hard-cut-operator-migration`).
- [ ] Cut PR opened against `alpha`, base = `alpha`, title prefixed `[v27-cut]`, body links this ADR.
- [ ] Cut PR's CI green; the test deltas in §"Tests to add" / §"Tests to remove or modify" are the diff signature reviewers check.
- [ ] Cut PR's landing target = day-of v27.0.0 cut (not earlier, not later).
- [ ] After merge: ADR 0001 status note flipped (see §6 above) in the same PR or a same-day follow-up.

---

## Anti-patterns (what NOT to do)

- **No `legacy: true` flag.** ADR 0001 §"Migration to v27" was explicit. A flag is a maintenance burden forever.
- **No `--allow-unsigned` escape hatch.** Same reason. Operators who can't upgrade in time stay on v26.5.x — that release line continues to work; it just doesn't get v27 features.
- **No alpha-channel landing before v27 cut day.** Landing earlier collapses the operator migration window the ADR explicitly grants. The PR sits draft until cut day.
- **No silent acceptance of unsigned-with-warning.** That is precisely what the v1 path at `federation-auth.ts:329-332` does today — and deleting it is the entire point of this work. Do not reintroduce a `console.warn(...)` + `return next()` shape under any name.
- **No v1 → v2 auto-translation.** The verifier does not "guess" what the sender meant. If the request lacks `X-Maw-Auth-Version: v2|v3`, it is refused. Period.
- **No widening of the loopback bypass to "compensate" for the cut.** The loopback bypass (`federation-auth.ts:264`) is for local CLI / Office UI on the same machine — unrelated to federation-between-nodes. It stays exactly as is.
- **No bumping `package.json` in this PR.** Version bumps are a separate gesture; the v27.0.0 stable cut goes through `/release-stable`. Per the project memory note: code-fix and release-cut are separate gestures.

---

## References

- ADR 0001 — `docs/federation/0001-peer-identity.md` (the migration commitment)
- [#843](https://github.com/Soul-Brews-Studio/maw-js/issues/843) — this design's tracking issue
- [#804](https://github.com/Soul-Brews-Studio/maw-js/issues/804) — implementation tracking (Steps 1–5 shipped; Step 6 = this work)
- [#629](https://github.com/Soul-Brews-Studio/maw-js/issues/629) — original RFC discussion
- [#785](https://github.com/Soul-Brews-Studio/maw-js/pull/785) — bare-name deprecation→hard-error pattern this mirrors
- `src/lib/federation-auth.ts` — primary surgery file (lines 73, 290–331, 487–497)
- `src/lib/peers/tofu.ts` — TOFU first-contact policy
- `src/lib/elysia-auth.ts:135–164` — companion verify call site (no surgery; downstream consumer of `verifyRequest`)
