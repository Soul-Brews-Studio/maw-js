import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "kill",
  "version": "1.1.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Immediately kill a tmux session, window, or pane; use sleep for graceful single-agent shutdown or done for finished worktrees.",
  "cli": {
    "command": "kill",
    "help": "maw kill <target>[:window] [--pane N] [--index N|--all] [--peer <alias>] — immediate tmux kill; see maw sleep for graceful stop and maw done for worktree cleanup",
    "flags": {
      "--pane": "number",
      "--peer": "string",
      "--index": "number",
      "--all": "boolean"
    }
  },
  "api": {
    "path": "/api/kill",
    "methods": [
      "POST"
    ]
  },
  "weight": 10,
  "tier": "standard",
  "license": "MIT",
  "schemaVersion": 1
} as const);
