import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "serve-engine-health-polling",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "tier": "core",
  "description": "Starts maw serve engine-plugin health polling during serve lifecycle startup.",
  "author": "Soul-Brews-Studio",
  "hooks": {
    "serve": {
      "script": "./index.ts",
      "handler": "serve",
      "ensures": [
        "serve:engine:health-polling"
      ],
      "policy": "fail-fast"
    }
  },
  "module": {
    "path": "./index.ts",
    "exports": [
      "serve",
      "startServeEngineHealthPolling"
    ]
  },
  "capabilities": [
    "serve:engine",
    "engine:health-polling"
  ],
  "capabilityNamespaces": [
    "serve",
    "engine"
  ],
  "weight": 3,
  "license": "MIT",
  "schemaVersion": 1
} as const);
