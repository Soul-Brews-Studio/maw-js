# Changelog

All notable changes to `maw` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 alpha releases may introduce breaking changes at any time.

## [Unreleased]

### Changed
- **Renamed npm package** `maw` → `maw-js` to eliminate bun `DependencyLoop` caused by collision with unrelated stale `maw@0.6.0` on npm. Binary name unchanged — users still run `maw`. Fixes #554, closes #555, eliminates root cause of #531.

### Added
- `docs/install-recovery.md` — runbook for `maw: command not found` recovery, plus README pointer (#531 mitigation ship; root cause fixed by package rename above)

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
