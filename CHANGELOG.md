# Changelog

All notable changes to `maw` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning — CalVer (since 2026-04-18)

On **2026-04-18**, `maw-js` migrated from SemVer alpha (`2.0.0-alpha.N`) to
**CalVer** (`v{yy}.{m}.{d}[-alpha.{hour}]`). The first CalVer cut is
[`v26.4.18-alpha.19`](https://github.com/Soul-Brews-Studio/maw-js/releases/tag/v26.4.18-alpha.19),
matching the scheme already adopted by [skills-cli `v26.4.18`](https://github.com/Soul-Brews-Studio/skills-cli)
(the precedent).

- **Why**: dates carry meaning, alpha numbers don't. CalVer makes "how old is
  this build?" answerable at a glance, and the 24/day cap is sufficient for
  an alpha cadence.
- **Rollover**: `-alpha.{hour}` (0–23) — at most 24 alpha cuts per UTC day.
- **Old tags resolvable**: existing `v2.0.0-alpha.117` through `alpha.137`
  tags are **not** rewritten — `plugins.lock` references and historical
  changelog entries below remain valid forever.
- **Umbrella**: [#526](https://github.com/Soul-Brews-Studio/maw-js/issues/526).

Pre-1.0 alpha releases may still introduce breaking changes at any time.

## [Unreleased]

### Security
- `auth`: replace predictable JWT secret default (`"maw-" + node`) with a 32-byte random secret persisted to `<CONFIG_DIR>/auth-secret` (mode 0600), generated on first run like an SSH host key. `MAW_JWT_SECRET` env var still takes precedence. Operators see a one-time `[auth] generated random JWT secret → …` line on creation. Fixes #801.

### Changed
- **Renamed npm package** `maw` → `maw-js` to eliminate bun `DependencyLoop` caused by collision with unrelated stale `maw@0.6.0` on npm. Binary name unchanged — users still run `maw`. Fixes #554, closes #555, eliminates root cause of #531.

### Added
- `scope-acl` — pure ACL evaluation module at `src/commands/shared/scope-acl.ts` deciding `allow` vs `queue` for cross-oracle messages based on shared scope membership (Phase 1 #829), with optional pairwise trust list (Sub-B reserved). Self-messages always allowed; default-deny otherwise. Ships filesystem helper `loadAllScopes()` mirroring `cmdList()`. NOT yet wired into `comm-send.ts` — caller integration is Sub-B/C of #842. Sub-A of #842.
- `maw update`: serialize concurrent invocations via `~/.maw/update.lock` (#551)
- `docs/install-recovery.md` — runbook for `maw: command not found` recovery, plus README pointer (#531 mitigation ship; root cause fixed by package rename above)
- `peers.json` schema gains `pubkey` + `pubkeyFirstSeen` fields. Federation peer pubkey caching with TOFU semantics (Trust On First Use): first sight pins, mismatches are refused with a fail-loud message pointing operators to `maw peers forget`. Legacy peers with no pubkey are accepted during the v26.5.x alpha migration window (will hard-cut at v27 — see ADR `docs/federation/0001-peer-identity.md` Step 6). New `maw peers forget <alias>` clears a pinned pubkey to allow re-TOFU after legitimate key rotation. Step 2 of #804.
- Federation incoming `from:` + signature verification with O6 enforcement: protected `/api/send`, `/api/wake`, `/api/sleep`, `/api/pane-keys` now run a per-peer continuity check after the fleet HMAC. Cached pubkey + signed valid → accept. Cached pubkey + unsigned → REFUSE ("you used to sign"). Cached pubkey + signed mismatch → REFUSE + alert (rotation or impersonation). No cache + signed → accept (TOFU record). No cache + unsigned → accept (legacy bootstrap). Clock skew rejected at ±300s. Body, method, path are all bound to the signature so replay against a different endpoint or body fails closed. New helpers `verifyRequest`, `buildFromSignPayload`, `verifyHmacSig`, `lookupCachedPubkey`. Step 4 VERIFY of #804.
- `POST /api/probe` — real-write-path federation health check. Walks the same `resolveTarget` + tmux-session-exists branches as `/api/send` but never delivers (no `sendKeys`). Body `{ target? }`: with target, validates target resolves and reports the transport that would be used; without target, confirms the server can run the write code path (config + listSessions). Same auth surface as `/send` (HMAC + `from:` signature). `maw health` switches its "maw server" check from `GET /api/sessions` to `POST /api/probe` so a green health check means a green delivery channel — closes the #795 schema-drift class of failure where `/api/identity` returned 200 OK while `/api/send` was broken on a disjoint code path. Step 5 of #804.

### Fixed
- `maw update`: stash maw binary before bun-remove fallback so failed retries don't strand users with no binary (#551 — defensive belt-and-suspenders; package rename above is the root-cause fix)
- `withUpdateLock`: fd-based read/write on lock file to prevent path TOCTOU from symlink substitution between openSync and the path-based follow-up

## [v2.0.0-alpha.134] - 2026-04-18

### Added
- `maw plugin dev` — live-reload plugin development verb (#479, #340 Wave 1B)
- Opt-in `.d.ts` generation for the plugin compiler (#480, #340 Wave 1C)
- `maw demo` — simulated multi-agent session, zero-dependency onboarding path (#482)

### Changed
- Plugin compiler uses AST-based capability inference instead of regex heuristics (#481, #340 Wave 1A)
- `mkdir` usage migrated to idempotent calls to close TOCTOU-class CodeQL findings (#485)

### Fixed
- `install.sh`: path-traversal guard + download size cap on fetch (#488)
- Hub-connection logging now sanitises attacker-influenced fields (#474 follow-up)

### Security
- Test tmpdir paths migrated to `mkdtempSync` (CodeQL `js/insecure-temporary-file`)

## [v2.0.0-alpha.133] - 2026-04-18

### Fixed
- `tmux` send: flush-wait before Enter to eliminate paste/submit race (#478)

## [v2.0.0-alpha.132] - 2026-04-18

### Fixed
- `maw update`: atomic install + regression guard (post-#476 hardening) (#477)

## [v2.0.0-alpha.131] - 2026-04-18

### Added
- `wake-resolve-github`: wrap external content in a provenance frame before handing to the agent (#462)

### Changed
- `scan-remote` uses `execFileSync` + org-name allowlist instead of a shell string (#473, #475)

## [v2.0.0-alpha.130] - 2026-04-18

> Emergency fix for `maw uninstall`.

### Fixed
- `maw update`: validate ref **before** `bun remove` — previously a bad ref could uninstall `maw` without reinstalling it

## [v2.0.0-alpha.129] - 2026-04-18

### Added
- CodeQL static analysis workflow (#472, follow-up to #452)

## [v2.0.0-alpha.128] - 2026-04-18

### Changed
- Legacy `hostExec` calls routed through the `Tmux` class (#471)

## [v2.0.0-alpha.127] - 2026-04-18

### Changed
- `api` + `cli` + `federation`: allowlists and schema validation on external input

## [v2.0.0-alpha.126] - 2026-04-18

### Fixed
- `api`: inverted `NODE_ENV` condition that was bypassing peer-exec / proxy session checks

## [v2.0.0-alpha.125] - 2026-04-18

### Changed
- Bump minor-and-patch dependency group (3 updates)

## [v2.0.0-alpha.124] - 2026-04-18

### Added
- CI auto-regenerates `bun.lock` on dependabot PRs (#466, #468)

## [v2.0.0-alpha.123] - 2026-04-18

### Added
- `maw costs --daily` — 7-day per-agent sparkline view (#454, #465)

### Changed
- Bump `softprops/action-gh-release` 2 → 3 (#460)
- Bump `actions/checkout` 4 → 6 (#459)
- Bump `actions/setup-node` 4 → 6 (#458)
- Bump `actions/cache` 4 → 5 (#457)
- `test/pulse-label-injection` moved to `test/isolated/` (#387 boundary)

## [v2.0.0-alpha.122] - 2026-04-18

### Added
- OSS scaffold (ship-this-week subset): badges, issue templates, CODEOWNERS

### Changed
- `pulse`: `gh` CLI invocations use `Bun.spawn` arg array (#463)
- `wake-resolve`: pass-secret resolution decomposed out of the tmux setenv call

## [v2.0.0-alpha.121] - 2026-04-18

### Fixed
- Release-gate test bypass removed; lean root cleanup (#450, #451)

### Changed
- `test/bud-org-flag` moved to `test/isolated/` (#387 boundary)

## [v2.0.0-alpha.120] - 2026-04-18

### Added
- `maw inbox` + `maw messages` — thread-backed via `ψ/inbox/` (#446, #364)
- `maw oracle prune` + `maw oracle register` verbs (#447, #383)
- `maw signals` + bud `signal-drop` primitive (slice γ-B) (#445, #209)
- SDK: npm publish workflow + packaging docs (#442, #339)

### Fixed
- Idle-guard before `send-keys` — abort when user is actively typing (#444, #405)

## [v2.0.0-alpha.119] - 2026-04-18

### Fixed
- Local-first resolve surfaces remote fetch failures explicitly (#448, #411)

## [v2.0.0-alpha.118] - 2026-04-17

### Added
- Plugin-compiler Phase B decomposition spec (#443, #340, docs-only)

### Changed
- OSS governance scaffolding; drop `maw-js/` path-ignore from test-isolated

## [v2.0.0-alpha.117] - 2026-04-17

### Added
- `mock-export-sync` lint rule (#441, #435)

### Fixed
- `test:mock-smoke` + `test:plugin` honour path-ignore for worktree recursion
- Restore ssh mock per-test in `tmux.test.ts` (#440, #438)

### Removed
- 664KB of audio assets from `ui/office` (untracked)
- `.envrc` + self-referential `maw-js` symlink

## Earlier releases

See the [Releases page](https://github.com/Soul-Brews-Studio/maw-js/releases) for alphas prior to v2.0.0-alpha.117.

[Unreleased]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.134...HEAD
[v2.0.0-alpha.134]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.133...v2.0.0-alpha.134
[v2.0.0-alpha.133]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.132...v2.0.0-alpha.133
[v2.0.0-alpha.132]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.131...v2.0.0-alpha.132
[v2.0.0-alpha.131]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.130...v2.0.0-alpha.131
[v2.0.0-alpha.130]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.129...v2.0.0-alpha.130
[v2.0.0-alpha.129]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.128...v2.0.0-alpha.129
[v2.0.0-alpha.128]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.127...v2.0.0-alpha.128
[v2.0.0-alpha.127]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.126...v2.0.0-alpha.127
[v2.0.0-alpha.126]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.125...v2.0.0-alpha.126
[v2.0.0-alpha.125]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.124...v2.0.0-alpha.125
[v2.0.0-alpha.124]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.123...v2.0.0-alpha.124
[v2.0.0-alpha.123]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.122...v2.0.0-alpha.123
[v2.0.0-alpha.122]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.121...v2.0.0-alpha.122
[v2.0.0-alpha.121]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.120...v2.0.0-alpha.121
[v2.0.0-alpha.120]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.119...v2.0.0-alpha.120
[v2.0.0-alpha.119]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.118...v2.0.0-alpha.119
[v2.0.0-alpha.118]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.117...v2.0.0-alpha.118
[v2.0.0-alpha.117]: https://github.com/Soul-Brews-Studio/maw-js/compare/v2.0.0-alpha.116...v2.0.0-alpha.117
