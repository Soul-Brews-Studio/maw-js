# Typed Plugin Output (`--types`)

> Phase B Wave 1C · Issue #340

## Overview

`maw plugin build --types` emits a `dist/<name>.d.ts` file alongside
`dist/index.js`. This gives plugin authors typed autocomplete for their
plugin's exported interfaces, hook registrations, and capability shape
— without changing the SDK's hand-authored contract types in
`@maw-js/sdk/plugin`.

This is **opt-in**. Existing Phase A plugins built without `--types` are
completely unaffected.

## Usage

```bash
maw plugin build --types
# or with an explicit directory
maw plugin build ./my-plugin --types
```

The flag can be combined with `--watch`:

```bash
maw plugin build --watch --types
```

## What gets emitted

Given a plugin with `src/index.ts`:

```typescript
export interface GreeterConfig {
  greeting: string;
  count?: number;
}

export default async function handler(ctx: { args: string[] }) {
  return { ok: true, output: "hello" };
}
```

Running `maw plugin build --types` produces `dist/greeter.d.ts`:

```typescript
export interface GreeterConfig {
    greeting: string;
    count?: number;
}
export default function handler(ctx: {
    args: string[];
}): Promise<{
    ok: boolean;
    output: string;
}>;
```

The file name is always `dist/<pluginName>.d.ts`, derived from the `name`
field in `plugin.json`.

## How it works

Internally, `dts-gen.ts` writes a temporary `tsconfig.emit.json` into
`dist/`, runs `bun x tsc --emitDeclarationOnly`, then removes the
temporary config. The `bun x tsc` invocation uses typescript from your
plugin's `devDependencies` (or the global bun tool cache) — no separate
`tsc` install is required.

```
src/index.ts → [bun x tsc --emitDeclarationOnly] → dist/<name>.d.ts
```

The `tsconfig.emit.json` is ephemeral: it is always removed after the
run, even if tsc exits non-zero.

## SDK types are not affected

The `@maw-js/sdk` hand-authored declarations (`index.d.ts`, `plugin.d.ts`)
are the stable SDK contract and are never modified by `--types`. The
emitted `.d.ts` captures only the exports of the plugin's own source.

## Type-checking your plugin

To type-check before building, add this to your plugin's `tsconfig.json`:

```json
{
  "compilerOptions": {
    "noEmit": true,
    "strict": true,
    "moduleResolution": "bundler"
  }
}
```

Then run:

```bash
bun x tsc --noEmit
```

## Non-breaking note

- Phase A plugins that don't pass `--types` continue to work identically.
- The `.d.ts` is not included in the packed `.tgz` (tarball contains only
  `plugin.json` + `index.js`). The types file is a development artifact
  for the plugin author's workspace — not part of the installed bundle.
