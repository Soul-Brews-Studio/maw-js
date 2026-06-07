import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "serve-ws",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "tier": "core",
  "description": "Registers maw serve WebSocket upgrade routes and handlers.",
  "author": "Soul-Brews-Studio",
  "hooks": {
    "serve": {
      "script": "./index.ts",
      "handler": "serve",
      "ensures": [
        "ws:route:/ws",
        "ws:route:/ws/pty"
      ],
      "policy": "fail-fast"
    }
  },
  "module": {
    "path": "./index.ts",
    "exports": [
      "serve",
      "registerServeWsRoutes"
    ]
  },
  "capabilities": [
    "serve:ws-route"
  ],
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1,
  "capabilityNamespaces": [
    "serve"
  ]
} as const);
