import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "serve-pr-watch",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "tier": "core",
  "description": "Periodically polls open/merged PRs during serve lifecycle so a github web-merge drives card lifecycle without a manual maw command.",
  "author": "Soul-Brews-Studio",
  "hooks": {
    "serve": {
      "script": "./index.ts",
      "handler": "serve",
      "ensures": [
        "serve:pr:watch"
      ],
      "policy": "fail-fast"
    }
  },
  "module": {
    "path": "./index.ts",
    "exports": [
      "serve",
      "startServePrWatch"
    ]
  },
  "capabilities": [
    "serve:worklog",
    "worklog:pr-watch"
  ],
  "capabilityNamespaces": [
    "serve",
    "worklog"
  ],
  "weight": 3,
  "license": "MIT",
  "schemaVersion": 1
} as const);
