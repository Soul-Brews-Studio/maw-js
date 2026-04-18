# Contributing to maw-js

Thanks for taking an interest. This project is alpha — the surface moves fast and breaking changes land frequently. Expect churn; expect warmth.

## Quick start

```bash
bun install
bun run test:all    # ~2-3 min; runs unit, isolated, mock-smoke, plugin suites
bun run maw --help
```

Bun v1.3+ is required. tmux is needed for multi-agent features. On Linux, `ssh` must be on PATH for federation.

## Before opening a PR

1. `bun run test:all` passes locally.
2. New code has tests. If the code path is integration-only (spawns a subprocess, sets a timer, listens for a signal), document why in the test file.
3. New `mock.module(...)` calls live in `test/isolated/` or `test/helpers/` (see `scripts/check-mock-boundary.sh`).
4. If you added a new export to `src/core/transport/ssh.ts` or `src/config/*`, update the canonical mock in `test/helpers/mock-*.ts` (see `scripts/check-mock-export-sync.sh`).
5. Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `chore:`, `test:`, `docs:`.

## PR size

Soft cap: **~300 LOC of production code per PR** (Google research pegs review quality dropping past ~400; 300 leaves headroom).

The cap counts: files under `src/`, `scripts/`, and non-generated config.
The cap does **not** count: test files, fixtures under `test/fixtures/`, generated code (`dist/`, lockfiles), or vendored deps.

If you exceed the cap:

1. Consider splitting (scaffold → logic → integration, or per-file).
2. If splitting costs more than reviewing big, say so in the PR body and flag which chunks reviewers can skim vs read line-by-line.
3. Day-per-PR scaffolds (like ADR-002 Day 1 of 4) are fine — the *split itself* is the cap-honoring move.

Tests don't count toward the cap, but flag if tests are >50% of total diff so reviewers know what kind of PR they're reading.

### Per-file size

Within the PR cap, individual source files should target **150-200 LOC**. > 200 is a smell — split by responsibility (e.g., `parser.ts` + `validator.ts` instead of one `parse.ts`).

This is for NEW files. Existing oversized files aren't a forced refactor; just stay under 200 for any NEW additions and flag refactor opportunities in the PR body.

Exempt: type-definition files, specs/docs, generated/scaffolded boilerplate.

## Opening issues

- **Bugs**: include the command you ran, the output you got, and what you expected. A minimal repro beats a long narrative.
- **Features**: open a short issue describing the problem first. If we align on the shape, a PR is welcome.
- **Proposals / design docs**: use GitHub Discussions, not issues. Issues are for work; discussions are for thought.

## Versioning

**maw-js uses CalVer as of 2026-04-18.**

Scheme: `v{yy}.{m}.{d}[-alpha.{hour}]` — e.g. `v26.4.18` (stable) or `v26.4.18-alpha.19` (alpha cut at 19:xx ICT). Up to 24 alpha cuts per day (one per hour). Spec lives in [umbrella #526](https://github.com/Soul-Brews-Studio/maw-js/issues/526) and the [CHANGELOG](./CHANGELOG.md#versioning--calver-since-2026-04-18).

### Cut a release

```bash
TZ=Asia/Bangkok bun scripts/calver.ts            # alpha at current hour, e.g. v26.4.18-alpha.19
TZ=Asia/Bangkok bun scripts/calver.ts --stable   # stable cut, e.g. v26.4.18
TZ=Asia/Bangkok bun scripts/calver.ts --hour 14  # alpha at 14:xx
TZ=Asia/Bangkok bun scripts/calver.ts --check    # dry-run, no writes
```

Or via the npm script alias: `bun run calver [--stable|--hour N|--check]` (TZ still recommended).

Then commit + open a PR + merge into `main`. The `.github/workflows/calver-release.yml` workflow auto-tags `v<version>`, cuts a GitHub Release, and attaches the `dist/maw` build artifact. Single job — no cascade gaps.

### Do NOT manually bump semver

- Don't hand-edit `package.json` `version`. Always go through `scripts/calver.ts`.
- Old semver tags (`v2.0.0-alpha.117` → `v2.0.0-alpha.137`) remain readable for history but no new semver tags should be cut.
- The legacy `bun run ship:alpha` (`scripts/ship-alpha.sh`) still exists for emergency use during transition. It now prints a banner directing you to CalVer — please follow it.

## Releases (legacy — pre-2026-04-18)

Pre-CalVer alphas shipped from `main` via `bun run ship:alpha`. See `scripts/ship-alpha.sh`. Kept for historical reference; prefer the CalVer flow above.

## Code of Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). In short: be kind, assume good faith, name the behavior not the person.

## Security

See [SECURITY.md](./SECURITY.md) for responsible disclosure.

## License

By contributing, you agree that your contributions will be licensed under the repository's [LICENSE](./LICENSE).
