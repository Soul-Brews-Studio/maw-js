# Decision: @maw/sdk npm publish strategy (issue #339)

## Owner identity

**`neo-oracle`** — the GitHub identity that owns the Soul-Brews-Studio org and the maw-js repo.

Rationale: zero new account setup, 2FA already enabled, most direct path to a first publish. The npm scope is `@maw` (org-style scoping), which is independent of the publisher identity.

Alternative considered: create a dedicated `soulbrews` npm org account. Deferred to Phase B when organizational publishing hygiene matters more.

## Types-only alpha.1 (Option C from debate)

### Option A — Ship types-only alpha.1 now (tarball ready)
Unblocks plugin authors immediately. No runtime shipped yet.

### Option B — Wait for Phase B (runtime + types together)
Cleaner first release, but delays ecosystem adoption for weeks.

### Option C (selected) — Ship A now, graduate to stable at Phase B
Best of both: plugin authors get the stable typed API today; runtime lands in `1.0.0` when Phase B (#340) completes. Alpha semver (`1.0.0-alpha.1`) signals pre-stable clearly.

## What ships now (this PR)

- GitHub Actions workflow `publish-sdk.yml` — tag-gated, provenance-enabled
- `PUBLISH.md` — one-time scope claim + secret setup instructions
- `packages/sdk/package.json` — already complete (name, version, publishConfig, files, exports)

## What does NOT ship now

- The actual `npm publish` invocation — @nazt does this interactively after workflow lands
- Runtime code — types-only until Phase B
- npm org account / secrets — manual one-time steps documented in PUBLISH.md

## Phase B graduation plan (#340)

1. Ship runtime implementation alongside types
2. Re-export from `@maw/sdk` without breaking the existing types API
3. Bump to `1.0.0` stable, remove `-alpha` pre-release tag
4. Update `PUBLISH.md` with stable publishing cadence
