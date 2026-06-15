import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "mega",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Manage MegaAgent multi-agent teams.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "mega",
    "help": "maw mega [status|stop] — manage MegaAgent multi-agent teams"
  },
  "weight": 10,
  "license": "MIT",
  "schemaVersion": 1
} as const);
