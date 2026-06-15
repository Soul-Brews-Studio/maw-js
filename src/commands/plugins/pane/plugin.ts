import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "pane",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Swap panes in the current tmux window; use panes to list metadata or tile to arrange grids.",
  "cli": {
    "command": "pane",
    "help": "maw pane swap <a> <b> — swap panes in the current tmux window; see maw panes to list and maw tile for grids"
  },
  "weight": 5
} as const);
