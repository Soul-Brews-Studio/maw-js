import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "mcp",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Run the stdio MCP server (register in ~/.claude.json).",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "mcp",
    "help": "maw mcp — run the stdio MCP server (register in ~/.claude.json)"
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
