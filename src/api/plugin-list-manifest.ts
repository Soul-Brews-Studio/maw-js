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
import { discoverPackages } from "../plugin/registry";
import { loadConfig } from "../config";

export interface PeerPluginEntry {
  name: string;
  version: string;
  summary?: string;
  author?: string;
  sha256?: string | null;
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
