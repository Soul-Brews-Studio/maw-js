# Phase B Decomposition — plugin-compiler

> **Umbrella**: #340  
> **Blocked on**: #339 (`@maw/sdk` npm publish — decision point)  
> **Phase A shipped**: alpha.22, commit `508cbe1`  
> **Design source**: `ψ/writing/2026-04-15/the-plugin-compiler-debate.md`

---

## 1. Overview

Phase A shipped three verbs (`maw plugin init --ts`, `maw plugin build`, `maw plugin install`) with the SDK **bundled into each plugin**. This was the right MVP call: it avoided the injection-infrastructure problem and kept Phase A to one session. But bundling the SDK is a deliberate *deferral*, not a final state.

Phase B is the transition from "declared capabilities" to "enforced capabilities." The key mechanism is the **host-injected shim**: instead of `@maw/sdk` being frozen inside each plugin's bundle, the host injects a runtime Proxy that can intercept every SDK call. With that Proxy in place, capability enforcement can be per-call, per-plugin, and triggered at trust-boundary crossing — without breaking any Phase A plugin that doesn't cross that boundary.

Phase B is also the phase where author ergonomics mature: `maw plugin dev` earns its own verb, `maw plugin check` gives authors a pre-publish dry-run, and `maw plugin upgrade` handles the SDK bump workflow.

The trust layer (`.tgz` signing, federation-distributed revocation) ships in Phase B as additive, non-breaking additions to the `artifact` object shape — laying the groundwork for Phase C's full revocation infrastructure.

**Why Phase B is blocked on #339**: The host-shim flip requires `@maw/sdk` to be a real published package. A plugin on a fresh machine that runs `bun add @maw/sdk` must get types and runtime shim stubs from npm — not from the maw-js workspace. Until the npm publish story is decided (#339), the shim injection architecture is unresolvable.

---

## 2. Sub-issue Decomposition

### B1 — `@maw/sdk` host-injected shim

**Title**: `feat(plugin-compiler): Phase B — @maw/sdk host-injected shim`

**Scope**: Replace the current pattern where `@maw/sdk` is bundled verbatim into each plugin's `dist/index.js`. After this sub-issue, `@maw/sdk` is marked `--external` in the Bun build and the host injects a runtime Proxy at plugin load time (`registry.ts`). The Proxy forwards each SDK method call to the actual host implementation, and in Phase B, will enforce capability declarations before forwarding. The shim must be injected before any plugin code runs — likely via a `globalThis.__mawSdk` sentinel that the external-ized `@maw/sdk` package reads on import.

**Dependencies**: #339 (npm publish), #340-B2 (capability hard-fail consumes the shim)

**LOC estimate**: M (200–400 LOC across `registry.ts`, `packages/sdk/`, `build-impl.ts`)

**Risk**: L (external-contract change — existing Phase A plugins will need a rebuild to use the shim; bundled SDK still works if authors don't rebuild, but gets no capability enforcement)

**Acceptance criteria**:
- `maw plugin build` marks `@maw/sdk` as external; output `dist/index.js` contains no inlined SDK code
- At plugin load, host injects a Proxy that wraps every SDK method
- An existing Phase A plugin (bundled SDK) loads and runs identically (no regression)
- A rebuilt Phase B plugin uses the shim and produces a smaller bundle

---

### B2 — Capability hard-fail at trust boundary

**Title**: `feat(plugin-compiler): Phase B — capability enforcement at trust boundary`

**Scope**: Flip the capability enforcement from advisory (Phase A: warning in build log) to hard-fail for plugins that cross the trust boundary. Trust-boundary crossing = first tarball installed from a non-first-party URL (i.e., any `maw plugin install https://…` from outside `src/commands/plugins/`). First-party plugins (those under `src/commands/plugins/`) remain advisory until Phase C. The enforcement mechanism: the host-shim Proxy (B1) checks the plugin's declared `capabilities` before forwarding each SDK call. Undeclared calls throw a `CapabilityViolation` error with the plugin name, the method attempted, and the declared capabilities list.

**Dependencies**: B1 (shim must exist before enforcement can run)

**LOC estimate**: S (80–150 LOC; the Proxy interception logic is the bulk)

**Risk**: M (per-plugin scoped, but first-party-detection must be airtight — a misclassification would break a first-party plugin silently or over-enforce on a third-party one)

**Acceptance criteria**:
- A plugin with `"capabilities": []` that calls `maw.send()` throws `CapabilityViolation` when installed from an HTTPS URL
- The same plugin installed from `./local-dir` produces a warning, not an error
- A first-party plugin (path within `src/commands/plugins/`) continues advisory-only
- Error message includes: plugin name, method called, declared capabilities, fix instruction (`add peer:send to capabilities in plugin.json, rebuild`)

---

### B3 — `maw plugin rebuild --all` (bundle-graph walker)

**Title**: `feat(plugin-compiler): Phase B — rebuild --all with bundle-graph capability inference`

**Scope**: Add `maw plugin rebuild --all` which re-runs capability inference for every installed plugin and patches `plugin.json` manifests in place. **Critical**: inference must walk Bun's bundled output graph, not source imports. Phase A's regex-over-source misses transitive dependencies — an npm dep that reaches `node:fs` internally won't appear in the plugin's source `import` statements. Walking the bundle output graph catches these. This is the migration path for Phase A authors before enforcement flips: run `maw plugin rebuild --all`, review the updated capabilities, then re-install.

**Dependencies**: B1 (bundle graph is only meaningful when built with external SDK), B2 (rebuild is how authors prepare for enforcement)

**LOC estimate**: M (200–350 LOC; bundle graph traversal is the novel part)

**Risk**: M (false-positive risk — bundle graph may attribute framework internals as plugin capabilities; needs an allowlist for known-safe transitive deps)

**Acceptance criteria**:
- `maw plugin rebuild --all` re-builds every installed plugin and updates its manifest's `capabilities` field
- An npm dep that internally uses `node:fs` causes `fs:read` to appear in the rebuilt manifest
- Diff output shows what changed per plugin (`hello-ping: +fs:read, -peer:send`)
- Idempotent: running twice produces the same result

---

### B4 — AST-based capability verification (TypeScript Compiler API)

**Title**: `feat(plugin-compiler): Phase B — AST-based capability verification`

**Scope**: Replace the Phase A regex-over-bundled-output inference with proper AST-based analysis using the TypeScript Compiler API. The regex approach has known false negatives: `const { identity } = maw; identity()` and `maw["identity"]()` escape detection. The TS Compiler API allows following symbol references through destructuring and computed property access. This sub-issue ships the new analyzer as the default inference backend for `maw plugin build`; the regex path becomes a fallback (for non-TS plugins or when the TS compiler is unavailable).

**Dependencies**: B3 (rebuild --all should use the new analyzer)

**LOC estimate**: L (400–700 LOC; TS Compiler API has a steep surface)

**Risk**: L (TS Compiler API adds a significant new dependency and build-time overhead; may be too slow for watch mode — watch mode may keep the regex path)

**Acceptance criteria**:
- `const { identity } = maw; identity()` correctly infers `sdk:identity`
- `maw["send"]()` correctly infers `peer:send`
- False negative rate vs. Phase A regex: measured on existing 50+ plugins, improvements documented
- Watch mode (`--watch`) remains under 500ms rebuild on a mid-sized plugin

---

### B5 — `maw plugin check <dir>` (pre-publish dry-run)

**Title**: `feat(plugin-compiler): Phase B — maw plugin check <dir>`

**Scope**: New verb `maw plugin check <dir>` runs all pre-publish validators without installing anything. Checks: (1) bundle compiles cleanly, (2) declared capabilities match inferred capabilities (diff printed), (3) tarball layout is correct (plugin.json at root, dist/index.js present), (4) semver gate passes against current runtime SDK version, (5) sha256 field is populated (not null). Outputs a pass/fail report with actionable fix instructions for each failure. This is the verb Phase A deferred — builder-advocate's position was "the build validates"; sdk-consumer wanted a dry-run. Phase B ships it as a separate verb for authors who want to validate without building.

**Dependencies**: B4 (check uses the AST analyzer for capability diff)

**LOC estimate**: S (100–180 LOC; mostly orchestrating existing validators)

**Risk**: S (additive verb, no existing behavior changes)

**Acceptance criteria**:
- `maw plugin check ./my-plugin` exits 0 when all checks pass, non-zero on any failure
- Prints per-check status (`✓ bundle`, `✗ capabilities: declared [identity] ≠ inferred [identity, peer:send]`)
- Running `maw plugin check` on a freshly scaffolded (unbuilt) plugin prints `✗ sha256: null — run maw plugin build first`
- Does not modify any files

---

### B6 — `maw plugin dev` verb promotion

**Title**: `feat(plugin-compiler): Phase B — maw plugin dev verb`

**Scope**: Promote `maw plugin build --watch` to a first-class `maw plugin dev` verb. `maw plugin dev [dir]` is a convenience wrapper: builds in watch mode + installs with `--link` (symlink, skips hash verification). The `--watch` flag on `build` remains for users who want watch without the auto-link. The round-trip time goal: under 200ms rebuild notification after a source file save (Bun's fast bundler baseline). sdk-consumer earned this — they deferred it in Phase A; Phase B is where it ships.

**Dependencies**: B1 (symlink installs against the shim should work correctly)

**LOC estimate**: S (50–80 LOC; mostly wiring)

**Risk**: S (no contract change; purely additive verb)

**Acceptance criteria**:
- `maw plugin dev` in a plugin directory starts watch mode + links the plugin
- File save triggers rebuild and re-link within 200ms (measured on hello-ping)
- `Ctrl-C` exits cleanly; link persists (author's choice to unlink)
- Help text distinguishes `dev` (linked watch) from `build --watch` (watch only)

---

### B7 — `maw plugin upgrade`

**Title**: `feat(plugin-compiler): Phase B — maw plugin upgrade`

**Scope**: New verb `maw plugin upgrade [name]` handles the `@maw/sdk` peer dep bump workflow. Without an argument, upgrades all installed plugins. Workflow: (1) update `package.json` `@maw/sdk` version to latest compatible, (2) re-run `maw plugin build` with the new SDK version, (3) run `maw plugin check` against the result, (4) show diff of capability changes and manifest changes, (5) re-install. Fails loudly if any capability check fails post-upgrade. This closes the workflow gap where Phase A authors see an SDK mismatch error but have no single command to resolve it.

**Dependencies**: B5 (upgrade calls check as its validation step)

**LOC estimate**: M (150–250 LOC; orchestration + diff output)

**Risk**: M (SDK version resolution logic; must handle partial failure — some plugins upgrade, some don't)

**Acceptance criteria**:
- `maw plugin upgrade` on a plugin with an outdated SDK version bumps, rebuilds, and reinstalls
- Capability diff is shown before re-install; user can abort (`--dry-run` flag)
- If rebuild fails post-upgrade, original version is restored (rollback)
- `maw plugin upgrade hello-ping` upgrades only `hello-ping`

---

### B8 — `.d.ts` generation for plugin-specific types

**Title**: `feat(plugin-compiler): Phase B — .d.ts generation`

**Scope**: `maw plugin build` generates a `dist/types.d.ts` alongside `dist/index.js`. The generated types expose the plugin's public invocation surface: the `InvokeContext` shape (command/subcommand matched, args, flags) specific to the plugin's declared `cli` block, and any `api` types derived from the plugin's API schema. Uses TypeBox-to-TS type extraction (Phase A already has TypeBox schemas). This enables plugin authors to write typed tests and enables future `maw plugin call` type safety.

**Dependencies**: B1 (type generation needs the final manifest shape after shim flip)

**LOC estimate**: M (150–280 LOC; TypeBox → .d.ts extraction is the novel part)

**Risk**: S (additive output file; no existing contract changes)

**Acceptance criteria**:
- `maw plugin build` in a plugin with a CLI block produces `dist/types.d.ts` with typed `InvokeContext`
- The generated types pass `tsc --noEmit` in the plugin directory
- A plugin with no `cli` block gets a minimal `types.d.ts` with just the base `InvokeContext`
- Generated file includes a `// generated by maw plugin build` header (not hand-edited)

---

### B9 — `.tgz` signing (ed25519)

**Title**: `feat(plugin-compiler): Phase B — .tgz signing (ed25519)`

**Scope**: Add optional signing support to `maw plugin build`. When a signing key is configured (`~/.maw/plugin-signing-key.pem` or `MAW_PLUGIN_SIGNING_KEY` env), the build step signs the `.tgz` artifact with ed25519 and writes `signature` and `signedBy` fields into `artifact` in the manifest. These fields are **additive** to the `artifact` object shape established in Phase A — no breaking change. `maw plugin install` verifies the signature when present; if absent, installs without verification (Phase B behavior; Phase C will require signatures for third-party installs).

**Dependencies**: None (additive field; B1 not required)

**LOC estimate**: S (80–120 LOC; ed25519 via Node crypto is well-trodden)

**Risk**: S (additive only; no existing behavior changes; key management is out of scope for this sub-issue)

**Acceptance criteria**:
- When a signing key is configured, `maw plugin build` outputs `artifact.signature` and `artifact.signedBy` in plugin.json
- `maw plugin install` verifies the signature when present; mismatch = hard error with key fingerprint shown
- When no key configured, build output is identical to Phase A (no signature fields)
- Signature covers the `.tgz` byte content, not a pre-hash of the bundle

---

### B10 — Trust root federation

**Title**: `feat(plugin-compiler): Phase B — trust root federation`

**Scope**: Distribute trust roots (public keys for signing verification) via the maw federation. An oracle node can publish its plugin signing public key to federation peers. When a plugin is installed from a URL hosted on a known federation node, the host can automatically verify the signature against the federated trust root for that node — without the author or installer having to manually exchange keys. This is a preview of Phase C's revocation infrastructure. Scope: read-only distribution of public keys via federation gossip; no revocation lists in Phase B.

**Dependencies**: B9 (signing must exist before trust distribution makes sense)

**LOC estimate**: L (300–500 LOC; federation gossip integration is non-trivial)

**Risk**: L (touches federation layer; wrong implementation could poison trust roots across nodes)

**Acceptance criteria**:
- A node can publish its plugin signing public key to federation peers via `maw plugin trust publish`
- Peers receive and store the trust root; `maw plugin trust list` shows known roots
- Installing a signed plugin from a federation peer URL auto-verifies against the stored root
- Poisoning path: a rogue trust root update is rejected if it doesn't chain to a known root

---

## 3. Dependency Graph

```
#339 (npm publish)
    │
    ▼
   B1 (host-injected shim)
    │
    ├──► B2 (capability hard-fail)
    │         │
    │         └──► B3 (rebuild --all + bundle graph)
    │                   │
    │                   └──► B4 (AST-based verification)
    │                             │
    │                             └──► B5 (plugin check)
    │                                       │
    │                                       └──► B7 (plugin upgrade)
    │
    ├──► B6 (dev verb) ── (light dep on B1 for shim-aware linking)
    │
    └──► B8 (.d.ts generation) ── (needs final manifest shape)

B9 (.tgz signing) ── (independent; additive field)
    │
    └──► B10 (trust root federation)
```

**Critical path**: #339 → B1 → B2 → B3 → B4 → B5 → B7

**Parallelizable after B1**: B6, B8 can proceed independently of B2–B5.

**Independent stream**: B9 → B10 can start any time; no dependency on B1.

---

## 4. Risk Summary

### External-contract changes (breaking or potentially breaking)

| Sub-issue | What changes | Breaking? | Mitigation |
|---|---|---|---|
| B1 | Plugin bundle format (SDK no longer inlined) | Soft-break (Phase A plugins need rebuild to use shim, but still work bundled) | `maw plugin rebuild --all` migration path |
| B2 | Capability enforcement flips from warning to error for third-party plugins | Yes, for third-party plugins with wrong capabilities | B3 (rebuild) is the pre-enforcement migration; docs warn before flip |
| B3 | Capability inference results may change (bundle graph vs regex) | Manifests change, not loader behavior | Diff output + author review step |

### Internal-only changes (no external contract)

| Sub-issue | What changes | Notes |
|---|---|---|
| B4 | Cap inference engine (TS Compiler API vs regex) | Fallback to regex; output contract unchanged |
| B5 | New verb, no existing behavior | Additive |
| B6 | New verb, no existing behavior | Additive |
| B7 | New verb, orchestrates existing commands | Additive |
| B8 | New build output file | Additive |
| B9 | New manifest fields (additive to `artifact`) | Fields absent = Phase A behavior |
| B10 | Federation gossip for trust roots | New gossip type; existing gossip unaffected |

### Invariant check (from #340 body)

1. **No DX cliff**: Phase A plugins that don't cross the trust boundary continue to work without any author action. ✅ (B2 is scoped to trust-boundary crossing)
2. **Manifest shape stays frozen**: B9 adds `signature`/`signedBy` additively; B8 adds no manifest fields. ✅
3. **Advisory → hard-fail is per-plugin**: B2 is explicitly per-plugin scoped, first-party stays advisory. ✅

---

## 5. Proposed Order and Rough Estimates

| Order | Sub-issue | Effort | Notes |
|---|---|---|---|
| 1 | #339 (unblock) | 1 session (Nat decides) | Blocks everything else |
| 2 | B1 (host shim) | 1 session | Critical path entry |
| 3 | B9 (signing) | 0.5 session | Can parallel with B1 |
| 4 | B2 (hard-fail) | 0.5 session | After B1 |
| 5 | B3 (rebuild --all) | 1 session | After B1+B2 |
| 6 | B6 (dev verb) | 0.25 session | After B1; small |
| 7 | B8 (.d.ts gen) | 0.5 session | After B1; independent |
| 8 | B4 (AST verify) | 1.5 sessions | After B3; steep ramp |
| 9 | B5 (check verb) | 0.5 session | After B4 |
| 10 | B7 (upgrade) | 0.5 session | After B5 |
| 11 | B10 (trust federation) | 1.5 sessions | After B9; complex |

**Total Phase B estimate**: ~8 sessions across 3–4 alpha releases.

**Recommended split**:
- alpha.23: B1 + B9 + B6 (shim + signing + dev verb — high-value, lower risk)
- alpha.24: B2 + B3 (enforcement + rebuild — the security story)
- alpha.25: B4 + B8 (AST + types — quality/ergonomics)
- alpha.26: B5 + B7 + B10 (check + upgrade + federation trust — author tooling complete)
