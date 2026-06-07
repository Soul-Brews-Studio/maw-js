import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "serve-maintenance",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "tier": "core",
  "description": "Starts maw serve PTY sweep and memory-pruning maintenance timers.",
  "author": "Soul-Brews-Studio",
  "hooks": {
    "serve": {
      "script": "./index.ts",
      "handler": "serve",
      "ensures": [
        "serve:timer:pty-sweep",
        "serve:timer:memory-maintenance"
      ],
      "policy": "fail-fast"
    }
  },
  "module": {
    "path": "./index.ts",
    "exports": [
      "serve",
      "startServeMaintenance",
      "startServePtySweep",
      "startServeMemoryMaintenance"
    ]
  },
  "capabilities": [
    "serve:timer",
    "pty:sweep",
    "queue:prune",
    "status:prune"
  ],
  "capabilityNamespaces": [
    "serve",
    "pty",
    "queue",
    "status"
  ],
  "weight": 90,
  "license": "MIT",
  "schemaVersion": 1
} as const);
