/**
 * maw plugin install <src>
 *
 * Accepts three source types (detected by prefix / extension):
 *   • Directory   — e.g. ./hello/            → symlink to ~/.maw/plugins/<name>/
 *                                              label: "linked (dev)"
 *   • Tarball     — e.g. ./hello-0.1.0.tgz  → extract + hash verify
 *                                              label: "installed (sha256:abc…)"
 *   • URL         — http(s)://...            → download → tarball flow
 *
 * Phase A gates (run BEFORE symlinking / extracting):
 *   • Semver check — plugin.json.sdk must satisfy the runtime SDK version.
 *     Mismatch → actionable error (exact format per plan §1), exit 1.
 *
 * Phase A labels output (per plan §Author-facing surface):
 *   ✓ <name>@<version> installed
 *     sdk: <range> ✓ (maw <version>)
 *     capabilities: <list>
 *     mode: linked (dev) | installed (sha256:<prefix>…)
 *     dir: ~/.maw/plugins/<name>
 *   try: maw <name>
 */

import { parseFlags } from "../../../cli/parse-args";
import { detectMode, ensureInstallRoot } from "./install-source-detect";
import { installFromDir, installFromTarball, installFromUrl, installFromMonorepo, installFromGithub } from "./install-handlers";
import { resolvePeerInstall } from "./install-peer-resolver";
import { basename, join } from "path";

export { installRoot, detectMode, parsePeerSpec, parseMonorepoRef, parseGithubRef, ensureInstallRoot, removeExisting } from "./install-source-detect";
export type { GithubRef } from "./install-source-detect";
export { extractTarball, downloadTarball, verifyArtifactHash } from "./install-extraction";
export { readManifest, shortHash, printInstallSuccess, findMonorepoPluginRoot } from "./install-manifest-helpers";
export { installFromDir, installFromTarball, installFromUrl, installFromMonorepo, installFromGithub, ensurePluginMawJsLink, monorepoTarballUrl, monorepoRepoSlug, githubBaseUrl } from "./install-handlers";
export { resolvePeerInstall } from "./install-peer-resolver";
export type { ResolvedPeerSource } from "./install-peer-resolver";

// TODO(phase-b): trust-boundary enforcement. First tarball installed from a
// non-first-party URL should flip capability enforcement on for that plugin.
// Today we track the install source but don't gate on it.

/**
 * cmdPluginInstall — parse args, dispatch by source type.
 *
 * Called by src/commands/plugins/plugin/index.ts dispatcher with the raw
 * args after the "install" verb (i.e. args = ["./hello/", "--link"] or
 * similar). Matches the convention of sibling init-impl.ts / build-impl.ts.
 */
const CATEGORY_WEIGHT: Record<string, number> = { core: 5, standard: 30, extra: 70 };

export async function cmdPluginInstall(args: string[]): Promise<void> {
  const flags = parseFlags(
    args,
    { "--link": Boolean, "--force": Boolean, "--category": String, "--pin": Boolean, "--local": Boolean, "--symlink": Boolean },
    0,
  );
  const src = flags._[0];

  if (!src || src === "--help" || src === "-h") {
    throw new Error("usage: maw plugin install <dir | .tgz | URL | name@peer | monorepo:plugins/<name>@<tag> | owner/repo[/name][@ref]> [--link|--symlink] [--local] [--force] [--pin] [--category core|standard|extra]");
  }

  const originalPluginsDir = process.env.MAW_PLUGINS_DIR;
  if (flags["--local"]) {
    process.env.MAW_PLUGINS_DIR = join(process.cwd(), ".maw", "plugins");
  }

  try {
    ensureInstallRoot();
    const mode = detectMode(src);
    const force = !!flags["--force"];
    const pin = !!flags["--pin"];
    const symlink = !!flags["--symlink"];
    const cat = flags["--category"] as string | undefined;
    if (cat !== undefined && !(cat in CATEGORY_WEIGHT)) {
      throw new Error(`--category must be one of: core, standard, extra (got ${JSON.stringify(cat)})`);
    }
    const weight = cat !== undefined ? CATEGORY_WEIGHT[cat] : undefined;

    // Dispatch on source type. --pin only meaningful for tarball/URL installs
    // (dev `--link`/`--symlink` is a symlink, not a supply-chain surface).
    if (symlink && mode.kind !== "dir") {
      throw new Error("--symlink is only supported for local directory plugin installs");
    }

    if (mode.kind === "dir") {
      await installFromDir(mode.src, { force, weight });
    } else if (mode.kind === "tarball") {
      await installFromTarball(mode.src, { source: `./${basename(mode.src)}`, force, weight, pin });
    } else if (mode.kind === "monorepo") {
      await installFromMonorepo(mode.subpath, mode.tag, { force, weight, pin });
    } else if (mode.kind === "github") {
      // #939 — Vercel-style `owner/repo[/name][@ref]`.
      await installFromGithub(
        {
          owner: mode.owner,
          repo: mode.repo,
          ...(mode.subpath ? { subpath: mode.subpath } : {}),
          ...(mode.ref ? { ref: mode.ref } : {}),
        },
        { force, weight, pin },
      );
    } else if (mode.kind === "peer") {
      const resolved = await resolvePeerInstall(mode.name, mode.peer);
      console.log(
        `→ ${resolved.peerName}${resolved.peerNode ? ` (${resolved.peerNode})` : ""} advertises: ` +
        `${mode.name}@${resolved.version}` +
        (resolved.peerSha256 ? ` (sha256: ${resolved.peerSha256.slice(0, 12)}…)` : ""),
      );

      if (resolved.identityMismatch) {
        console.error([
          `\x1b[31m✗ peer identity mismatch\x1b[0m: refusing plugin install from '${resolved.peerName}'`,
          `  configured peer: ${resolved.peerName}  [${resolved.peerUrl}]`,
          resolved.peerNode ? `  manifest claimed node: ${resolved.peerNode}` : "",
          `  refusing to bind consent/trust to the claimed peer node`,
          `  retry after fixing namedPeers or the peer manifest identity`,
        ].filter(Boolean).join("\n"));
        process.exit(1);
      }

      // #644 Phase 3 — PIN consent before we touch the network for the artifact.
      // Default OFF; opt in via MAW_CONSENT=1. Gate lives here (not in resolver)
      // so the operator sees what the peer advertised BEFORE being asked to
      // approve — the decision context is on-screen.
      if (process.env.MAW_CONSENT === "1") {
        const { maybeGatePluginInstall } = await import("../../../core/consent/gate-plugin-install");
        const { loadConfig } = await import("../../../config");
        const myNode = loadConfig().node ?? "local";
        const decision = await maybeGatePluginInstall({
          myNode,
          peerName: resolved.peerName,
          peerNode: resolved.peerNode,
          peerUrl: resolved.peerUrl,
          pluginName: mode.name,
          pluginVersion: resolved.version,
          pluginSha256: resolved.peerSha256,
          identityMismatch: resolved.identityMismatch,
        });
        if (!decision.allow) {
          if (decision.message) console.error(decision.message);
          process.exit(decision.exitCode ?? 1);
        }
      }

      console.log(`→ downloading ${resolved.downloadUrl}…`);
      await installFromUrl(resolved.downloadUrl, { force, weight, pin });
    } else {
      await installFromUrl(mode.src, { force, weight, pin });
    }
  } finally {
    if (flags["--local"]) {
      if (originalPluginsDir === undefined) delete process.env.MAW_PLUGINS_DIR;
      else process.env.MAW_PLUGINS_DIR = originalPluginsDir;
    }
  }
}
