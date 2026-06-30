import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "task",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Company task board backbone — create/claim/done first-class work items (ADR 0001).",
  "author": "meganechan:patchwork",
  "cli": {
    "command": "task",
    "help": "maw task <add|ls|claim|review|done> — add \"<title>\" [--repo r --dept d --epic e --assignee a] · ls [--company c] [--mine] · claim <id> · review <id> [--to oracle --reason text] · done <id>"
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
