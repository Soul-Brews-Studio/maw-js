import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "cleanup",
  "version": "1.1.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Clean zombie agent panes, orphan worktrees, and stale Oracle registry entries.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "cleanup",
    "aliases": [],
    "help": "maw cleanup --zombie-agents [--yes] — kill orphan panes; maw cleanup --worktrees [--yes] [--json] [--repo <name>] [--scope .] — safe-remove orphan worktrees; maw cleanup --prune-stale [--yes|--ask|--dry-run] — prune dead oracles.json entries"
  },
  "weight": 30,
  "license": "MIT",
  "schemaVersion": 1,
  "tier": "standard"
} as const);
