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
5. **Run `bun run check:redos`** — pre-flight ReDoS scan that catches the most common polynomial-backtracking shapes before CI's CodeQL job does. See [ReDoS pre-flight](#redos-pre-flight) below.
6. Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `chore:`, `test:`, `docs:`.

## ReDoS pre-flight

`scripts/check-redos.ts` is a lightweight rules-based scanner that catches the regex shapes most likely to trip GitHub CodeQL's `js/polynomial-redos` alert. It's not a CodeQL replacement — CodeQL still runs in CI and is the authoritative gate. This script just shaves the ~5 min CI round-trip when a fixable ReDoS slips into a PR.

Run it manually:

```bash
bun run check:redos                    # scan all of src/
bun scripts/check-redos.ts <files>...  # scan specific files (hook-friendly)
```

It exits **non-zero** when it finds a high-severity match. Patterns:

| Rule | Shape | Severity | Fix |
|---|---|---|---|
| **A** | `/[chars]+$/` (positive char class, `+`/`*`, anchored to `$` only — no `^`) | high | Anchor with `^...$`, or prefix `(?<![chars])` look-behind. |
| **B** | `/(a\|b\|c)[+*]/` (alternation with unbounded quantifier, no `^` anchor) | high | Factor the alternation out, or use atomic groups. |
| **D** | `/(.+)+/` (nested unbounded quantifiers) | high | Collapse — `(.+)+` ≡ `.+`. |
| **C** | `new RegExp(<dynamic>)` (concat / template literal) | info | Verify the source is regex-quoted. |

### Escape hatch — `// CODEQL_OK`

If you've verified a flagged regex is genuinely safe (small bounded input, etc.), append `// CODEQL_OK: <reason>` to the line. The detector will skip it.

```ts
.replace(/[-.]+$/, "")  // CODEQL_OK: input length-capped to 50, no backtracking risk
```

Use sparingly — every escape is something CI's CodeQL might still flag.

### When to use the CodeQL CLI

For deeper analysis (data-flow, taint tracking), run the full CodeQL CLI locally — `gh codeql database create && gh codeql analyze`. Reserve this for security-sensitive PRs; the lightweight scanner is enough for day-to-day work.

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

## Branch model

- **`main`** — stable releases only. No alpha tags, no in-progress work. Every commit is a cut version that someone could install today.
- **`alpha`** — active development. All feature/bugfix PRs target this branch. Alpha versions accumulate here.

PRs to `main` come from one source: `alpha` itself, on a stable cut.

## Versioning

**maw-js uses CalVer as of 2026-04-18.**

Scheme: `v{yy}.{m}.{d}[-alpha.{N}]` — e.g. `v26.4.18` (stable) or `v26.4.18-alpha.19` (alpha cut). Spec lives in [umbrella #526](https://github.com/Soul-Brews-Studio/maw-js/issues/526) and the [CHANGELOG](./CHANGELOG.md#versioning--calver-since-2026-04-18). The alpha-counter scheme (hour-bucket vs monotonic) is tracked in [#766](https://github.com/Soul-Brews-Studio/maw-js/issues/766).

## Releasing

The day-to-day flow — alphas accumulate on `alpha`, stable cuts roll up to `main`:

1. **Branch from `alpha`.** Name the branch `fix/<issue>-<slug>` or `feat/<issue>-<slug>`.
   ```bash
   git fetch origin
   git checkout -B alpha origin/alpha
   git checkout -b fix/123-my-bugfix
   ```
2. **Open the PR with base `alpha`** (NOT `main`).
   ```bash
   gh pr create --base alpha --title "fix: ..."
   ```
3. **`/calver --apply` runs on `alpha` only.** Alpha versions accumulate on `alpha`; `main` never receives an alpha bump directly. If you find yourself bumping CalVer on `main`, stop — you're on the wrong branch.
4. **Cut stable when ready** by opening a PR from `alpha` into `main`:
   ```bash
   gh pr create --base main --head alpha --title "release: vYY.M.D"
   ```
5. **Merge the stable PR.** Squash-merge or fast-forward, depending on the cut's history. The `.github/workflows/calver-release.yml` workflow auto-tags `v<version>`, cuts a GitHub Release, and attaches the `dist/maw` artifact.

### When to cut stable

Cutting stable is a **discrete decision, not automatic**. Common triggers:

- A coherent batch of fixes/features has settled on `alpha` and tests are green.
- A user-visible milestone wants a clean version pointer.
- Time has passed and `alpha` is materially ahead of `main`.

There is no fixed cadence. If `alpha` is quiet, don't cut. If `alpha` has shipped real value, cut.

### Cut commands

```bash
TZ=Asia/Bangkok bun scripts/calver.ts            # alpha bump (run on `alpha` branch)
TZ=Asia/Bangkok bun scripts/calver.ts --stable   # stable bump (run on `alpha`, then PR to `main`)
TZ=Asia/Bangkok bun scripts/calver.ts --hour 14  # alpha pinned to a specific hour bucket
TZ=Asia/Bangkok bun scripts/calver.ts --check    # dry-run, no writes
```

Or via the npm-script alias: `bun run calver [--stable|--hour N|--check]` (TZ still recommended).

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
