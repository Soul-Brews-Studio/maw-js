# Coverage gap analysis

Generated: 2026-05-17T13:35:47.405Z

Input: `coverage/lcov.info`

Coverage scope: Bun LCOV plus zero-coverage accounting for tracked `src/**/*.ts` files absent from LCOV.

Overall line coverage: **31.7%** (15931/50255)
Overall function coverage: **82.2%** (1806/2196)

## Module summary

| Module | Files | Missing from LCOV | Lines | Functions | Branches |
| --- | ---: | ---: | ---: | ---: | ---: |
| cli/dispatch | 90 | 10 | 70.9% (5253/7407) | 83.4% (532/638) | n/a (0/0) |
| config/runtime | 19 | 2 | 66.6% (776/1166) | 74.0% (71/96) | n/a (0/0) |
| fleet | 17 | 0 | 58.4% (609/1042) | 69.9% (58/83) | n/a (0/0) |
| matcher | 2 | 0 | 100.0% (41/41) | 100.0% (8/8) | n/a (0/0) |
| other | 174 | 69 | 37.1% (5343/14391) | 75.1% (575/766) | n/a (0/0) |
| plugin dispatch | 15 | 1 | 86.6% (1015/1172) | 89.9% (80/89) | n/a (0/0) |
| routing/aliases | 4 | 0 | 91.4% (582/637) | 94.5% (69/73) | n/a (0/0) |
| transport | 28 | 1 | 87.4% (2131/2438) | 94.7% (397/419) | n/a (0/0) |
| vendor plugins | 245 | 243 | 0.8% (181/21961) | 66.7% (16/24) | n/a (0/0) |

## Top 20 uncovered files by executable/source line count

| Rank | Risk | Module | File | Uncovered | Line coverage | Function coverage | Note |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 1 | low | vendor plugins | `src/vendor/mpr-plugins/dream/impl.ts` | 885 | 0.0% | n/a | absent from LCOV |
| 2 | medium | other | `src/commands/plugins/tmux/impl.ts` | 605 | 5.2% | 0.0% | partial coverage |
| 3 | low | vendor plugins | `src/vendor/mpr-plugins/team/team-charter.ts` | 482 | 0.0% | n/a | absent from LCOV |
| 4 | medium | other | `src/commands/plugins/team/index.ts` | 477 | 0.0% | n/a | absent from LCOV |
| 5 | low | vendor plugins | `src/vendor/mpr-plugins/messages/index.ts` | 398 | 0.0% | n/a | absent from LCOV |
| 6 | low | vendor plugins | `src/vendor/mpr-plugins/cleanup/internal/prune-stale-oracles.ts` | 366 | 0.0% | n/a | absent from LCOV |
| 7 | low | vendor plugins | `src/vendor/mpr-plugins/doctor/impl.ts` | 332 | 0.0% | n/a | absent from LCOV |
| 8 | low | vendor plugins | `src/vendor/mpr-plugins/team/index.ts` | 316 | 0.0% | n/a | absent from LCOV |
| 9 | low | vendor plugins | `src/vendor/mpr-plugins/bg/src/impl.ts` | 297 | 0.0% | n/a | absent from LCOV |
| 10 | medium | other | `src/commands/plugins/tile/impl.ts` | 283 | 0.0% | n/a | absent from LCOV |
| 11 | medium | other | `src/commands/plugins/plugin/install-handlers.ts` | 280 | 24.9% | 18.8% | partial coverage |
| 12 | low | vendor plugins | `src/vendor/mpr-plugins/view/impl.ts` | 269 | 0.0% | n/a | absent from LCOV |
| 13 | low | vendor plugins | `src/vendor/mpr-plugins/init/internal/plugin-lock.ts` | 251 | 0.0% | n/a | absent from LCOV |
| 14 | low | vendor plugins | `src/vendor/mpr-plugins/peers/index.ts` | 250 | 0.0% | n/a | absent from LCOV |
| 15 | medium | other | `src/commands/plugins/plugin/index.ts` | 246 | 0.0% | n/a | absent from LCOV |
| 16 | medium | other | `src/commands/plugins/oracle/index.ts` | 243 | 0.0% | n/a | absent from LCOV |
| 17 | low | vendor plugins | `src/vendor/mpr-plugins/inbox/impl.ts` | 243 | 0.0% | n/a | absent from LCOV |
| 18 | medium | other | `src/commands/plugins/oracle/impl-list.ts` | 241 | 2.8% | 0.0% | partial coverage |
| 19 | medium | other | `src/commands/plugins/team/team-lifecycle.ts` | 234 | 0.0% | n/a | absent from LCOV |
| 20 | medium | other | `src/core/server.ts` | 224 | 0.0% | n/a | absent from LCOV |

## Critical files at or above the 80% line target

| Module | File | Line coverage | Function coverage |
| --- | --- | ---: | ---: |
| cli/dispatch | `src/cli/cmd-update.ts` | 83.6% | 100.0% |
| cli/dispatch | `src/cli/cmd-version.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-match.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-types.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-wasm.ts` | 87.1% | 50.0% |
| cli/dispatch | `src/cli/command-registry.ts` | 96.7% | 100.0% |
| cli/dispatch | `src/cli/dispatch-match.ts` | 91.7% | 90.0% |
| cli/dispatch | `src/cli/parse-args.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/usage.ts` | 89.6% | 92.9% |
| cli/dispatch | `src/cli/verbosity.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/comm-list.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/comm-peek.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/comm-send.ts` | 93.3% | 97.2% |
| cli/dispatch | `src/commands/shared/comm.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/done.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-apply.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-diff.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-identity.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-sync-cli.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-sync.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-checks-repo.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-checks.ts` | 97.5% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-fixer.ts` | 87.3% | 40.0% |
| cli/dispatch | `src/commands/shared/fleet-manage.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-resume.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-wake-failsoft.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-as.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-rust.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-scaffold.ts` | 82.7% | 75.0% |
| cli/dispatch | `src/commands/shared/plugin-create.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugins-ls-info.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugins-ui.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/preflight.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/pulse-cmd.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/pulse-thread.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/queue-store.ts` | 98.2% | 100.0% |
| cli/dispatch | `src/commands/shared/receiver-inbox.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/target-cwd.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-cmd.ts` | 84.1% | 85.2% |
| cli/dispatch | `src/commands/shared/wake-maybe-split.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-resolve-impl.ts` | 99.6% | 97.6% |
| cli/dispatch | `src/commands/shared/wake-resolve.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-target.ts` | 80.0% | 80.0% |
| cli/dispatch | `src/commands/shared/wake.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace-agents.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace-lifecycle.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace-query.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/leaf.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/oracle-registry.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/registry-oracle-scan-local.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/registry-oracle-types.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/snapshot.ts` | 93.4% | 100.0% |
| fleet | `src/core/fleet/validate.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/worktree-window-match.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/worktrees-scan.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/worktrees.ts` | 100.0% | 100.0% |
| matcher | `src/core/matcher/normalize-target.ts` | 100.0% | 100.0% |
| matcher | `src/core/matcher/resolve-target.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/default-active.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/dependencies.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/lifecycle.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-constants.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-load.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-parse.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-validate.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/registry-invoke.ts` | 93.5% | 66.7% |
| plugin dispatch | `src/plugin/registry-semver.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/registry.ts` | 99.1% | 100.0% |
| plugin dispatch | `src/plugin/tier.ts` | 100.0% | 100.0% |
| routing/aliases | `src/cli/route-tools.ts` | 100.0% | 100.0% |
| routing/aliases | `src/cli/top-aliases.ts` | 100.0% | 100.0% |
| routing/aliases | `src/core/routing.ts` | 89.1% | 91.7% |
| transport | `src/core/transport/peers.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/pty.ts` | 100.0% | 89.5% |
| transport | `src/core/transport/ssh.ts` | 100.0% | 90.9% |
| transport | `src/core/transport/tmux-class.ts` | 90.3% | 97.5% |
| transport | `src/core/transport/tmux-types.ts` | 80.0% | 66.7% |
| transport | `src/core/transport/tmux.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/transport.ts` | 100.0% | 96.4% |
| transport | `src/transports/http.ts` | 100.0% | 100.0% |
| transport | `src/transports/hub-config.ts` | 90.0% | 100.0% |
| transport | `src/transports/hub-connection.ts` | 100.0% | 93.8% |
| transport | `src/transports/hub-transport.ts` | 99.2% | 92.0% |
| transport | `src/transports/hub.ts` | 100.0% | 100.0% |
| transport | `src/transports/lora.ts` | 100.0% | 90.9% |
| transport | `src/transports/mdns.ts` | 100.0% | 100.0% |
| transport | `src/transports/nanoclaw.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-pair-proof.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-protocol.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-state.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout.ts` | 100.0% | 100.0% |
| transport | `src/transports/tmux.ts` | 100.0% | 100.0% |
| transport | `src/transports/zenoh-scout.ts` | 100.0% | 100.0% |
| transport | `src/transports/zenoh.ts` | 100.0% | 100.0% |

## Critical files below the 80% line target (next queue)

| Module | File | Uncovered | Line coverage |
| --- | --- | ---: | ---: |
| cli/dispatch | `src/commands/shared/fleet-wake.ts` | 146 | 0.0% |
| cli/dispatch | `src/cli/dispatch.ts` | 97 | 46.4% |
| fleet | `src/core/fleet/registry-oracle-scan-remote.ts` | 93 | 6.1% |
| cli/dispatch | `src/commands/shared/fleet-doctor.ts` | 92 | 12.4% |
| fleet | `src/core/fleet/worktrees-cleanup.ts` | 88 | 7.4% |
| plugin dispatch | `src/plugin/types.ts` | 86 | 0.0% |
| cli/dispatch | `src/commands/shared/wake-session.ts` | 82 | 6.8% |
| transport | `src/transports/scout-pair.ts` | 80 | 9.1% |
| transport | `src/transports/index.ts` | 78 | 29.7% |
| cli/dispatch | `src/commands/shared/artifacts.ts` | 72 | 1.4% |

## Critical gaps to prioritize

No critical files appeared in the top 20 uncovered files.

## Prioritization guidance

- High-signal gaps likely to catch real bugs: wake/bring dispatch (`wake-cmd.ts`, `wake-resolve-impl.ts`), message delivery/routing (`comm-send.ts`, `routing.ts`), tmux transport primitives (`tmux-class.ts`), peer discovery transports (`scout.ts`, `mdns.ts`), plugin invocation (`registry-invoke.ts`), and worktree/fleet scans (`worktrees-scan.ts`).
- Lower-signal/ceremony gaps: large vendored MPR plugin implementations, UI/cosmetic renderers, and plugin bodies where behavior is better covered by CLI smoke tests or end-to-end plugin tests.
- Portable-core candidates for #1612 fixture extraction: matcher, routing alias guards, calver, plugin tier/default-active policy, and pure transport-router selection/failover.

## Notes

- Critical = routing/aliases, CLI dispatch, transports, fleet, matcher, and plugin dispatch.
- Low-risk = vendor plugin surfaces and UI/cosmetic code where smoke/manual tests often provide better value than line-driven unit tests.
- Files absent from LCOV are counted as zero-covered using non-empty/non-comment source lines so the report exposes untouched modules, not only imported files.
