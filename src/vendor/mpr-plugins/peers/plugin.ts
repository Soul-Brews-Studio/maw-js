import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "peers",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Manage federation peer aliases (#568).",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "peers",
    "aliases": [
      "peer"
    ],
    "help": "maw peers <add|list|info|remove> [...] — federation peer aliases; add supports --node --ssh --user; list supports --discovered --all --json --limit N",
    "flags": {
      "--discovered": "boolean",
      "--all": "boolean",
      "--json": "boolean",
      "--limit": "number",
      "--node": "string",
      "--ssh": "string",
      "--user": "string",
      "--allow-unreachable": "boolean",
      "--timeout": "number",
      "--alias": "string"
    }
  },
  "weight": 30,
  "tier": "standard",
  "license": "MIT",
  "schemaVersion": 1
} as const);
