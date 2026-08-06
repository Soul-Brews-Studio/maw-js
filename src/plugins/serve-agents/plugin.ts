import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "serve-agents",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Registers the maw serve agent listing API routes.",
  "author": "Soul-Brews-Studio",
  "hooks": {
    "serve": {
      "script": "./index.ts",
      "handler": "serve",
      "policy": "fail-fast"
    }
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
