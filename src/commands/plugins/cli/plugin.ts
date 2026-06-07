import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "cli",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Print ready-to-paste Claude CLI invocations for oracle contexts.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "cli",
    "help": "maw cli <oracle|session[:window]> [--json]",
    "flags": {
      "--json": "boolean"
    }
  },
  "weight": 10,
  "tier": "standard"
} as const);
