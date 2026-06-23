import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "watch",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Activity worklog — desync-killer timeline (tool-calls + PR status).",
  "author": "kobo:core",
  "cli": {
    "command": "watch",
    "help": "maw watch <log|inject|claim|release|sync|setup-hooks> [opts]"
  },
  "hooks": {
    "serve": {
      "script": "./serve.ts",
      "handler": "serve",
      "ensures": ["http:route:/api/worklog"],
      "policy": "best-effort"
    }
  },
  "weight": 10,
  "license": "MIT",
  "schemaVersion": 1
} as const);
