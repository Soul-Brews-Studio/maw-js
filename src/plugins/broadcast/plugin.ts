import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "broadcast",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Broadcast a message to all agents.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "broadcast",
    "aliases": [
      "shout"
    ],
    "help": "maw broadcast <message> — broadcast a message to all agents"
  },
  "weight": 50,
  "license": "MIT",
  "schemaVersion": 1
} as const);
