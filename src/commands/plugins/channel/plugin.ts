import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "channel",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Manage Claude Code channels per oracle — add, remove, list, setup.",
  "cli": {
    "command": "channel",
    "help": "maw channel <add|rm|ls|providers|setup|test> [oracle] [plugin]",
    "richHelp": true,
    "flags": {
      "--env": "string",
      "--pass": "string",
      "--dev": "boolean",
      "--json": "boolean",
      "--verbose": "boolean",
      "--repo": "string",
      "--guild": "string",
      "--no-interactive": "boolean",
      "--to-repo": "boolean",
      "--dry-run": "boolean",
      "--remove-global": "boolean"
    }
  },
  "weight": 10,
  "tier": "standard"
} as const);
