/**
 * Registry source resolution (#515).
 *
 * Translates a registry entry's `source` field into a concrete tarball URL
 * that `installFromUrl` / `installFromTarball` can consume.
 *
 * Supported source forms:
 *   • npm:NAME                   → https://registry.npmjs.org/NAME/-/<basename>-<version>.tgz
 *   • github:OWNER/REPO#REF      → https://github.com/OWNER/REPO/archive/refs/tags/REF.tar.gz
 *   • https://URL.tgz (or .tar.gz) → pass-through
 *
 * Returns null when the plugin isn't in the registry — callers should suggest
 * `maw plugin install <url>` directly.
 */

import type { RegistryManifest } from "./registry-fetch";

export type SourceKind = "npm" | "github" | "https";

export interface ResolvedSource {
  kind: SourceKind;
  source: string;
  sha256: string | null;
  version: string;
}

export interface NpmRef {
  pkg: string;
  basename: string;
}

/** Parse `npm:@scope/name` or `npm:name` → { pkg, basename }. */
export function parseNpmRef(raw: string): NpmRef | null {
  const m = /^npm:(.+)$/.exec(raw);
  if (!m) return null;
  const pkg = m[1].trim();
  if (!pkg) return null;
  const basename = pkg.startsWith("@") ? pkg.split("/")[1] ?? "" : pkg;
  if (!basename) return null;
  return { pkg, basename };
}

export interface GithubRef {
  owner: string;
  repo: string;
  ref: string;
}

/** Parse `github:OWNER/REPO#REF` → { owner, repo, ref }. */
export function parseGithubRef(raw: string): GithubRef | null {
  const m = /^github:([^/]+)\/([^#]+)#(.+)$/.exec(raw);
  if (!m) return null;
  const [, owner, repo, ref] = m;
  if (!owner || !repo || !ref) return null;
  return { owner, repo, ref };
}

export function npmTarballUrl(ref: NpmRef, version: string): string {
  return `https://registry.npmjs.org/${ref.pkg}/-/${ref.basename}-${version}.tgz`;
}

export function githubTarballUrl(ref: GithubRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/archive/refs/tags/${ref.ref}.tar.gz`;
}

/**
 * Look up `name` in the registry and translate its source field into a
 * fetchable tarball URL. Returns null if `name` is not in the registry.
 */
export function resolvePluginSource(
  name: string,
  registry: RegistryManifest,
): ResolvedSource | null {
  const entry = registry.plugins[name];
  if (!entry) return null;

  const raw = entry.source;
  const common = { sha256: entry.sha256, version: entry.version };

  const npm = parseNpmRef(raw);
  if (npm) return { kind: "npm", source: npmTarballUrl(npm, entry.version), ...common };

  const gh = parseGithubRef(raw);
  if (gh) return { kind: "github", source: githubTarballUrl(gh), ...common };

  if (/^https?:\/\/.+\.(tgz|tar\.gz)(\?.*)?$/i.test(raw)) {
    return { kind: "https", source: raw, ...common };
  }

  throw new Error(`registry entry '${name}' has unrecognized source: ${JSON.stringify(raw)}`);
}
