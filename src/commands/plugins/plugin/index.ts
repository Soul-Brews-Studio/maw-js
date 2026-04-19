import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import type { RegistryManifest } from "./registry-fetch";

export const command = {
  name: "plugin",
  description: "Plugin lifecycle — init, build, dev, install, search, info.",
};

const USAGE =
  "usage: maw plugin <init|build|dev|install|pin|unpin|registry|search|info> [args]\n" +
  "  init <name> --ts                    scaffold a TS plugin\n" +
  "  build [dir] [--watch] [--types]     bundle + pack a plugin\n" +
  "                                        --types: emit dist/<name>.d.ts\n" +
  "  dev [dir] [--types]                 watch mode (alias for build --watch, DX verb)\n" +
  "  install <name | dir | .tgz | URL>   install a plugin (plain name → registry lookup)\n" +
  "                                        --pin: add to plugins.lock on first install\n" +
  "  pin <name> <tarball> [--version V]  add/update plugins.lock entry (#487)\n" +
  "  unpin <name>                        remove a plugins.lock entry\n" +
  "  registry                            show registry URL + entry count\n" +
  "  search <query> [--peers|--peers-only|--peer <name>]\n" +
  "                                      search registry and/or peers (#631)\n" +
  "  info <name>                         show registry entry for <name>";

function isPlainName(src: string): boolean {
  if (/^https?:\/\//i.test(src)) return false;
  if (src.endsWith(".tgz") || src.endsWith(".tar.gz")) return false;
  if (src.startsWith("./") || src.startsWith("../") || src.startsWith("/")) return false;
  if (src.includes("/")) return false;
  return /^[a-z0-9][a-z0-9._-]*$/i.test(src);
}

async function runRegistryCmd(): Promise<void> {
  const { getRegistry, registryUrl } = await import("./registry-fetch");
  const url = registryUrl();
  const reg = await getRegistry();
  const count = Object.keys(reg.plugins).length;
  console.log(`registry: ${url}`);
  console.log(`updated:  ${reg.updated}`);
  console.log(`plugins:  ${count}`);
}

interface SearchFlags {
  query: string;
  peers: boolean;
  peersOnly: boolean;
  peer?: string;
}

function parseSearchArgs(args: string[]): SearchFlags {
  let query: string | undefined;
  let peers = false;
  let peersOnly = false;
  let peer: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--peers") peers = true;
    else if (a === "--peers-only") peersOnly = true;
    else if (a === "--peer") {
      peer = args[++i];
      if (!peer) throw new Error("--peer requires a name");
    } else if (!a.startsWith("-") && query === undefined) {
      query = a;
    }
  }
  if (!query) {
    throw new Error(
      "usage: maw plugin search <query> [--peers | --peers-only | --peer <name>]",
    );
  }
  return { query, peers, peersOnly, peer };
}

async function runSearchCmd(args: string[]): Promise<void> {
  const flags = parseSearchArgs(args);
  const wantPeers = flags.peers || flags.peersOnly || !!flags.peer;
  const wantRegistry = !flags.peersOnly && !flags.peer;

  if (wantRegistry) {
    const { getRegistry } = await import("./registry-fetch");
    const reg = await getRegistry();
    const q = flags.query.toLowerCase();
    const matches = Object.entries(reg.plugins)
      .filter(([name, e]) => name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q))
      .sort(([a], [b]) => a.localeCompare(b));
    if (wantPeers) console.log("registry:");
    if (matches.length === 0) {
      if (wantPeers) console.log("  (no hits)");
      else console.log(`no plugins match ${JSON.stringify(flags.query)}`);
    } else {
      for (const [name, e] of matches) {
        console.log(`${wantPeers ? "  " : ""}${name}@${e.version}  ${e.summary}`);
      }
    }
  }

  if (!wantPeers) return;

  const { searchPeers } = await import("./search-peers");
  const result = await searchPeers(flags.query, {
    peer: flags.peer,
  });
  const secs = (result.elapsedMs / 1000).toFixed(1);
  console.log(
    `\npeers (${result.queried} queried, ${result.responded} responded in ${secs}s):`,
  );
  if (result.hits.length === 0) {
    console.log("  (no hits)");
  } else {
    for (const h of result.hits) {
      const tag = h.peerName
        ? `@${h.peerName}${h.peerNode && h.peerNode !== h.peerName ? `(${h.peerNode})` : ""}`
        : `@${h.peerUrl}`;
      const summary = h.summary ?? "";
      console.log(`  ${h.name}@${h.version}  ${summary}  ${tag}`);
    }
  }
  for (const e of result.errors) {
    const label = e.peerName ?? e.peerUrl;
    console.log(`  \x1b[90m! ${label}: ${e.reason}${e.detail ? ` (${e.detail})` : ""}\x1b[0m`);
  }
}

async function runInfoCmd(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("usage: maw plugin info <name>");
  const { getRegistry } = await import("./registry-fetch");
  const reg: RegistryManifest = await getRegistry();
  const entry = reg.plugins[name];
  if (!entry) throw new Error(`plugin '${name}' not in registry`);
  console.log(`${name}@${entry.version}`);
  console.log(`  summary:  ${entry.summary}`);
  console.log(`  source:   ${entry.source}`);
  console.log(`  sha256:   ${entry.sha256 ?? "(unpinned)"}`);
  console.log(`  author:   ${entry.author}`);
  console.log(`  license:  ${entry.license}`);
  if (entry.homepage) console.log(`  homepage: ${entry.homepage}`);
  console.log(`  added:    ${entry.addedAt}`);
}

async function runInstallCmd(args: string[]): Promise<void> {
  const src = args.find(a => !a.startsWith("-"));
  if (src && isPlainName(src)) {
    const { getRegistry } = await import("./registry-fetch");
    const { resolvePluginSource } = await import("./registry-resolve");
    const reg = await getRegistry();
    const resolved = resolvePluginSource(src, reg);
    if (!resolved) {
      throw new Error(
        `plugin '${src}' not in registry.\n` +
        `  if you have a direct URL or tarball, run: maw plugin install <url | .tgz>`,
      );
    }
    const rewritten = args.map(a => (a === src ? resolved.source : a));
    const { cmdPluginInstall } = await import("./install-impl");
    await cmdPluginInstall(rewritten);
    return;
  }
  const { cmdPluginInstall } = await import("./install-impl");
  await cmdPluginInstall(args);
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0];

    if (!sub || sub === "--help" || sub === "-h") {
      return { ok: true, output: USAGE };
    }

    if (sub === "init") {
      const { cmdPluginInit } = await import("./init-impl");
      await cmdPluginInit(args.slice(1));
    } else if (sub === "build") {
      const { cmdPluginBuild } = await import("./build-impl");
      await cmdPluginBuild(args.slice(1));
    } else if (sub === "dev") {
      const { cmdPluginDev } = await import("./build-impl");
      await cmdPluginDev(args.slice(1));
    } else if (sub === "pin") {
      const { cmdPluginPin } = await import("./lock-cli");
      await cmdPluginPin(args.slice(1));
    } else if (sub === "unpin") {
      const { cmdPluginUnpin } = await import("./lock-cli");
      await cmdPluginUnpin(args.slice(1));
    } else if (sub === "registry") {
      await runRegistryCmd();
    } else if (sub === "search") {
      await runSearchCmd(args.slice(1));
    } else if (sub === "info") {
      await runInfoCmd(args.slice(1));
    } else if (sub === "install") {
      try {
        await runInstallCmd(args.slice(1));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/Cannot find module/.test(msg)) {
          return {
            ok: false,
            error:
              "plugin install: not yet implemented in this build (task #3 in progress).\n" +
              "  build produces: <name>-<version>.tgz (flat tarball: plugin.json + index.js at root).",
          };
        }
        throw e;
      }
    } else {
      return { ok: false, error: `unknown plugin subcommand: ${sub}\n${USAGE}` };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: logs.length ? logs.join("\n") : msg,
      output: logs.join("\n") || undefined,
    };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
