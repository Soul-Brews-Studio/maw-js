import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "$schema": "https://maw.soulbrews.studio/schema/plugin.json",
  "name": "crew-skills",
  "version": "1.0.0",
  "description": "Distribute the /crew and /warroom team-pane skills (plus the worker Stop hook) as one canonical maw-shipped copy, installed globally into ~/.claude so every oracle gets them without a per-oracle copy.",
  "author": "Soul-Brews-Studio",
  "license": "MIT",
  "homepage": "https://github.com/Soul-Brews-Studio/maw-js",
  "sdk": "^1.0.0",
  "schemaVersion": 1,
  "entry": "./index.ts",
  "cli": {
    "command": "crew-skills",
    "help": "maw crew-skills [sync] [--dry-run] [--force] — install/refresh the global /crew + /warroom skills and worker Stop hook in ~/.claude"
  }
} as const);
