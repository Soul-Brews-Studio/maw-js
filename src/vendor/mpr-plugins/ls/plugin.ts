import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "ls",
  "version": "1.1.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "List live sessions locally by default; use --federation for peers.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "ls",
    "aliases": [
      "list"
    ],
    "help": "maw ls [filter] [--all] [--json] [--fix] [--fleet-only] [--no-teams] [--recent|-r [N]] [--active [30m|1h]] [--federation [peer]] — list local live sessions and L2 teams by default; use --fleet-only for the legacy fleet filter; use --no-teams for tmux-only output; use --federation for peers; see maw fleet ls for registered fleet config",
    "flags": {
      "--all": "boolean",
      "--json": "boolean",
      "--fix": "boolean",
      "--recent": "boolean",
      "-r": "boolean",
      "--active": "boolean",
      "--node": "string",
      "--fleet-only": "boolean",
      "--no-teams": "boolean",
      "--verify": "boolean",
      "--federation": "boolean"
    }
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1,
  "api": {
    "path": "/api/ls",
    "methods": [
      "GET"
    ]
  },
  "capabilityNamespaces": [
    "ls",
    "federation",
    "sessions"
  ]
} as const);
