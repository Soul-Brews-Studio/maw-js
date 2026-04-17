# test/

## Canonical suite

Use `bun run test:all`. This is the ship gate — the alpha release script
(`scripts/ship-alpha.sh`) refuses to tag if it fails.

`test:all` runs four disjoint invocations so mocks don't cross-pollute:

1. `bun test test/` with `test/isolated/` and `zz-mock-tmux-smoke` excluded
2. `bun test test/isolated/`
3. `bun test test/zz-mock-tmux-smoke.test.ts`
4. `bun test src/commands/plugins/`

## Why `bun test test/` (bare, no flags) is broken

Bun's `mock.module()` is **process-global and retroactive**. Two test files
that both mock the same path race inside one Bun process — one wins, the
other observes the wrong stub. Fix: run mutually-incompatible mockers in
separate invocations. Bare `bun test test/` puts them all in one process
and produces ~57 spurious failures; we accept that and ship via `test:all`.
See issue #387.

## Where `mock.module()` is allowed

- **`test/isolated/`** — invoked as its own `bun test` call by
  `test:isolated`. Each file may mock freely; pollution is contained.
- **`test/helpers/`** — shared mock definitions (imported, not executed).

New files outside those two directories **must not** call `mock.module()`.
`scripts/check-mock-boundary.sh` enforces this as a pre-tag gate. Options
when it trips:

- Move the test into `test/isolated/` (preferred).
- Add `// mock-boundary-ok: <reason>` on the offending line for a one-off
  justification (rare — `zz-mock-tmux-smoke` is the canonical example).

`scripts/mock-boundary-allowlist.txt` grandfathers files that predate the
rule. That list is expected to shrink; adding new entries requires review.
