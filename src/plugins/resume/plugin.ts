import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "resume",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Resume a parked agent.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "resume",
    "aliases": [
      "unpause"
    ],
    "help": "maw resume <agent> — resume a parked agent"
  },
  "weight": 50,
  "license": "MIT",
  "schemaVersion": 1
} as const);
