import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "forget",
  "version": "0.1.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Exhaustively remove stale local oracle runtime state.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "forget",
    "help": "maw forget <oracle> [--dry-run] [--yes|--force] [--json] — preview or remove tmux, fleet, snapshots, and worktrees"
  },
  "weight": 50,
  "license": "MIT",
  "schemaVersion": 1
} as const);
