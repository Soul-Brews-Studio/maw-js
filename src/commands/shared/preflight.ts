import { listSessions, getPaneInfos, isAgentCommand } from "../../sdk";
import { buildCommandInDir, loadConfig } from "../../config";
import { Tmux } from "../../core/transport/tmux";
import { enginePatternKeysForConfig } from "../../config/engine-registry";
import { STANDARD_PLUGIN_MIN_COUNT, standardPluginHealthMessage } from "./standard-plugins";

export interface PreflightFs {
  readdirSync: typeof import("fs").readdirSync;
  lstatSync: typeof import("fs").lstatSync;
  existsSync: typeof import("fs").existsSync;
  unlinkSync: typeof import("fs").unlinkSync;
}

export interface PreflightDeps {
  now: () => number;
  packageVersion: () => string;
  pluginDir: () => string;
  fs: () => Promise<PreflightFs>;
  join: typeof import("path").join;
  listSessions: typeof listSessions;
  getPaneInfos: typeof getPaneInfos;
  isAgentCommand: typeof isAgentCommand;
  buildCommandInDir: typeof buildCommandInDir;
  loadConfig: typeof loadConfig;
  tmux: Pick<Tmux, "sendText">;
  log: (...args: unknown[]) => void;
  standardPluginMinimum: number;
}

export function preflightDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    now: () => Date.now(),
    packageVersion: () => require("../../../package.json").version,
    pluginDir: () => {
      const { mawDataPath } = require("../../core/xdg") as typeof import("../../core/xdg");
      return process.env.MAW_PLUGINS_DIR || mawDataPath("plugins");
    },
    fs: async () => await import("fs"),
    join: (...parts: string[]) => {
      const { join } = require("path") as typeof import("path");
      return join(...parts);
    },
    listSessions,
    getPaneInfos,
    isAgentCommand,
    buildCommandInDir,
    loadConfig,
    tmux: new Tmux(),
    log: (...args: unknown[]) => console.log(...args),
    standardPluginMinimum: STANDARD_PLUGIN_MIN_COUNT,
    ...overrides,
  };
}

export async function cmdPreflight(opts: { fix?: boolean } = {}, deps: Partial<PreflightDeps> = {}) {
  const io = preflightDeps(deps);
  const t0 = io.now();
  let pass = 0;
  let fail = 0;
  let fixed = 0;

  io.log(`\n  \x1b[36mmaw preflight\x1b[0m\n`);

  // 1. Version
  io.log(`  \x1b[32m✓\x1b[0m version: v${io.packageVersion()}`);
  pass++;

  // 2. Plugin count + broken symlinks
  const { readdirSync, lstatSync, existsSync, unlinkSync } = await io.fs();
  const pluginDir = io.pluginDir();
  try {
    const entries = readdirSync(pluginDir);
    const broken: string[] = [];
    for (const e of entries) {
      const p = io.join(pluginDir, e);
      try { if (lstatSync(p).isSymbolicLink() && !existsSync(p)) broken.push(e); } catch {}
    }
    const count = entries.length - broken.length;
    const health = {
      pluginDir,
      count,
      broken,
      status: count === 0 ? "missing" as const : count < io.standardPluginMinimum ? "low" as const : "ok" as const,
      minExpected: io.standardPluginMinimum,
    };
    const healthMessage = standardPluginHealthMessage(health);
    if (broken.length > 0 && opts.fix) {
      for (const b of broken) { try { unlinkSync(io.join(pluginDir, b)); fixed++; } catch {} }
      io.log(`  \x1b[33m⚠\x1b[0m plugins: ${entries.length} loaded, ${broken.length} broken symlinks fixed`);
      if (count < io.standardPluginMinimum) {
        io.log(`      ${healthMessage}`);
        io.log(`      run: maw plugin install --standard`);
        fail++;
      }
    } else if (broken.length > 0) {
      io.log(`  \x1b[31m✗\x1b[0m plugins: ${entries.length} loaded, ${broken.length} broken symlinks`);
      fail++;
    } else if (healthMessage) {
      io.log(`  \x1b[31m✗\x1b[0m plugins: ${healthMessage}`);
      io.log(`      run: maw plugin install --standard`);
      fail++;
    } else {
      io.log(`  \x1b[32m✓\x1b[0m plugins: ${entries.length} loaded, 0 broken`);
      pass++;
    }
  } catch {
    io.log(`  \x1b[31m✗\x1b[0m plugins: dir missing`);
    fail++;
  }

  // 3. Sessions + agent detection. A non-agent command does not prove that a
  // pane is dead: Codex can run beneath bash, and registered windows can be
  // intentional shells or services. Without declared window intent, keep the
  // classification informational and never overwrite the pane under --fix.
  const sessions = await io.listSessions().catch(() => []);
  const targets: string[] = [];
  const windowMeta: { session: string; window: string; target: string }[] = [];
  for (const s of sessions) {
    for (const w of s.windows) {
      const t = `${s.name}:${w.index}`;
      targets.push(t);
      windowMeta.push({ session: s.name, window: w.name, target: t });
    }
  }

  const infos = await io.getPaneInfos(targets);
  let aliveCount = 0;
  const unclassified: typeof windowMeta = [];

  for (const wm of windowMeta) {
    const info = infos[wm.target];
    if (info && io.isAgentCommand(info.command)) {
      aliveCount++;
    } else if (info) {
      unclassified.push(wm);
    }
  }

  if (sessions.length === 0) {
    io.log(`  \x1b[90m○\x1b[0m sessions: none running`);
  } else {
    io.log(`  \x1b[32m✓\x1b[0m sessions: ${sessions.length} (${aliveCount} agents alive)`);
    pass++;
  }

  if (unclassified.length > 0) {
    io.log(`  \x1b[90m○\x1b[0m unclassified panes: ${unclassified.length} pane${unclassified.length === 1 ? "" : "s"} with no detected agent`);
    for (const d of unclassified) {
      const info = infos[d.target];
      io.log(`      \x1b[90m●\x1b[0m ${d.session}:${d.window} \x1b[90m(${info?.command || "?"})\x1b[0m`);
    }
    io.log(`      \x1b[90mmanual inspection required; --fix will not write to these panes\x1b[0m`);
  }

  // 4. Config check
  const config = io.loadConfig();
  const engines = enginePatternKeysForConfig(config).filter(k => k !== "default");
  io.log(`  \x1b[32m✓\x1b[0m config: node=${config.node || "?"}, engines=[${engines.join(", ") || "default only"}]`);
  pass++;

  // Summary
  const elapsed = io.now() - t0;
  const icon = fail === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⚠\x1b[0m";
  io.log(`\n  ${icon} ${pass} pass, ${fail} fail${fixed > 0 ? `, ${fixed} fixed` : ""} (${elapsed}ms)\n`);
}
