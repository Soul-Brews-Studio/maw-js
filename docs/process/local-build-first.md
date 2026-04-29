# Local-build-first

> **Run the binary, don't grep the bundle.**
> Filed after the [#911](https://github.com/Soul-Brews-Studio/maw-js/issues/911) post-mortem.

## TL;DR

Before you push, before you open a PR, before you claim "fixed":

```bash
bun run preflight
```

That runs `bun run build` and smoke-tests `dist/maw` in ~10 seconds. If it
passes, you have actual evidence the binary works. If it fails, you have a
real failure to investigate — not a CI mystery 5 minutes later.

CI still runs the authoritative `test:all` suite. Preflight is opt-in
augmentation, not a replacement.

## Why this exists

On 2026-04-29, the registry-monorepo migration paid the GitHub Actions tax
**7+ times** (alpha.41 → alpha.44 plus intermediate failures), each cycle
~3-7 min. The whole detour was caused by one false-negative grep.

The chain:

1. A verifier ran `strings dist/maw | grep -c monorepo`. It returned 0.
2. The verifier ABORTed reporting "alpha.43 binary missing #908 handler."
3. Emergency PR #909 cut alpha.44 to "force fresh build."
4. Turns out alpha.43 was fine all along. The grep was wrong.

Total wasted: ~30 min on phantom panic + a redundant alpha cut + the noise
in the version stream. The fix would have been instant if anyone had run
`./dist/maw plugin install shellenv` locally before merging #908.

## Why grep on a Bun bundle is a false-positive trap

`bun build --minify` (which the project uses for `dist/maw`) does two
things that defeat naive grep:

1. **Identifier renaming.** Function names like `parseMonorepoRef` get
   renamed to 1-char vars (`a`, `b`, `c`). The original symbol name is
   gone from the bundle.
2. **Dead-string elimination.** String literals only used inside dead-
   stripped code paths get removed entirely. Comment-strings drop. Even
   live strings can be inlined and concatenated past recognition.

So when you run:

```bash
strings dist/maw | grep -c parseMonorepoRef    # → 0
```

That **0 is not evidence the symbol is missing**. The symbol is almost
certainly present, just renamed. You proved nothing.

The right test is:

```bash
./dist/maw plugin install monorepo-thing       # actually exercises the path
```

If the binary actually parses a monorepo ref, the handler is present —
no matter what `strings` claims.

> **Rule:** Never trust `strings dist/maw | grep <symbol>` as evidence the
> symbol is or isn't in the bundle. Run the binary instead. Behavior is the
> only oracle.

This same trap caught us earlier on #902/#904 — same shape, different
symbol. It's worth filing the rule once and pointing future-us back here.

## When to run preflight

| When | Why |
|---|---|
| **Before `git push`** | Catches build break + obvious smoke fail in 10s |
| **Before opening a PR** | CI passes faster when the obvious things are already green |
| **Before claiming "fixed"** | You ran the binary; you actually know |
| **After a registry / install path change** | Run with `--install <name>` for the full round-trip |
| **When CI says `binary missing X` and you're tempted to force-rebuild** | Run preflight first. It's faster than another 5-min CI cycle. |

Skip preflight when:

- Docs-only changes
- CI config or YAML-only changes
- Pure-text PRs where there's no binary surface to smoke

Use judgment. The tax is ~10 sec; not running it is rarely worth ~5 min in
CI.

## What preflight actually does

```bash
bun run preflight
# → bun run build         (silent unless fails)
# → dist/maw --version    (smoke)
# → dist/maw plugin --help (smoke)
# → "Local-build OK; safe to push"
```

With `--install <plugin>` it adds a full install round-trip against the
live registry:

```bash
bun run preflight -- --install shellenv
# → bun run build
# → dist/maw plugin install shellenv     (real network, real registry)
# → dist/maw --version
# → dist/maw plugin --help
# → "Local-build OK; safe to push"
```

This is the test that would have caught #908 before #909 ever shipped.

## CDN cache propagation gotcha

The plugin registry is served from `raw.githubusercontent.com`, which
caches aggressively (~5 min propagation). After you push a registry
update:

- The registry.json HEAD on GitHub is up-to-date instantly.
- `raw.githubusercontent.com/.../registry.json` may serve the **previous**
  version for ~5 min.
- A verifier that hits raw immediately after the push gets stale data.

Mitigations when running verification scripts (not preflight — preflight
hits your local build, not the registry):

- `MAW_REGISTRY_URL='https://raw.githubusercontent.com/.../registry.json?bust=$(date +%s)'`
  — query-string busts the CDN entry per-call.
- Fetch via `gh api` — bypasses the CDN entirely.
- Sleep 5 min after a registry push before running install verifiers.

This bit us on top of the bundle-grep issue: a stale registry response
during the alpha.43 panic made the verifier doubly confused. Don't repeat
the mistake.

## See also

- [#911](https://github.com/Soul-Brews-Studio/maw-js/issues/911) — the
  post-mortem that birthed this script
- [#909](https://github.com/Soul-Brews-Studio/maw-js/pull/909) — the
  redundant force-rebuild PR (would not have shipped if preflight had
  existed)
- [#908](https://github.com/Soul-Brews-Studio/maw-js/pull/908) — the
  monorepo source resolver that triggered the false-positive chase
- [#902](https://github.com/Soul-Brews-Studio/maw-js/pull/902) /
  [#904](https://github.com/Soul-Brews-Studio/maw-js/pull/904) — earlier
  bundle-grep false positive of the same shape
- `scripts/preflight.sh` — the script itself, with inline rationale
- `CONTRIBUTING.md` → "Before opening a PR" — pushes you here
