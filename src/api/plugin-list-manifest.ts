/**
 * Plugin list-manifest endpoint (#631, Shape A).
 *
 * GET /api/plugin/list-manifest → this node's installed plugins, for
 * `maw plugin search --peers` federated discovery. Guarded by the same
 * federationAuth HMAC middleware as every other /api route (mounted in
 * src/api/index.ts).
 *
 * Schema is intentionally a lean subset of RegistryManifest — peer
 * manifests are advisory, never a trust root. `plugins.lock` stays the
 * sha256 trust boundary at install time.
 *
 * See docs/plugins/search-peers-impl.md for the full spec.
 */
import { Elysia } from "elysia";
import type { PluginTier } from "../plugin/types";
import { weightToTier } from "../plugin/tier";
import { discoverPackages } from "../plugin/registry";
import { loadConfig } from "../config";

export interface PeerPluginEntry {
  name: string;
  version: string;
  summary?: string;
  author?: string;
  sha256?: string | null;
  /** Plugin tier — explicit or inferred from weight (#675). */
  tier?: PluginTier;
  /**
   * Relative URL to fetch this plugin's tarball from the peer (Task #1).
   * Additive; clients ignore unknown keys, so no schemaVersion bump needed.
   * Joined against the peer's base URL by the client — keeps the peer from
   * having to know its own externally-reachable hostname.
   */
  downloadUrl?: string;
}

export interface PeerManifestResponse {
  schemaVersion: 1;
  node: string;
  pluginCount: number;
  plugins: PeerPluginEntry[];
}

export const pluginListManifestApi = new Elysia().get(
  "/plugin/list-manifest",
  (): PeerManifestResponse => {
    const plugins: PeerPluginEntry[] = discoverPackages().map(p => {
      const m = p.manifest;
      const entry: PeerPluginEntry = {
        name: m.name,
        version: m.version,
        tier: m.tier ?? weightToTier(m.weight ?? 50),
        downloadUrl: `/api/plugin/download/${encodeURIComponent(m.name)}`,
      };
      if (m.description) entry.summary = m.description;
      if (m.author) entry.author = m.author;
      if (m.artifact) entry.sha256 = m.artifact.sha256;
      return entry;
    });
    return {
      schemaVersion: 1,
      node: loadConfig().node ?? "unknown",
      pluginCount: plugins.length,
      plugins,
    };
  },
);
