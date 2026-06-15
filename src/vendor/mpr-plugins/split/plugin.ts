import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "split",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Split current tmux pane and attach to a session (vesicle beside).",
  "cli": {
    "command": "split",
    "help": "maw split <target> [--pct N] [--horizontal|--right|--vertical|--bottom] [--no-attach]",
    "flags": {
      "--pct": "number",
      "--vertical": "boolean",
      "--bottom": "boolean",
      "--horizontal": "boolean",
      "--right": "boolean",
      "--no-attach": "boolean"
    }
  },
  "api": {
    "path": "/api/split",
    "methods": [
      "POST"
    ]
  },
  "weight": 10,
  "license": "MIT",
  "schemaVersion": 1
} as const);
