# Coverage gap analysis

Generated: 2026-05-20T10:49:08.437Z

Input: `coverage/lcov.info`

Coverage scope: source-line-normalized Bun LCOV plus zero-coverage accounting for tracked `src/**/*.ts` files absent from LCOV.
Excluded from Bun LCOV accounting: non-Bun-runtime AssemblyScript sources compiled to WebAssembly and covered by AssemblyScript harness tests instead of Bun line instrumentation.

Overall line coverage: **100.0%** (31620/31621)
Overall function coverage: **100.0%** (5370/5370)

## Module summary

| Module | Files | Missing from LCOV | Lines | Functions | Branches |
| --- | ---: | ---: | ---: | ---: | ---: |
| cli/dispatch | 95 | 0 | 100.0% (5857/5858) | 100.0% (938/938) | n/a (0/0) |
| config/runtime | 19 | 0 | 100.0% (780/780) | 100.0% (135/135) | n/a (0/0) |
| fleet | 19 | 0 | 100.0% (680/680) | 100.0% (108/108) | n/a (0/0) |
| matcher | 3 | 0 | 100.0% (73/73) | 100.0% (18/18) | n/a (0/0) |
| other | 175 | 5 | 100.0% (8925/8925) | 100.0% (1567/1567) | n/a (0/0) |
| plugin dispatch | 15 | 1 | 100.0% (705/705) | 100.0% (91/91) | n/a (0/0) |
| routing/aliases | 4 | 0 | 100.0% (431/431) | 100.0% (76/76) | n/a (0/0) |
| transport | 28 | 0 | 100.0% (1698/1698) | 100.0% (454/454) | n/a (0/0) |
| vendor plugins | 247 | 2 | 100.0% (12471/12471) | 100.0% (1983/1983) | n/a (0/0) |

## Source handled outside Bun LCOV

| Source root | Files | Source lines | Reason |
| --- | ---: | ---: | --- |
| `src/wasm/examples/hello-as/assembly/` | 2 | 15 | AssemblyScript example source is compiled with asc to WebAssembly as a plugin template; Bun LCOV cannot map wasm execution back to these TypeScript-like sources. |
| `src/wasm/examples/hello-package/assembly/` | 2 | 31 | AssemblyScript packaged example source is compiled with asc to WebAssembly as a plugin template; Bun LCOV cannot map wasm execution back to these TypeScript-like sources. |
| `src/wasm/maw-plugin-sdk-assemblyscript/assembly/` | 5 | 187 | AssemblyScript SDK source is compiled with asc to WebAssembly; Bun LCOV cannot map wasm execution back to these TypeScript-like sources. |

## Top 20 uncovered files by executable/source line count

| Rank | Risk | Module | File | Uncovered | Line coverage | Function coverage | Note |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 1 | critical | cli/dispatch | `src/commands/shared/federation-sync-cli.ts` | 1 | 98.9% | 100.0% | partial coverage |

## Critical files at or above the 80% line target

| Module | File | Line coverage | Function coverage |
| --- | --- | ---: | ---: |
| cli/dispatch | `src/cli/auto-restore.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/cmd-new.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/cmd-update.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/cmd-version.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-execute.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-match.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-types.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry-wasm.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/command-registry.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/dispatch-match.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/dispatch.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/error-handler.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/instance-pid.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/instance-preset.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/parse-args.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/plugin-bootstrap.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/update-lock.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/usage.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/verbosity.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/cli/wasm-bridge.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/agents.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/artifacts.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/audit.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/bring-flags.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/comm-list.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/comm-log-feed.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/comm-peek.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/comm-send.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/comm.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/context-limit.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/discover-live-state.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/done.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-apply.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-diff.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-fetch.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-identity.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-sync-cli.ts` | 98.9% | 100.0% |
| cli/dispatch | `src/commands/shared/federation-sync.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/federation.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-checks-repo.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-checks.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-fixer.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-reboot.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor-stale-peers.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-doctor.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-load.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-manage.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-resume.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-sync.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-validate.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-wake-failsoft.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet-wake.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/fleet.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/pane-target-resolver.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/peer-sources.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-as.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-cmd.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-rust.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create-scaffold.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugin-create.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugins-install.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugins-ls-info.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugins-profile.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugins-toggle.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugins-ui.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/plugins.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/preflight.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/pulse-cmd.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/pulse-thread.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/pulse.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/queue-store.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/receiver-inbox.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/scan-signals.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/scope-acl.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/should-auto-wake.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/target-cwd.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/transport.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/triggers.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-cmd-helpers.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-cmd.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-concurrency.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-maybe-split.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-pane-size.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-resolve-github.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-resolve-impl.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-resolve-scan-suggest.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-resolve.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-session.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake-target.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/wake.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace-agents.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace-lifecycle.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace-query.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace-store.ts` | 100.0% | 100.0% |
| cli/dispatch | `src/commands/shared/workspace.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/audit.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/claude-sessions.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/leaf.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/nicknames.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/node-identity.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/oracle-registry.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/registry-oracle-cache.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/registry-oracle-orchestrate.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/registry-oracle-scan-local.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/registry-oracle-scan-remote.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/registry-oracle-types.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/session-name.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/snapshot.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/tab-order.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/validate.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/worktree-window-match.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/worktrees-cleanup.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/worktrees-scan.ts` | 100.0% | 100.0% |
| fleet | `src/core/fleet/worktrees.ts` | 100.0% | 100.0% |
| matcher | `src/core/matcher/channel-session.ts` | 100.0% | 100.0% |
| matcher | `src/core/matcher/normalize-target.ts` | 100.0% | 100.0% |
| matcher | `src/core/matcher/resolve-target.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/cap-infer-ast.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/default-active.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/dependencies.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/lifecycle.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-constants.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-load.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-parse.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest-validate.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/manifest.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/registry-helpers.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/registry-invoke.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/registry-semver.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/registry.ts` | 100.0% | 100.0% |
| plugin dispatch | `src/plugin/tier.ts` | 100.0% | 100.0% |
| routing/aliases | `src/cli/route-comm.ts` | 100.0% | 100.0% |
| routing/aliases | `src/cli/route-tools.ts` | 100.0% | 100.0% |
| routing/aliases | `src/cli/top-aliases.ts` | 100.0% | 100.0% |
| routing/aliases | `src/core/routing.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/curl-fetch.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/mqtt-publish.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/peers.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/pty.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/ssh.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/tmux-class.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/tmux-pane-lock.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/tmux-pane-tags.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/tmux-types.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/tmux.ts` | 100.0% | 100.0% |
| transport | `src/core/transport/transport.ts` | 100.0% | 100.0% |
| transport | `src/transports/http.ts` | 100.0% | 100.0% |
| transport | `src/transports/hub-config.ts` | 100.0% | 100.0% |
| transport | `src/transports/hub-connection.ts` | 100.0% | 100.0% |
| transport | `src/transports/hub-transport.ts` | 100.0% | 100.0% |
| transport | `src/transports/hub.ts` | 100.0% | 100.0% |
| transport | `src/transports/index.ts` | 100.0% | 100.0% |
| transport | `src/transports/lora.ts` | 100.0% | 100.0% |
| transport | `src/transports/mdns.ts` | 100.0% | 100.0% |
| transport | `src/transports/nanoclaw.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-pair-proof.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-pair.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-protocol.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout-state.ts` | 100.0% | 100.0% |
| transport | `src/transports/scout.ts` | 100.0% | 100.0% |
| transport | `src/transports/tmux.ts` | 100.0% | 100.0% |
| transport | `src/transports/zenoh-scout.ts` | 100.0% | 100.0% |
| transport | `src/transports/zenoh.ts` | 100.0% | 100.0% |

## Critical files below the 80% line target (next queue)

| Module | File | Uncovered | Line coverage |
| --- | --- | ---: | ---: |

## Critical gaps to prioritize

- `src/commands/shared/federation-sync-cli.ts` (cli/dispatch): 1 uncovered lines, 98.9% line coverage.

## Prioritization guidance

- High-signal gaps likely to catch real bugs: wake/bring dispatch (`wake-cmd.ts`, `wake-resolve-impl.ts`), message delivery/routing (`comm-send.ts`, `routing.ts`), tmux transport primitives (`tmux-class.ts`), peer discovery transports (`scout.ts`, `mdns.ts`), plugin invocation (`registry-invoke.ts`), and worktree/fleet scans (`worktrees-scan.ts`).
- Lower-signal/ceremony gaps: large vendored MPR plugin implementations, UI/cosmetic renderers, and plugin bodies where behavior is better covered by CLI smoke tests or end-to-end plugin tests.
- Portable-core candidates for #1612 fixture extraction: matcher, routing alias guards, calver, plugin tier/default-active policy, and pure transport-router selection/failover.

## Notes

- Critical = routing/aliases, CLI dispatch, transports, fleet, matcher, and plugin dispatch.
- Low-risk = vendor plugin surfaces and UI/cosmetic code where smoke/manual tests often provide better value than line-driven unit tests.
- Bun DA entries are source-line-normalized to ignore comments, syntactic separators, type-only declarations, and simple terminal return/throw statements that Bun can leave unmapped even when the branch result is asserted.
- Files absent from LCOV are counted as zero-covered using the same source-line normalization so the report exposes untouched modules, not only imported files.
- AssemblyScript sources under `src/wasm/maw-plugin-sdk-assemblyscript/assembly/` and `src/wasm/examples/*/assembly/` are not counted as zero-covered Bun TypeScript because their runtime is asc-compiled WebAssembly. Keep covering them with AssemblyScript wasm harness tests and compiler checks.
