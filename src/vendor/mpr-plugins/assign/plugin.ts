import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "assign",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Assign a GitHub issue to an oracle.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "assign",
    "help": "maw assign <issue-url> [--oracle <name>]",
    "flags": {
      "--oracle": "string"
    }
  },
  "weight": 10,
  "license": "MIT",
  "schemaVersion": 1
} as const);
