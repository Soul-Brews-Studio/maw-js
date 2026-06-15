import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "transport",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Transport layer status and diagnostics",
  "cli": {
    "command": "transport",
    "aliases": [
      "tp"
    ],
    "help": "maw transport [status]"
  },
  "api": {
    "path": "/api/transport/status",
    "methods": [
      "GET"
    ]
  },
  "weight": 10
} as const);
