# artifact-manager

Ship-tier Rust WASM plugin for the `artifact-manager` command and its `art` alias.

## Usage

```bash
maw art ls
maw art ls --team plugin-pkg
maw art get plugin-pkg 2 --json
maw art write my-team 1 "Done!"
maw art attach my-team 1 report.pdf
maw art init my-team 1 "Build X" "Description here"
```

## Build

```bash
maw plugin build packages/50-artifact-manager
```
