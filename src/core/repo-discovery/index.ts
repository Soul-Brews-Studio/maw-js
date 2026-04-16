/**
 * RepoDiscovery singleton + backward-compat shim.
 *
 * Selection: `MAW_REPO_DISCOVERY` env var picks the adapter.
 *   - "ghq" (default): GhqDiscovery — inherits ghq's 9 VCSes
 *   - future: "fs-scan" (plain filesystem walk), "jj", "manifest", ...
 *
 * Tests may inject a mock via `setRepos(mock)` and clean up with `resetRepos()`.
 *
 * The `ghqList` / `ghqFind` re-exports preserve the legacy API used at:
 *   - src/commands/plugins/soul-sync/resolve.ts
 *   - src/commands/plugins/oracle/impl-helpers.ts
 *   - src/commands/plugins/workon/impl.ts
 *   - src/commands/plugins/fleet/fleet-init-scan.ts
 * New code should prefer `getRepos().findBySuffix(...)` directly.
 */

import { GhqDiscovery } from "./ghq-discovery";
import type { RepoDiscovery } from "./types";

export type { RepoDiscovery } from "./types";
export { GhqDiscovery } from "./ghq-discovery";

let _instance: RepoDiscovery | null = null;

export function getRepos(): RepoDiscovery {
  if (_instance) return _instance;
  const kind = process.env.MAW_REPO_DISCOVERY ?? "ghq";
  // Only "ghq" is wired today. Future adapters (fs-scan, jj, ...) land here.
  _instance = kind === "ghq" ? GhqDiscovery : GhqDiscovery;
  return _instance;
}

/** Inject a mock adapter — for tests only. */
export function setRepos(impl: RepoDiscovery): void {
  _instance = impl;
}

/** Clear the cached adapter — for tests only. */
export function resetRepos(): void {
  _instance = null;
}

// ── Backward-compat re-exports ─────────────────────────────────────────
// Keep `ghqList` / `ghqFind` / sync variants working at existing call sites.
export const ghqList = (): Promise<string[]> => getRepos().list();
export const ghqListSync = (): string[] => getRepos().listSync();
export const ghqFind = (suffix: string): Promise<string | null> =>
  getRepos().findBySuffix(suffix);
export const ghqFindSync = (suffix: string): string | null =>
  getRepos().findBySuffixSync(suffix);
