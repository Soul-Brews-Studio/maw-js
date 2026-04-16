/**
 * Backward-compat shim. New code should import from "./repo-discovery" directly.
 *
 * This preserves the ghqList/ghqFind/ghqListSync/ghqFindSync API used at:
 *   - src/commands/plugins/soul-sync/resolve.ts
 *   - src/commands/plugins/oracle/impl-helpers.ts
 *   - src/commands/plugins/workon/impl.ts
 *   - src/commands/plugins/fleet/fleet-init-scan.ts
 *
 * The implementation now lives behind the RepoDiscovery adapter seam so
 * future backends (fs-scan, jj, custom) can slot in via MAW_REPO_DISCOVERY.
 */
export { ghqList, ghqListSync, ghqFind, ghqFindSync } from "./repo-discovery";
// Internal — kept for existing test/ghq-helper.test.ts compatibility.
export { _normalize } from "./repo-discovery/ghq-discovery";
