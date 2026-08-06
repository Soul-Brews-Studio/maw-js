import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "overview",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Show fleet overview / war room dashboard.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "overview",
    "aliases": [
      "warroom",
      "ov"
    ],
    "help": "maw overview [args] — show fleet overview / war room dashboard"
  },
  "weight": 10,
  "license": "MIT",
  "schemaVersion": 1
} as const);
