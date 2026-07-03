import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "watch",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Activity worklog — serve hook (HTTP routes) + `runWorklog` module for `maw company worklog`. NOT a top-level command (cli-reorg kobo-26).",
  "author": "kobo:core",
  "module": {
    "path": "./index.ts",
    "exports": ["runWorklog"],
  },
  "hooks": {
    "serve": {
      "script": "./serve.ts",
      "handler": "serve",
      "ensures": ["http:route:/api/worklog", "http:route:/api/worklog/feed", "http:route:/api/tasks", "http:route:/api/tasks/archive", "http:route:/api/tasks/note", "http:route:/api/tasks/create", "http:route:/api/tasks/done", "http:route:/api/state", "http:route:/api/roster", "http:route:/api/policy"],
      "policy": "best-effort"
    }
  },
  "weight": 10,
  "license": "MIT",
  "schemaVersion": 1
} as const);
