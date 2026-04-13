# artifact-manager

> TS plugin — no WASM, no compilation. Pure TypeScript.

## Install

```bash
maw plugins install ./src/commands/plugins/artifact-manager
```

Or symlink directly:
```bash
ln -s $(pwd)/src/commands/plugins/artifact-manager ~/.oracle/commands/artifact-manager
```

## Usage

```bash
maw art ls                          # list all artifacts
maw art ls plugin-pkg               # filter by team
maw art ls --json                   # machine-readable

maw art get plugin-pkg 2            # show full artifact
maw art get plugin-pkg 2 --json     # JSON output

maw art write my-team 1 "Done!"     # write result.md
maw art attach my-team 1 report.pdf # add attachment
maw art init my-team 1 "Build X" "Description here"  # create manually
```

## Why TS, not WASM?

This plugin needs full access to maw-js internals (`src/lib/artifacts.ts`).
WASM plugins are sandboxed — they can only use host functions (maw_print, maw_identity, etc.).
TS plugins import directly. Different trust levels:

| | TS Plugin | WASM Plugin |
|---|---|---|
| Access | Full maw-js internals | Sandboxed host functions only |
| Build | None — runs as-is | Compile Rust/AS → .wasm |
| Use case | Internal tools | Community/external plugins |

## Plugin manifest

`plugin.json` uses `entry` instead of `wasm`:

```json
{
  "name": "artifact-manager",
  "entry": "./index.ts",
  "cli": { "command": "art" },
  "api": { "path": "/api/plugins/artifact-manager", "methods": ["GET", "POST"] }
}
```
