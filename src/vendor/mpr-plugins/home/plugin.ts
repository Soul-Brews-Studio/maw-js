import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "home",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Company Home git repo (ADR 0002). Module surface — `runHome` is invoked by `maw company home`; NOT a top-level command (cli-reorg kobo-26).",
  "author": "meganechan:patchwork",
  "module": {
    "path": "./index.ts",
    "exports": ["runHome"],
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
