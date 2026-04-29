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
  | { kind: "monorepo"; src: string; subpath: string; tag: string }
  | { kind: "github"; src: string; owner: string; repo: string; subpath?: string; ref?: string };

const PEER_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PEER_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Vercel-style GitHub source — `owner/repo[/subpath][@ref]` (#939).
 *
 * Parsed by `parseGithubRef` and dispatched as `{ kind: "github" }`. Resolution
 * (in `installFromGithub`) downloads the github archive of `<owner>/<repo>`
 * pinned by `<ref>` (release tag, branch, or sha) — defaulting to the latest
 * release, with a fallback to the default branch if no releases exist.
 *
 * GitHub is case-insensitive on owner+repo, so we lowercase those at parse
 * time. Subpath and ref preserve case (paths and refs are case-sensitive).
 *
 * Subpath shape: when a single segment (`owner/repo/foo`), the resolver MAY
 * auto-prefix `plugins/` if `plugins/foo/` exists in the extracted repo — the
 * common monorepo convenience case. Multi-segment subpaths are taken literal.
 */
export interface GithubRef {
  owner: string;
  repo: string;
  subpath?: string;
  ref?: string;
}

const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GH_REPO_RE = /^[A-Za-z0-9._-]+$/;

export function parseGithubRef(raw: string): GithubRef | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Whitespace would only have come from operator typo; reject so we don't
  // silently lowercase a path that doesn't normalize.
  if (raw !== raw.trim()) return null;
  // These shapes already have a parser higher up the chain — fail fast so we
  // never claim a tarball/url/path/monorepo string.
  if (/^https?:\/\//i.test(raw)) return null;
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) return null;
  if (raw.endsWith(".tgz") || raw.endsWith(".tar.gz")) return null;
  if (raw.startsWith("monorepo:")) return null;

  // Split off the @ref suffix first — the LAST `@` wins, mirroring monorepo.
  let body = raw;
  let ref: string | undefined;
  const at = raw.lastIndexOf("@");
  if (at >= 0) {
    body = raw.slice(0, at);
    ref = raw.slice(at + 1);
    if (!body || !ref) return null;
    // Refs can be tags/branches/shas — refuse whitespace + control chars only.
    if (/\s/.test(ref)) return null;
  }

  const segs = body.split("/");
  if (segs.length < 2) return null;
  const ownerRaw = segs[0]!;
  const repoRaw = segs[1]!;
  if (!GH_OWNER_RE.test(ownerRaw)) return null;
  if (!GH_REPO_RE.test(repoRaw)) return null;
  // GitHub disallows `.` and `..` as repo names, and trailing `.git` is the
  // clone-URL form, not the slug form — reject so the resolver doesn't
  // build a malformed archive URL.
  if (repoRaw === "." || repoRaw === "..") return null;
  if (repoRaw.endsWith(".git")) return null;

  let subpath: string | undefined;
  if (segs.length > 2) {
    const tail = segs.slice(2).join("/");
    if (!tail) return null;
    if (tail.split("/").includes("..")) return null;
    if (tail.startsWith("/")) return null;
    if (/\s/.test(tail)) return null;
    subpath = tail;
  }

  return {
    owner: ownerRaw.toLowerCase(),
    repo: repoRaw.toLowerCase(),
    ...(subpath ? { subpath } : {}),
    ...(ref ? { ref } : {}),
  };
}

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
  // #939 — Vercel-style `owner/repo[/subpath][@ref]`. Must run AFTER url /
  // tarball / monorepo (they all could superficially contain a `/`) and
  // BEFORE peer (peer requires no `/`, so they don't actually overlap, but
  // ordering documents the precedence).
  const ghRef = parseGithubRef(src);
  if (ghRef) {
    return {
      kind: "github",
      src,
      owner: ghRef.owner,
      repo: ghRef.repo,
      ...(ghRef.subpath ? { subpath: ghRef.subpath } : {}),
      ...(ghRef.ref ? { ref: ghRef.ref } : {}),
    };
  }
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
