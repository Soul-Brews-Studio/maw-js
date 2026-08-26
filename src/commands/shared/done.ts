/**
 * `maw done` lifecycle — re-export shim.
 *
 * The canonical implementation lives in the vendor done plugin
 * (`src/vendor/mpr-plugins/done/`), which is the live `maw done` CLI path and
 * carries the fixes + features (engine-aware retro, cmdDoneAll, team-charter
 * lead resolution, reunion/soul-sync, orphan archiving, --keep-branch). This
 * module preserves the stable `commands/shared/done` import path for the team
 * lifecycle (team-reassign / team-remove) and the DI test suites, so there is a
 * single source of truth for the done lifecycle.
 */
export {
  cmdDone,
  cmdDoneAll,
  type DoneOpts,
  type DoneAllSummary,
} from "../../vendor/mpr-plugins/done/impl";

export {
  autoSave,
  signalParentInbox,
} from "../../vendor/mpr-plugins/done/done-autosave";

export {
  cleanupDoneBranch,
  removeWorktreeViaConfig,
  removeWorktreeByGhqScan,
  warnRemainingWorktrees,
  removeFromFleetConfig,
} from "../../vendor/mpr-plugins/done/done-worktree";

export {
  type DoneDeps,
  type SessionInfo,
} from "../../vendor/mpr-plugins/done/done-deps";
