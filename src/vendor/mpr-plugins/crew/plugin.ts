import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "crew",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Deterministic idempotent crew-cell spawn (kobo-358). Module surface — `runCrew` is invoked by `maw company crew`; NOT a top-level command.",
  "author": "meganechan:patchwork",
  "module": {
    "path": "./index.ts",
    "exports": ["runCrew"],
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
