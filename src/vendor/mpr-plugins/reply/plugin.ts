import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "reply",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Reply to a request-reply message via correlationId.",
  "author": "meganechan",
  "cli": {
    "command": "reply",
    "aliases": [
      "rp"
    ],
    "help": "maw reply <correlationId> <message> — reply to a pending request\nmaw reply --list [oracle] — list pending requests awaiting reply",
    "flags": {
      "--list": "boolean"
    }
  },
  "weight": 30,
  "license": "MIT",
  "schemaVersion": 1,
  "tier": "standard"
} as const);
