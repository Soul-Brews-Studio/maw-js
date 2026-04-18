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

## Releases

Alphas ship from `main` via `bun run ship:alpha`. The script lints, tags, and force-pushes the rolling `alpha` branch. See `scripts/ship-alpha.sh`.

## Code of Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). In short: be kind, assume good faith, name the behavior not the person.

## Security

See [SECURITY.md](./SECURITY.md) for responsible disclosure.

## License

By contributing, you agree that your contributions will be licensed under the repository's [LICENSE](./LICENSE).
