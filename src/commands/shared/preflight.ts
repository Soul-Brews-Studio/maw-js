import { listSessions, getPaneInfos, isAgentCommand } from "../../sdk";
import { buildCommandInDir } from "../../config";
import { Tmux } from "../../core/transport/tmux";

export async function cmdPreflight(opts: { fix?: boolean } = {}) {
  const t0 = Date.now();
  const tmux = new Tmux();
  let pass = 0;
  let fail = 0;
  let fixed = 0;

  console.log(`\n  \x1b[36mmaw preflight\x1b[0m\n`);

  // 1. Version
  const pkg = require("../../../package.json");
  console.log(`  \x1b[32m✓\x1b[0m version: v${pkg.version}`);
  pass++;

  // 2. Plugin count + broken symlinks
  const { readdirSync, lstatSync, existsSync, unlinkSync } = await import("fs");
  const { join } = await import("path");
  const { homedir } = await import("os");
  const pluginDir = join(homedir(), ".maw", "plugins");
  try {
    const entries = readdirSync(pluginDir);
    const broken: string[] = [];
    for (const e of entries) {
      const p = join(pluginDir, e);
      try { if (lstatSync(p).isSymbolicLink() && !existsSync(p)) broken.push(e); } catch {}
    }
    if (broken.length > 0) {
      if (opts.fix) {
        for (const b of broken) { try { unlinkSync(join(pluginDir, b)); fixed++; } catch {} }
        console.log(`  \x1b[33m⚠\x1b[0m plugins: ${entries.length} loaded, ${broken.length} broken symlinks fixed`);
      } else {
        console.log(`  \x1b[31m✗\x1b[0m plugins: ${entries.length} loaded, ${broken.length} broken symlinks`);
        fail++;
      }
    } else {
      console.log(`  \x1b[32m✓\x1b[0m plugins: ${entries.length} loaded, 0 broken`);
      pass++;
    }
  } catch {
    console.log(`  \x1b[31m✗\x1b[0m plugins: dir missing`);
    fail++;
  }

  // 3. Sessions + dead agent detection
  const sessions = await listSessions().catch(() => []);
  const targets: string[] = [];
  const windowMeta: { session: string; window: string; target: string }[] = [];
  for (const s of sessions) {
    for (const w of s.windows) {
      const t = `${s.name}:${w.index}`;
      targets.push(t);
      windowMeta.push({ session: s.name, window: w.name, target: t });
    }
  }

  const infos = await getPaneInfos(targets);
  let aliveCount = 0;
  const dead: typeof windowMeta = [];

  for (const wm of windowMeta) {
    const info = infos[wm.target];
    if (info && isAgentCommand(info.command)) {
      aliveCount++;
    } else if (info) {
      dead.push(wm);
    }
  }

  if (sessions.length === 0) {
    console.log(`  \x1b[90m○\x1b[0m sessions: none running`);
  } else {
    console.log(`  \x1b[32m✓\x1b[0m sessions: ${sessions.length} (${aliveCount} agents alive)`);
    pass++;
  }

  if (dead.length > 0) {
    console.log(`  \x1b[31m✗\x1b[0m dead agents: ${dead.length} pane${dead.length === 1 ? "" : "s"} with no agent`);
    for (const d of dead) {
      const info = infos[d.target];
      console.log(`      \x1b[31m●\x1b[0m ${d.session}:${d.window} \x1b[90m(${info?.command || "?"})\x1b[0m`);
    }
    if (opts.fix) {
      console.log(`\n  \x1b[36m→ reviving ${dead.length} dead agent${dead.length === 1 ? "" : "s"}…\x1b[0m`);
      for (const d of dead) {
        const cmd = buildCommandInDir(d.window, infos[d.target]?.cwd || "");
        await tmux.sendText(d.target, cmd);
        console.log(`    \x1b[32m✓\x1b[0m ${d.session}:${d.window}`);
        fixed++;
      }
    } else {
      console.log(`\n  \x1b[90m  → maw preflight --fix   to revive dead agents\x1b[0m`);
    }
    fail++;
  }

  // 4. Config check
  const { loadConfig } = await import("../../config");
  const config = loadConfig();
  const engines = Object.keys(config.commands || {}).filter(k => k !== "default");
  console.log(`  \x1b[32m✓\x1b[0m config: node=${config.node || "?"}, engines=[${engines.join(", ") || "default only"}]`);
  pass++;

  // Summary
  const elapsed = Date.now() - t0;
  const icon = fail === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⚠\x1b[0m";
  console.log(`\n  ${icon} ${pass} pass, ${fail} fail${fixed > 0 ? `, ${fixed} fixed` : ""} (${elapsed}ms)\n`);
}
