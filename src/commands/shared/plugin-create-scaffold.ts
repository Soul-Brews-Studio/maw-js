import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// maw-js repo root — used only to locate scaffold templates on this machine.
const MAW_DIR = resolve(import.meta.dir, "../..");
export const TEMPLATE_RUST = join(MAW_DIR, "src/wasm/examples/hello-rust");
export const TEMPLATE_AS = join(MAW_DIR, "src/wasm/examples/hello-as");

/**
 * Portable Rust SDK path for scaffolded Cargo.toml.
 *
 * The absolute path we used to bake in (`<MAW_DIR>/src/wasm/maw-plugin-sdk`)
 * was the scaffolder's own filesystem — plugins stopped building the moment
 * they left that machine.
 *
 * Resolution order:
 *   1. `MAW_SDK_RUST_PATH` env var (explicit override, dev or CI)
 *   2. The standard global bun install location (portable across users
 *      who `bun add -g github:Soul-Brews-Studio/maw-js`)
 *   3. The local dev-tree path (last resort; scaffolds a plugin that
 *      only builds on this machine — we warn on stderr in that case).
 */
export function defaultRustSdkPath(): string {
  if (process.env.MAW_SDK_RUST_PATH) return process.env.MAW_SDK_RUST_PATH;
  const bunGlobal = join(
    homedir(),
    ".bun", "install", "global", "node_modules",
    "maw", "src", "wasm", "maw-plugin-sdk",
  );
  if (existsSync(bunGlobal)) return bunGlobal;
  // Fall back to dev-tree path. Not portable — warn the caller.
  return join(MAW_DIR, "src/wasm/maw-plugin-sdk");
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function validatePluginName(name: string): string | null {
  if (!name) return "name is required";
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    return `"${name}" is invalid — use lowercase letters, digits, - or _ (must start with a letter)`;
  }
  return null;
}

// ─── Tree copy (skips build artifacts) ──────────────────────────────────────

const SKIP = new Set(["target", ".git", "node_modules"]);

export function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (SKIP.has(entry)) continue;
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) {
      copyTree(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

// ─── Manifest ────────────────────────────────────────────────────────────────

/**
 * Build plugin.json content for a scaffolded plugin.
 * `name` field is slugified (underscores → hyphens) to match /^[a-z0-9-]+$/.
 * Returns a JSON string ready to write to disk.
 */
export function buildManifestJson(name: string, lang: "rust" | "as"): string {
  const slug = name.replace(/_/g, "-");
  const wasmPath =
    lang === "rust"
      ? `./target/wasm32-unknown-unknown/release/${name.replace(/-/g, "_")}.wasm`
      : "./build/release.wasm";
  const type = lang === "rust" ? "Rust" : "AssemblyScript";
  const manifest = {
    name: slug,
    version: "0.1.0",
    wasm: wasmPath,
    sdk: "^1.0.0",
    description: `${type} plugin: ${name}`,
    author: "",
    cli: { command: slug, help: `Invoke ${name}` },
    api: { path: `/api/plugins/${slug}`, methods: ["GET", "POST"] },
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}
