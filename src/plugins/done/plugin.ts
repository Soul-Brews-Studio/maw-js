import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "done",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Finish a worktree session: retrospective/save, kill window, and remove worktree; use sleep/kill for non-worktree shutdown.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "done",
    "aliases": [
      "finish"
    ],
    "help": "maw done <window-name> [--force] [--dry-run] [--clean-branch] | maw done --all [<oracle>] [--force] [--dry-run] [--clean-branch] — finish worktrees; see maw sleep/kill for non-worktree shutdown"
  },
  "api": {
    "path": "/api/done",
    "methods": [
      "POST"
    ]
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
