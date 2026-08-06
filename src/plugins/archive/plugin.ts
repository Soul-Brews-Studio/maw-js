import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "archive",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Archive an oracle's tmux session and data.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "archive",
    "help": "maw archive <oracle> [--dry-run] — archive an oracle's tmux session and data"
  },
  "weight": 50,
  "license": "MIT",
  "schemaVersion": 1
} as const);
