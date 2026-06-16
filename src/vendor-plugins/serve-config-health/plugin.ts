import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "serve-config-health",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "tier": "core",
  "description": "Registers maw serve config, health, and agent status API routes.",
  "author": "Soul-Brews-Studio",
  "hooks": {
    "serve": {
      "script": "./index.ts",
      "handler": "serve",
      "ensures": [
        "http:route:/api/config",
        "http:route:/api/config/reload",
        "http:route:/api/health",
        "http:route:/health",
        "http:route:/api/status"
      ],
      "policy": "fail-fast"
    }
  },
  "capabilities": [
    "serve:http-route",
    "config:read",
    "config:write",
    "health:read",
    "status:read",
    "status:write"
  ],
  "capabilityNamespaces": [
    "serve",
    "config",
    "health",
    "status"
  ],
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
