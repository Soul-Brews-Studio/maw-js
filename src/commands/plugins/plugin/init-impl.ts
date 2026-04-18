/**
 * maw plugin init <name> --ts
 *
 * Scaffolds a 5-file TypeScript plugin at ./<name>/:
 *   plugin.json       — full v1 manifest with blank-but-present placeholders
 *   src/index.ts      — @maw-js/sdk hello-world stub
 *   package.json      — author-side deps (typescript, @maw-js/sdk via workspace)
 *   tsconfig.json     — strict ESM bundler resolution
 *   README.md         — 10-line quickstart
 *
 * Phase A: --ts is the only supported target. "wasm" lands in Phase C.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { parseFlags } from "../../../cli/parse-args";

// Repo root (for resolving the workspace SDK absolute path baked into
// scaffolded package.json). src/commands/plugins/plugin/init-impl.ts → ../../../..
const MAW_DIR = resolve(import.meta.dir, "../../../..");
const SDK_PKG_PATH = join(MAW_DIR, "packages", "sdk");

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export async function cmdPluginInit(args: string[]): Promise<void> {
  const flags = parseFlags(args, { "--ts": Boolean }, 0);
  const name = flags._[0];

  if (!name || name.startsWith("-")) {
    throw new Error("usage: maw plugin init <name> --ts");
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid name "${name}" — use lowercase letters, digits, hyphens (must start with a letter)`,
    );
  }
  if (!flags["--ts"]) {
    throw new Error("usage: maw plugin init <name> --ts  (only --ts is supported in Phase A)");
  }

  const dest = join(process.cwd(), name);
  if (existsSync(dest)) {
    throw new Error(`${dest} already exists`);
  }

  mkdirSync(join(dest, "src"), { recursive: true });

  // 1. plugin.json — full v1 manifest, blank-but-present placeholders
  const manifest = {
    name,
    version: "0.1.0",
    sdk: "^1.0.0",
    target: "js",
    entry: "./src/index.ts",
    artifact: { path: "dist/index.js", sha256: null },
    capabilities: [] as string[],
    description: `${name} — a maw-js plugin`,
    cli: { command: name, help: `Invoke ${name}` },
  };
  writeFileSync(join(dest, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

  // 2. src/index.ts — @maw-js/sdk hello-world stub
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import { maw } from "@maw-js/sdk";
import type { InvokeContext, InvokeResult } from "@maw-js/sdk/plugin";

export default async function (ctx: InvokeContext): Promise<InvokeResult> {
  const id = await maw.identity();
  return { ok: true, output: \`hello from \${id.node}!\` };
}
`,
  );

  // 3. package.json — workspace-linked SDK via file: protocol (absolute path
  // into the maw-js tree). Phase A: bundler inlines this on `maw plugin build`.
  const pkg = {
    name,
    version: "0.1.0",
    type: "module",
    main: "src/index.ts",
    scripts: { build: "maw plugin build" },
    devDependencies: {
      "@maw-js/sdk": `file:${SDK_PKG_PATH}`,
      typescript: "^5.0.0",
    },
  };
  writeFileSync(join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  // 4. tsconfig.json — strict, ESM target, bundler module resolution
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["bun"],
      noEmit: true,
    },
    include: ["src/**/*"],
  };
  writeFileSync(join(dest, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");

  // 5. README.md — 10-line quickstart
  writeFileSync(
    join(dest, "README.md"),
    `# ${name}

A maw-js plugin.

## Build

    bun install
    maw plugin build

## Install

    maw plugin install ./${name}-0.1.0.tgz

## Invoke

    maw ${name}
`,
  );

  console.log(`\x1b[36m⚡\x1b[0m scaffolded \x1b[1m${name}\x1b[0m (ts)`);
  console.log(`  next: cd ${name} && bun install && maw plugin build`);
}
