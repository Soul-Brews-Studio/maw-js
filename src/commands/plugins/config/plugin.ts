import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "config",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Inspect cwd-aware maw config layers and provenance.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "config",
    "help": "maw config <show|sources|explain <key>|set <key> <value>> [--json] — inspect or update merged config and config layer provenance"
  },
  "weight": 10,
  "tier": "standard"
} as const);
