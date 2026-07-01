import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "task",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Company task board backbone (ADR 0001). Module surface — `runTask` is invoked by `maw company task`; NOT a top-level command (cli-reorg kobo-26).",
  "author": "meganechan:patchwork",
  "module": {
    "path": "./index.ts",
    "exports": ["runTask"],
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
