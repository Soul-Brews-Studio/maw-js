# maw-rs port status

Status anchor for maw-js issues [#1798](https://github.com/Soul-Brews-Studio/maw-js/issues/1798) and [#1801](https://github.com/Soul-Brews-Studio/maw-js/issues/1801).

## Current state

- `maw-js` owns the portable fixture specs in `test/spec/*.fixtures.json`.
- `maw-rs` lives at `Soul-Brews-Studio/maw-rs` and is no longer an empty scaffold.
- The Rust workspace currently contains these crate lanes: `maw-auth`, `maw-auto-wake`, `maw-bind`, `maw-bring`, `maw-calver`, `maw-cli`, `maw-feed`, `maw-fuzzy`, `maw-hub`, `maw-identity`, `maw-matcher`, `maw-peer`, `maw-plugin-manifest`, `maw-plugin-scaffold`, `maw-policy`, `maw-routing`, `maw-split`, `maw-tmux`, `maw-transport`, `maw-worktree`, and `maw-xdg`.
- The original #1798 gate is satisfied on the maw-js side: portable fixtures are stable, maw-js has reached the practical coverage ceiling, and maw-rs has an active Cargo workspace. Remaining work belongs in maw-rs crate/CLI parity issues rather than maw-js coverage work.
- #1801 is now a contributor workflow, not a blocker: maw-js provides the fixtures and coordination surface; implementation/review happens in maw-rs lanes with `cargo test --workspace` and crate-specific fixture parity as the proof.

## Portable fixture inventory

The current maw-js fixture set is:

- `bring-self-guard.fixtures.json`
- `bring-to-flag.fixtures.json`
- `bring-to-target.fixtures.json`
- `calver.fixtures.json`
- `canonical-node-identity.fixtures.json`
- `canonical-session-name.fixtures.json`
- `discover-tmux-live-state.fixtures.json`
- `matcher-resolve-target.fixtures.json`
- `normalize-target.fixtures.json`
- `peer-source-resolver.fixtures.json`
- `plugin-policy.fixtures.json`
- `routing.fixtures.json`
- `split-policy.fixtures.json`
- `transport-router.fixtures.json`
- `worktree-window-match.fixtures.json`

## Next contributor lanes

1. Pick one open maw-rs crate/CLI parity lane rather than reopening maw-js coverage work.
2. If it is pure logic, pick one fixture file above and add/update the matching Rust fixture loader in the relevant crate.
3. Keep the Rust implementation data-driven from fixtures, not copied line-for-line from TypeScript.
4. Prove the lane with `cargo test -p <crate>`; use `cargo test --workspace` before publishing a maw-rs batch.
5. If fixture behavior changes in maw-js, update the JSON fixture first, then port the new expectation to Rust.

## Cross-engine coordination contract

This is the #1801 experiment in concrete form:

- Claude/spec oracles write and refine behavioral specs.
- Codex implementation lanes make Rust fixture parity pass.
- thClaws/alternate engines can propose independent implementations or test reductions.
- `maw-js` remains the coordination layer and source of truth until `maw-rs` reaches CLI parity.

Do not treat this document as a release gate. It is a status and contributor-routing anchor so the open epic and proposal have a stable, current entry point.
