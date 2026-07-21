import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "head",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Deterministic idempotent head-cell spawn (kobo-364). Module surface — `runHead` is invoked by `maw company head`; NOT a top-level command.",
  "author": "meganechan:patchwork",
  "module": {
    "path": "./index.ts",
    "exports": ["runHead"],
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
