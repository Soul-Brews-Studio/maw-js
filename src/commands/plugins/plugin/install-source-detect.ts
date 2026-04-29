/**
 * install-impl seam: install root + source-type detection.
 */

import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { basename } from "path";
import { lstatSync, rmSync, unlinkSync } from "fs";

/**
 * ~/.maw/plugins — resolved at call time. Honors `MAW_PLUGINS_DIR` override
 * for tests (and for advanced users who want a non-default install root).
 */
export function installRoot(): string {
  return process.env.MAW_PLUGINS_DIR || join(homedir(), ".maw", "plugins");
}

export type Mode =
  | { kind: "dir"; src: string }
  | { kind: "tarball"; src: string }
  | { kind: "url"; src: string }
  | { kind: "peer"; src: string; name: string; peer: string }
  | { kind: "monorepo"; src: string; subpath: string; tag: string };

const PEER_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PEER_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `monorepo:<subpath>@<tag>` source format (maw-plugin-registry#2).
 *
 * Refers to a plugin subdir inside the maw-plugin-registry monorepo, pinned
 * by tag. Resolution downloads `<base>/<repo>/archive/refs/tags/<tag>.tar.gz`,
 * walks into the github wrapper (`<repo>-<tag>/`), then descends into the
 * declared subpath (typically `plugins/<name>/`) to reach the plugin root.
 *
 * Example: `monorepo:plugins/shellenv@v0.1.2-shellenv`
 *   → subpath: "plugins/shellenv", tag: "v0.1.2-shellenv"
 *
 * Subpath rules: must be relative (no leading `/`), must not contain `..`
 * segments, must be non-empty. Tag must be non-empty.
 */
export interface MonorepoRef {
  subpath: string;
  tag: string;
}

export function parseMonorepoRef(raw: string): MonorepoRef | null {
  if (!raw.startsWith("monorepo:")) return null;
  const rest = raw.slice("monorepo:".length);
  const at = rest.lastIndexOf("@");
  if (at < 0) return null;
  const subpath = rest.slice(0, at).trim();
  const tag = rest.slice(at + 1).trim();
  if (!subpath || !tag) return null;
  if (subpath.startsWith("/")) return null;
  if (subpath.split("/").includes("..")) return null;
  return { subpath, tag };
}

/**
 * Detect `<name>@<peer>` syntax (Task #1, docs §2). Only triggers when the
 * string is unambiguous — explicit paths / URLs / tarballs keep their
 * existing behaviour.
 */
export function parsePeerSpec(src: string): { name: string; peer: string } | null {
  if (/^https?:\/\//i.test(src)) return null;
  if (src.startsWith("/") || src.startsWith("./") || src.startsWith("../")) return null;
  if (src.endsWith(".tgz") || src.endsWith(".tar.gz")) return null;
  const at = src.indexOf("@");
  if (at < 0) return null;
  if (src.indexOf("@", at + 1) >= 0) return null; // second @ — ambiguous
  const name = src.slice(0, at);
  const peer = src.slice(at + 1);
  if (!PEER_NAME_RE.test(name)) return null;
  if (!PEER_HOST_RE.test(peer)) return null;
  return { name, peer };
}

export function detectMode(src: string): Mode {
  if (/^https?:\/\//i.test(src)) return { kind: "url", src };
  if (src.endsWith(".tgz") || src.endsWith(".tar.gz")) {
    return { kind: "tarball", src: resolve(src) };
  }
  const monoRef = parseMonorepoRef(src);
  if (monoRef) return { kind: "monorepo", src, subpath: monoRef.subpath, tag: monoRef.tag };
  const peerSpec = parsePeerSpec(src);
  if (peerSpec) return { kind: "peer", src, name: peerSpec.name, peer: peerSpec.peer };
  return { kind: "dir", src: resolve(src) };
}

/** Ensure ~/.maw/plugins exists. */
export function ensureInstallRoot(): void {
  const root = installRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

/** Remove an existing install (symlink or real dir). */
export function removeExisting(dest: string): void {
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink() || st.isFile()) unlinkSync(dest);
    else if (st.isDirectory()) rmSync(dest, { recursive: true, force: true });
  } catch {
    // ENOENT (no existing install) — nothing to remove. Other errors will
    // surface on the rename below if they matter.
  }
}
