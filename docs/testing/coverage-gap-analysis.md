# Coverage gap analysis

Generated: 2026-05-16T21:34:15.654Z

Input: `coverage/lcov.info`

Coverage scope: Bun LCOV plus zero-coverage accounting for tracked `src/**/*.ts` files absent from LCOV.

Overall line coverage: **18.2%** (9149/50284)
Overall function coverage: **64.6%** (1018/1575)

## Module summary

| Module | Files | Missing from LCOV | Lines | Functions | Branches |
| --- | ---: | ---: | ---: | ---: | ---: |
| cli/dispatch | 88 | 18 | 38.8% (2849/7338) | 65.9% (273/414) | n/a (0/0) |
| config/runtime | 19 | 2 | 45.3% (529/1167) | 43.7% (38/87) | n/a (0/0) |
| fleet | 17 | 0 | 38.8% (407/1050) | 54.8% (40/73) | n/a (0/0) |
| matcher | 2 | 0 | 100.0% (41/41) | 100.0% (8/8) | n/a (0/0) |
| other | 174 | 95 | 18.9% (2717/14355) | 55.9% (278/497) | n/a (0/0) |
| plugin dispatch | 15 | 1 | 67.2% (819/1218) | 83.8% (67/80) | n/a (0/0) |
| routing/aliases | 4 | 0 | 49.2% (300/610) | 72.7% (32/44) | n/a (0/0) |
| transport | 28 | 2 | 53.4% (1342/2513) | 76.3% (270/354) | n/a (0/0) |
| vendor plugins | 245 | 244 | 0.7% (145/21992) | 66.7% (12/18) | n/a (0/0) |

## Top 20 uncovered files by executable/source line count

| Rank | Risk | Module | File | Uncovered | Line coverage | Function coverage | Note |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 1 | low | vendor plugins | `src/vendor/mpr-plugins/dream/impl.ts` | 885 | 0.0% | n/a | absent from LCOV |
| 2 | medium | other | `src/commands/plugins/tmux/impl.ts` | 590 | 5.1% | 0.0% | partial coverage |
| 3 | low | vendor plugins | `src/vendor/mpr-plugins/team/team-charter.ts` | 482 | 0.0% | n/a | absent from LCOV |
| 4 | medium | other | `src/commands/plugins/team/index.ts` | 477 | 0.0% | n/a | absent from LCOV |
| 5 | critical | cli/dispatch | `src/commands/shared/wake-cmd.ts` | 443 | 30.9% | 76.7% | partial coverage |
| 6 | low | vendor plugins | `src/vendor/mpr-plugins/messages/index.ts` | 398 | 0.0% | n/a | absent from LCOV |
| 7 | medium | other | `src/api/sessions.ts` | 372 | 16.8% | 12.5% | partial coverage |
| 8 | low | vendor plugins | `src/vendor/mpr-plugins/cleanup/internal/prune-stale-oracles.ts` | 366 | 0.0% | n/a | absent from LCOV |
| 9 | medium | other | `src/core/engine-plugin-registry.ts` | 336 | 0.0% | n/a | absent from LCOV |
| 10 | low | vendor plugins | `src/vendor/mpr-plugins/doctor/impl.ts` | 332 | 0.0% | n/a | absent from LCOV |
| 11 | low | vendor plugins | `src/vendor/mpr-plugins/team/index.ts` | 314 | 0.0% | n/a | absent from LCOV |
| 12 | critical | cli/dispatch | `src/cli/cmd-update.ts` | 308 | 28.7% | 73.3% | partial coverage |
| 13 | low | vendor plugins | `src/vendor/mpr-plugins/bg/src/impl.ts` | 297 | 0.0% | n/a | absent from LCOV |
| 14 | medium | other | `src/commands/plugins/tile/impl.ts` | 283 | 0.0% | n/a | absent from LCOV |
| 15 | medium | other | `src/commands/plugins/plugin/install-handlers.ts` | 280 | 24.9% | 18.8% | partial coverage |
| 16 | low | vendor plugins | `src/vendor/mpr-plugins/view/impl.ts` | 269 | 0.0% | n/a | absent from LCOV |
| 17 | medium | other | `src/commands/plugins/tmux/index.ts` | 260 | 0.0% | n/a | absent from LCOV |
| 18 | low | vendor plugins | `src/vendor/mpr-plugins/init/internal/plugin-lock.ts` | 251 | 0.0% | n/a | absent from LCOV |
| 19 | low | vendor plugins | `src/vendor/mpr-plugins/peers/index.ts` | 250 | 0.0% | n/a | absent from LCOV |
| 20 | critical | transport | `src/transports/scout.ts` | 248 | 8.5% | 0.0% | partial coverage |

## Critical files at or above the 80% line target

| Module | File | Line coverage | Function coverage |
| --- | --- | ---: | ---: |
| cli/dispatch | `src/cli/cmd-version.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-match.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-types.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-wasm.ts` | 87.1% | 50.0% |
| cli/dispatch | `src/cli/command-registry.ts` | 96.7% | 100.0% |
| cli/dispatch | `src/cli/dispatch-match.ts` | 91.7% | 90.0% |
| cli/dispatch | `src/cli/parse-args.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/usage.ts` | 89.6% | 92.9% |
| cli/dispatch | `src/cli/verbosity.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/comm-send.ts` | 88.2% | 92.6% |
| cli/dispatch | `src/commands/shared/comm.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/done.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-apply.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-diff.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-identity.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-sync.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-checks-repo.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-checks.ts` | 97.5% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-fixer.ts` | 87.3% | 40.0% |
| cli/dispatch | `src/commands/shared/fleet-wake-failsoft.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-as.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-rust.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-scaffold.ts` | 82.7% | 75.0% |
| cli/dispatch | `src/commands/shared/plugin-create.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugins-ls-info.ts` | 87.1% | 90.0% |
| cli/dispatch | `src/commands/shared/plugins-ui.ts` | 96.0% | 100.0% |
| cli/dispatch | `src/commands/shared/target-cwd.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-resolve.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-target.ts` | 80.0% | 80.0% |
| cli/dispatch | `src/commands/shared/wake.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/leaf.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/oracle-registry.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/registry-oracle-scan-local.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/registry-oracle-types.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/snapshot.ts` | 93.4% | 100.0% |
| fleet | `src/core/fleet/validate.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/worktree-window-match.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/worktrees.ts` | 100.0% | 100.0% |
| matcher | `src/core/matcher/normalize-target.ts` | 100.0% | 100.0% |
| matcher | `src/core/matcher/resolve-target.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/default-active.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/dependencies.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/lifecycle.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-constants.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-load.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-parse.ts` | 96.3% | 100.0% |
| plugin dispatch | `src/plugin/manifest-validate.ts` | 89.7% | 100.0% |
| plugin dispatch | `src/plugin/manifest.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/registry-semver.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/tier.ts` | 100.0% | 100.0% |
| routing/aliases | `src/core/routing.ts` | 89.1% | 91.7% |
| transport | `src/core/transport/tmux-class.ts` | 87.1% | 96.3% |
| transport | `src/core/transport/tmux.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/transport.ts` | 100.0% | 96.4% |
| transport | `src/transports/http.ts` | 100.0% | 100.0% |
| transport | `src/transports/hub-config.ts` | 90.0% | 100.0% |
| transport | `src/transports/hub-connection.ts` | 100.0% | 93.8% |
| transport | `src/transports/hub-transport.ts` | 99.2% | 92.0% |
| transport | `src/transports/hub.ts` | 100.0% | 100.0% |
| transport | `src/transports/lora.ts` | 100.0% | 90.9% |
| transport | `src/transports/nanoclaw.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-pair-proof.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-protocol.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-state.ts` | 100.0% | 100.0% |
| transport | `src/transports/tmux.ts` | 100.0% | 100.0% |
| transport | `src/transports/zenoh-scout.ts` | 90.3% | 66.7% |
| transport | `src/transports/zenoh.ts` | 100.0% | 100.0% |

## Critical files below the 80% line target (next queue)

| Module | File | Uncovered | Line coverage |
| --- | --- | ---: | ---: |
| cli/dispatch | `src/commands/shared/wake-cmd.ts` | 443 | 30.9% |
| cli/dispatch | `src/cli/cmd-update.ts` | 308 | 28.7% |
| transport | `src/transports/scout.ts` | 248 | 8.5% |
| cli/dispatch | `src/commands/shared/wake-resolve-impl.ts` | 226 | 28.7% |
| transport | `src/transports/mdns.ts` | 184 | 7.5% |
| transport | `src/core/transport/peers.ts` | 176 | 31.3% |
| transport | `src/core/transport/pty.ts` | 150 | 0.0% |
| routing/aliases | `src/cli/top-aliases.ts` | 148 | 41.3% |
| plugin dispatch | `src/plugin/registry.ts` | 147 | 8.1% |
| cli/dispatch | `src/commands/shared/fleet-wake.ts` | 146 | 0.0% |

## Critical gaps to prioritize

- `src/commands/shared/wake-cmd.ts` (cli/dispatch): 443 uncovered lines, 30.9% line coverage.
- `src/cli/cmd-update.ts` (cli/dispatch): 308 uncovered lines, 28.7% line coverage.
- `src/transports/scout.ts` (transport): 248 uncovered lines, 8.5% line coverage.

## Prioritization guidance

- High-signal gaps likely to catch real bugs: wake/bring dispatch (`wake-cmd.ts`, `wake-resolve-impl.ts`), message delivery/routing (`comm-send.ts`, `routing.ts`), tmux transport primitives (`tmux-class.ts`), peer discovery transports (`scout.ts`, `mdns.ts`), plugin invocation (`registry-invoke.ts`), and worktree/fleet scans (`worktrees-scan.ts`).
- Lower-signal/ceremony gaps: large vendored MPR plugin implementations, UI/cosmetic renderers, and plugin bodies where behavior is better covered by CLI smoke tests or end-to-end plugin tests.
- Portable-core candidates for #1612 fixture extraction: matcher, routing alias guards, calver, plugin tier/default-active policy, and pure transport-router selection/failover.

## Notes

- Critical = routing/aliases, CLI dispatch, transports, fleet, matcher, and plugin dispatch.
- Low-risk = vendor plugin surfaces and UI/cosmetic code where smoke/manual tests often provide better value than line-driven unit tests.
- Files absent from LCOV are counted as zero-covered using non-empty/non-comment source lines so the report exposes untouched modules, not only imported files.
