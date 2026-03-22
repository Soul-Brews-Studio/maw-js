#!/usr/bin/env bun
// @bun
var __defProp = Object.defineProperty;
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = import.meta.require;

// src/config.ts
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
function loadConfig() {
  if (cached)
    return cached;
  const configPath = join(import.meta.dir, "../maw.config.json");
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    cached = { ...DEFAULTS, ...raw };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}
function resetConfig() {
  cached = null;
}
function saveConfig(update) {
  const configPath = join(import.meta.dir, "../maw.config.json");
  const current = loadConfig();
  const merged = { ...current, ...update };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + `
`, "utf-8");
  resetConfig();
  return loadConfig();
}
function configForDisplay() {
  const config = loadConfig();
  const envMasked = {};
  for (const [k, v] of Object.entries(config.env)) {
    if (v.length <= 4) {
      envMasked[k] = "\u2022".repeat(v.length);
    } else {
      envMasked[k] = v.slice(0, 3) + "\u2022".repeat(Math.min(v.length - 3, 20));
    }
  }
  return { ...config, env: {}, envMasked };
}
function matchGlob(pattern, name) {
  if (pattern === name)
    return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1)))
    return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1)))
    return true;
  return false;
}
function buildCommand(agentName) {
  const config = loadConfig();
  let cmd = config.commands.default || "claude";
  for (const [pattern, command] of Object.entries(config.commands)) {
    if (pattern === "default")
      continue;
    if (matchGlob(pattern, agentName)) {
      cmd = command;
      break;
    }
  }
  const prefix = 'command -v direnv >/dev/null && direnv allow . && eval "$(direnv export zsh)"; unset CLAUDECODE 2>/dev/null;';
  if (cmd.includes("--continue")) {
    const fallback = cmd.replace(/\s*--continue\b/, "");
    return `${prefix} ${cmd} || ${prefix} ${fallback}`;
  }
  return `${prefix} ${cmd}`;
}
function getEnvVars() {
  return loadConfig().env || {};
}
var DEFAULTS, cached = null;
var init_config = __esm(() => {
  DEFAULTS = {
    host: "local",
    port: 3456,
    ghqRoot: "/home/nat/Code/github.com",
    oracleUrl: "http://localhost:47779",
    env: {},
    commands: { default: "claude" },
    sessions: {}
  };
});

// src/tmux.ts
var exports_tmux = {};
__export(exports_tmux, {
  tmux: () => tmux,
  Tmux: () => Tmux
});
function q(s) {
  const str = String(s);
  if (/^[a-zA-Z0-9_.:\-\/]+$/.test(str))
    return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}

class Tmux {
  host;
  constructor(host) {
    this.host = host;
  }
  async run(subcommand, ...args) {
    const cmd = `tmux ${subcommand} ${args.map(q).join(" ")} 2>/dev/null`;
    return ssh(cmd, this.host);
  }
  async tryRun(subcommand, ...args) {
    return this.run(subcommand, ...args).catch(() => "");
  }
  async listSessions() {
    const raw = await this.run("list-sessions", "-F", "#{session_name}");
    const sessions = [];
    for (const s of raw.split(`
`).filter(Boolean)) {
      const windows = await this.listWindows(s);
      sessions.push({ name: s, windows });
    }
    return sessions;
  }
  async listAll() {
    const raw = await this.run("list-windows", "-a", "-F", "#{session_name}|||#{window_index}|||#{window_name}|||#{window_active}|||#{pane_current_path}");
    const map = new Map;
    for (const line of raw.split(`
`).filter(Boolean)) {
      const [session, idx, name, active, cwd] = line.split("|||");
      if (!map.has(session))
        map.set(session, []);
      map.get(session).push({ index: +idx, name, active: active === "1", cwd: cwd || undefined });
    }
    return [...map.entries()].map(([name, windows]) => ({ name, windows }));
  }
  async hasSession(name) {
    try {
      await this.run("has-session", "-t", name);
      return true;
    } catch {
      return false;
    }
  }
  async newSession(name, opts = {}) {
    const args = [];
    if (opts.detached !== false)
      args.push("-d");
    args.push("-s", name);
    if (opts.window)
      args.push("-n", opts.window);
    if (opts.cwd)
      args.push("-c", opts.cwd);
    await this.run("new-session", ...args);
  }
  async newGroupedSession(parent, name, opts) {
    await this.run("new-session", "-d", "-t", parent, "-s", name, "-x", opts.cols, "-y", opts.rows);
    if (opts.window)
      await this.selectWindow(`${name}:${opts.window}`);
  }
  async killSession(name) {
    await this.tryRun("kill-session", "-t", name);
  }
  async listWindows(session) {
    const raw = await this.run("list-windows", "-t", session, "-F", "#{window_index}:#{window_name}:#{window_active}");
    return raw.split(`
`).filter(Boolean).map((w) => {
      const [idx, name, active] = w.split(":");
      return { index: +idx, name, active: active === "1" };
    });
  }
  async newWindow(session, name, opts = {}) {
    const args = ["-t", session, "-n", name];
    if (opts.cwd)
      args.push("-c", opts.cwd);
    await this.run("new-window", ...args);
  }
  async selectWindow(target) {
    await this.tryRun("select-window", "-t", target);
  }
  async killWindow(target) {
    await this.tryRun("kill-window", "-t", target);
  }
  async getPaneCommand(target) {
    const raw = await this.run("list-panes", "-t", target, "-F", "#{pane_current_command}");
    return raw.split(`
`)[0] || "";
  }
  async getPaneCommands(targets) {
    const result = {};
    await Promise.allSettled(targets.map(async (t) => {
      try {
        result[t] = await this.getPaneCommand(t);
      } catch {}
    }));
    return result;
  }
  async getPaneInfo(target) {
    const raw = await this.run("list-panes", "-t", target, "-F", "#{pane_current_command}\t#{pane_current_path}");
    const [command = "", cwd = ""] = raw.split(`
`)[0].split("\t");
    return { command, cwd };
  }
  async getPaneInfos(targets) {
    const result = {};
    await Promise.allSettled(targets.map(async (t) => {
      try {
        result[t] = await this.getPaneInfo(t);
      } catch {}
    }));
    return result;
  }
  async capture(target, lines = 80) {
    if (lines > 50) {
      return this.run("capture-pane", "-t", target, "-e", "-p", "-S", -lines);
    }
    const cmd = `tmux capture-pane -t ${q(target)} -e -p 2>/dev/null | tail -${lines}`;
    return ssh(cmd, this.host);
  }
  async resizePane(target, cols, rows) {
    const c = Math.max(1, Math.min(500, Math.floor(cols)));
    const r = Math.max(1, Math.min(200, Math.floor(rows)));
    await this.tryRun("resize-pane", "-t", target, "-x", c, "-y", r);
  }
  async splitWindow(target) {
    await this.run("split-window", "-t", target);
  }
  async selectPane(target, opts = {}) {
    const args = ["-t", target];
    if (opts.title)
      args.push("-T", opts.title);
    await this.run("select-pane", ...args);
  }
  async selectLayout(target, layout) {
    await this.run("select-layout", "-t", target, layout);
  }
  async sendKeys(target, ...keys) {
    await this.run("send-keys", "-t", target, ...keys);
  }
  async sendKeysLiteral(target, text) {
    await this.run("send-keys", "-t", target, "-l", text);
  }
  async loadBuffer(text) {
    const escaped = text.replace(/'/g, "'\\''");
    const cmd = `printf '%s' '${escaped}' | tmux load-buffer -`;
    await ssh(cmd, this.host);
  }
  async pasteBuffer(target) {
    await this.run("paste-buffer", "-t", target);
  }
  async sendText(target, text) {
    if (text.includes(`
`) || text.length > 500) {
      await this.loadBuffer(text);
      await this.pasteBuffer(target);
      await new Promise((r) => setTimeout(r, 150));
      await this.sendKeys(target, "Enter");
    } else {
      await this.sendKeysLiteral(target, text);
      await new Promise((r) => setTimeout(r, 150));
      await this.sendKeys(target, "Enter");
      await new Promise((r) => setTimeout(r, 1000));
      await this.sendKeys(target, "Enter");
    }
  }
  async setEnvironment(session, key, value) {
    await this.run("set-environment", "-t", session, key, value);
  }
  async setOption(target, option, value) {
    await this.tryRun("set-option", "-t", target, option, value);
  }
  async set(target, option, value) {
    await this.tryRun("set", "-t", target, option, value);
  }
}
var tmux;
var init_tmux = __esm(() => {
  init_ssh();
  tmux = new Tmux;
});

// src/ssh.ts
async function ssh(cmd, host = DEFAULT_HOST) {
  const local = host === "local" || host === "localhost" || IS_LOCAL;
  const args = local ? ["bash", "-c", cmd] : ["ssh", host, cmd];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(err.trim() || `exit ${code}`);
  }
  return text.trim();
}
async function listSessions(host) {
  let raw;
  try {
    raw = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null", host);
  } catch {
    return [];
  }
  const sessions = [];
  for (const s of raw.split(`
`).filter(Boolean)) {
    const winRaw = await ssh(`tmux list-windows -t '${s}' -F '#{window_index}:#{window_name}:#{window_active}' 2>/dev/null`, host);
    const windows = winRaw.split(`
`).filter(Boolean).map((w) => {
      const [idx, name, active] = w.split(":");
      return { index: +idx, name, active: active === "1" };
    });
    sessions.push({ name: s, windows });
  }
  return sessions;
}
function findWindow(sessions, query) {
  const q2 = query.toLowerCase();
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.toLowerCase().includes(q2))
        return `${s.name}:${w.index}`;
    }
  }
  if (query.includes(":"))
    return query;
  return null;
}
async function capture(target, lines = 80, host) {
  if (lines > 50) {
    return ssh(`tmux capture-pane -t '${target}' -e -p -S -${lines} 2>/dev/null`, host);
  }
  return ssh(`tmux capture-pane -t '${target}' -e -p 2>/dev/null | tail -${lines}`, host);
}
async function selectWindow(target, host) {
  await ssh(`tmux select-window -t '${target}' 2>/dev/null`, host);
}
async function getPaneCommand(target, host) {
  const { Tmux: Tmux2 } = await Promise.resolve().then(() => (init_tmux(), exports_tmux));
  const t = new Tmux2(host);
  return t.getPaneCommand(target);
}
async function getPaneInfos(targets, host) {
  const { Tmux: Tmux2 } = await Promise.resolve().then(() => (init_tmux(), exports_tmux));
  const t = new Tmux2(host);
  return t.getPaneInfos(targets);
}
async function sendKeys(target, text, host) {
  const { Tmux: Tmux2 } = await Promise.resolve().then(() => (init_tmux(), exports_tmux));
  const t = new Tmux2(host);
  const SPECIAL_KEYS = {
    "\x1B": "Escape",
    "\x1B[A": "Up",
    "\x1B[B": "Down",
    "\x1B[C": "Right",
    "\x1B[D": "Left",
    "\r": "Enter",
    "\n": "Enter",
    "\b": "BSpace",
    "\x15": "C-u"
  };
  if (SPECIAL_KEYS[text]) {
    await t.sendKeys(target, SPECIAL_KEYS[text]);
    return;
  }
  const endsWithEnter = text.endsWith("\r") || text.endsWith(`
`);
  const body = endsWithEnter ? text.slice(0, -1) : text;
  if (!body) {
    await t.sendKeys(target, "Enter");
    return;
  }
  if (body.startsWith("/")) {
    for (const ch of body) {
      await t.sendKeysLiteral(target, ch);
    }
    await t.sendKeys(target, "Enter");
  } else {
    await t.sendText(target, body);
  }
}
var DEFAULT_HOST, IS_LOCAL;
var init_ssh = __esm(() => {
  init_config();
  DEFAULT_HOST = process.env.MAW_HOST || loadConfig().host || "white.local";
  IS_LOCAL = DEFAULT_HOST === "local" || DEFAULT_HOST === "localhost";
});

// src/commands/overview.ts
function buildTargets(sessions, filters) {
  let targets = sessions.filter((s) => /^\d+-/.test(s.name) && s.name !== "0-overview").map((s) => {
    const active = s.windows.find((w) => w.active) || s.windows[0];
    const oracleName = s.name.replace(/^\d+-/, "");
    return { session: s.name, window: active?.index ?? 1, windowName: active?.name ?? oracleName, oracle: oracleName };
  });
  if (filters.length) {
    targets = targets.filter((t) => filters.some((f) => t.oracle.includes(f) || t.session.includes(f)));
  }
  return targets;
}
function paneColor(index) {
  return PANE_COLORS[index % PANE_COLORS.length];
}
function paneTitle(t) {
  return `${t.oracle} (${t.session}:${t.window})`;
}
function processMirror(raw, lines) {
  const sep = "\u2500".repeat(60);
  const filtered = raw.replace(/[\u2500\u2501]{6,}/g, sep).split(`
`).filter((l) => l.trim() !== "");
  const visible = filtered.slice(-lines);
  const pad = Math.max(0, lines - visible.length);
  return `
`.repeat(pad) + visible.join(`
`);
}
function mirrorCmd(t) {
  const target = encodeURIComponent(`${t.session}:${t.window}`);
  const port = process.env.MAW_PORT || "3456";
  return `watch --color -t -n0.5 'curl -s "http://localhost:${port}/api/mirror?target=${target}&lines=\\$(tput lines)"'`;
}
function pickLayout(count) {
  if (count <= 2)
    return "even-horizontal";
  return "tiled";
}
function chunkTargets(targets) {
  const pages = [];
  for (let i = 0;i < targets.length; i += PANES_PER_PAGE) {
    pages.push(targets.slice(i, i + PANES_PER_PAGE));
  }
  return pages;
}
async function cmdOverview(filterArgs) {
  const kill = filterArgs.includes("--kill") || filterArgs.includes("-k");
  const filters = filterArgs.filter((a) => !a.startsWith("-"));
  try {
    await ssh("tmux kill-session -t 0-overview 2>/dev/null");
  } catch {}
  if (kill) {
    console.log("overview killed");
    return;
  }
  const sessions = await listSessions();
  const targets = buildTargets(sessions, filters);
  if (!targets.length) {
    console.error("no oracle sessions found");
    return;
  }
  const pages = chunkTargets(targets);
  await ssh("tmux new-session -d -s 0-overview -n page-1");
  await ssh("tmux set -t 0-overview pane-border-status top");
  await ssh('tmux set -t 0-overview pane-border-format " #{pane_title} "');
  await ssh("tmux set -t 0-overview pane-border-style fg=colour238");
  await ssh("tmux set -t 0-overview pane-active-border-style fg=colour45");
  await ssh("tmux set -t 0-overview status-style bg=colour235,fg=colour248");
  await ssh("tmux set -t 0-overview status-left-length 40");
  await ssh("tmux set -t 0-overview status-right-length 60");
  await ssh(`tmux set -t 0-overview status-left '#[fg=colour16,bg=colour204,bold] \u2588 MAW #[fg=colour204,bg=colour238] #[fg=colour255,bg=colour238] ${targets.length} oracles #[fg=colour238,bg=colour235] '`);
  await ssh(`tmux set -t 0-overview status-right '#[fg=colour238,bg=colour235]#[fg=colour114,bg=colour238] \u25CF live #[fg=colour81,bg=colour238] %H:%M #[fg=colour16,bg=colour81,bold] %d-%b '`);
  await ssh("tmux set -t 0-overview status-justify centre");
  await ssh("tmux set -t 0-overview window-status-format '#[fg=colour248,bg=colour235] #I:#W '");
  await ssh("tmux set -t 0-overview window-status-current-format '#[fg=colour16,bg=colour45,bold] #I:#W '");
  for (let p = 0;p < pages.length; p++) {
    const page = pages[p];
    const winName = `page-${p + 1}`;
    if (p > 0) {
      await ssh(`tmux new-window -t 0-overview -n ${winName}`);
    }
    const baseIdx = p * PANES_PER_PAGE;
    const pane0 = `0-overview:${winName}.0`;
    const color0 = paneColor(baseIdx);
    await ssh(`tmux select-pane -t ${pane0} -T '#[fg=${color0},bold]${paneTitle(page[0])}#[default]'`);
    await ssh(`tmux send-keys -t ${pane0} "${mirrorCmd(page[0]).replace(/"/g, "\\\"")}" Enter`);
    for (let i = 1;i < page.length; i++) {
      await ssh(`tmux split-window -t 0-overview:${winName}`);
      const paneId = `0-overview:${winName}.${i}`;
      const color = paneColor(baseIdx + i);
      await ssh(`tmux select-pane -t ${paneId} -T '#[fg=${color},bold]${paneTitle(page[i])}#[default]'`);
      await ssh(`tmux send-keys -t ${paneId} "${mirrorCmd(page[i]).replace(/"/g, "\\\"")}" Enter`);
      await ssh(`tmux select-layout -t 0-overview:${winName} tiled`);
    }
    const layout = pickLayout(page.length);
    await ssh(`tmux select-layout -t 0-overview:${winName} ${layout}`);
  }
  await ssh("tmux select-window -t 0-overview:page-1");
  console.log(`\x1B[32m\u2705\x1B[0m overview: ${targets.length} oracles across ${pages.length} page${pages.length > 1 ? "s" : ""}`);
  for (let p = 0;p < pages.length; p++) {
    console.log(`  page-${p + 1}: ${pages[p].map((t) => t.oracle).join(", ")}`);
  }
  console.log(`
  attach: tmux attach -t 0-overview`);
  if (pages.length > 1)
    console.log(`  navigate: Ctrl-b n/p (next/prev page)`);
}
var PANES_PER_PAGE = 9, PANE_COLORS;
var init_overview = __esm(() => {
  init_ssh();
  PANE_COLORS = [
    "colour204",
    "colour114",
    "colour81",
    "colour220",
    "colour177",
    "colour208",
    "colour44",
    "colour196",
    "colour83",
    "colour141"
  ];
});

// package.json
var require_package = __commonJS((exports, module) => {
  module.exports = {
    name: "maw",
    version: "1.1.0",
    type: "module",
    bin: {
      maw: "./src/cli.ts"
    },
    scripts: {
      "build:office": "cd office && bunx vite build",
      dev: `pm2 start ecosystem.config.cjs && echo '\u2192 maw backend (watch src/) on :3456
\u2192 maw-dev vite HMR on :5173
\u2192 pm2 logs to follow'`,
      "dev:office": "cd office && bunx vite",
      "dev:stop": "pm2 delete maw maw-dev 2>/dev/null; echo '\u2192 dev stopped'",
      deploy: "bun install && bun run build:office && pm2 delete maw-dev 2>/dev/null; pm2 restart maw",
      "build:8bit": "cd office-8bit && bash build.sh",
      "deploy:remote": "bun run build:office && rsync -az dist-office/ white.local:~/Code/github.com/Soul-Brews-Studio/maw-js/dist-office/ && rsync -az dist-8bit-office/ white.local:~/Code/github.com/Soul-Brews-Studio/maw-js/dist-8bit-office/ && rsync -az src/ white.local:~/Code/github.com/Soul-Brews-Studio/maw-js/src/ && ssh white.local 'export PATH=$HOME/.bun/bin:$PATH && pm2 restart maw' && echo '\u2192 deployed to white.local:3456'"
    },
    description: "maw.js \u2014 Multi-Agent Workflow in Bun/TS. Remote tmux orchestra control. CLI + Web UI.",
    dependencies: {
      "@monaco-editor/react": "^4.7.0",
      "@xterm/xterm": "^5.5.0",
      "@xterm/addon-fit": "^0.10.0",
      hono: "^4.12.5",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
      three: "^0.183.2",
      zustand: "^5.0.11"
    },
    devDependencies: {
      "@resvg/resvg-js": "^2.6.2",
      "@tailwindcss/vite": "^4.2.1",
      "@types/react": "^19.0.0",
      "@types/react-dom": "^19.0.0",
      "@types/three": "^0.183.1",
      "@vitejs/plugin-react": "^4.3.0",
      tailwindcss: "^4.2.1",
      vite: "^6.0.0"
    }
  };
});

// src/worktrees.ts
var exports_worktrees = {};
__export(exports_worktrees, {
  scanWorktrees: () => scanWorktrees,
  cleanupWorktree: () => cleanupWorktree
});
import { readdirSync as readdirSync6, readFileSync as readFileSync7 } from "fs";
import { join as join11 } from "path";
async function scanWorktrees() {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const fleetDir = join11(import.meta.dir, "../fleet");
  let wtPaths = [];
  try {
    const raw = await ssh(`find ${ghqRoot} -maxdepth 4 -name '*.wt-*' -type d 2>/dev/null`);
    wtPaths = raw.split(`
`).filter(Boolean);
  } catch {}
  const sessions = await listSessions();
  const runningWindows = new Set;
  for (const s of sessions) {
    for (const w of s.windows) {
      runningWindows.add(w.name);
    }
  }
  const fleetWindows = new Map;
  try {
    for (const file of readdirSync6(fleetDir).filter((f) => f.endsWith(".json"))) {
      const cfg = JSON.parse(readFileSync7(join11(fleetDir, file), "utf-8"));
      for (const w of cfg.windows || []) {
        if (w.repo)
          fleetWindows.set(w.repo, file);
      }
    }
  } catch {}
  const results = [];
  for (const wtPath of wtPaths) {
    const dirName = wtPath.split("/").pop();
    const parts = dirName.split(".wt-");
    if (parts.length < 2)
      continue;
    const mainRepoName = parts[0];
    const wtName = parts[1];
    const relPath = wtPath.replace(ghqRoot + "/", "");
    const parentParts = relPath.split("/");
    parentParts.pop();
    const org = parentParts.join("/");
    const mainRepo = `${org}/${mainRepoName}`;
    const repo = `${org}/${dirName}`;
    let branch = "";
    try {
      branch = (await ssh(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD 2>/dev/null`)).trim();
    } catch {
      branch = "unknown";
    }
    let tmuxWindow;
    const fleetFile = fleetWindows.get(repo);
    for (const s of sessions) {
      for (const w of s.windows) {
        const taskPart = wtName.replace(/^\d+-/, "");
        if (w.name.endsWith(`-${taskPart}`) || w.name === taskPart) {
          tmuxWindow = w.name;
        }
      }
    }
    const status = tmuxWindow ? "active" : "stale";
    results.push({
      path: wtPath,
      branch,
      repo,
      mainRepo,
      name: wtName,
      status,
      tmuxWindow,
      fleetFile
    });
  }
  const mainRepos = [...new Set(results.map((r) => r.mainRepo))];
  for (const mainRepo of mainRepos) {
    const mainPath = join11(ghqRoot, mainRepo);
    try {
      const prunable = await ssh(`git -C '${mainPath}' worktree list --porcelain 2>/dev/null | grep -A1 'prunable' | grep 'worktree' | sed 's/worktree //'`);
      for (const orphanPath of prunable.split(`
`).filter(Boolean)) {
        const existing = results.find((r) => r.path === orphanPath);
        if (existing) {
          existing.status = "orphan";
        } else {
          const dirName = orphanPath.split("/").pop() || "";
          results.push({
            path: orphanPath,
            branch: "(prunable)",
            repo: dirName,
            mainRepo,
            name: dirName,
            status: "orphan"
          });
        }
      }
    } catch {}
  }
  return results;
}
async function cleanupWorktree(wtPath) {
  const config = loadConfig();
  const ghqRoot = config.ghqRoot;
  const fleetDir = join11(import.meta.dir, "../fleet");
  const log = [];
  const dirName = wtPath.split("/").pop();
  const parts = dirName.split(".wt-");
  if (parts.length < 2) {
    log.push(`not a worktree: ${dirName}`);
    return log;
  }
  const mainRepoName = parts[0];
  const relPath = wtPath.replace(ghqRoot + "/", "");
  const parentParts = relPath.split("/");
  parentParts.pop();
  const org = parentParts.join("/");
  const mainPath = join11(ghqRoot, org, mainRepoName);
  const repo = `${org}/${dirName}`;
  const sessions = await listSessions();
  const wtName = parts[1];
  const taskPart = wtName.replace(/^\d+-/, "");
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.endsWith(`-${taskPart}`) || w.name === taskPart) {
        try {
          await ssh(`tmux kill-window -t '${s.name}:${w.name}'`);
          log.push(`killed window ${s.name}:${w.name}`);
        } catch {
          log.push(`window already closed: ${w.name}`);
        }
      }
    }
  }
  let branch = "";
  try {
    branch = (await ssh(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim();
  } catch {}
  try {
    await ssh(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
    await ssh(`git -C '${mainPath}' worktree prune`);
    log.push(`removed worktree ${dirName}`);
  } catch (e) {
    log.push(`worktree remove failed: ${e.message || e}`);
  }
  if (branch && branch !== "main" && branch !== "HEAD" && branch !== "unknown") {
    try {
      await ssh(`git -C '${mainPath}' branch -d '${branch}'`);
      log.push(`deleted branch ${branch}`);
    } catch {
      log.push(`branch ${branch} not deleted (may have unmerged changes)`);
    }
  }
  try {
    for (const file of readdirSync6(fleetDir).filter((f) => f.endsWith(".json"))) {
      const filePath = join11(fleetDir, file);
      const cfg = JSON.parse(readFileSync7(filePath, "utf-8"));
      const before = cfg.windows?.length || 0;
      cfg.windows = (cfg.windows || []).filter((w) => w.repo !== repo);
      if (cfg.windows.length < before) {
        const { writeFileSync: writeFileSync3 } = await import("fs");
        writeFileSync3(filePath, JSON.stringify(cfg, null, 2) + `
`);
        log.push(`removed from ${file}`);
      }
    }
  } catch {}
  return log;
}
var init_worktrees = __esm(() => {
  init_ssh();
  init_config();
});

// node_modules/hono/dist/compose.js
var compose = (middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || undefined;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
  };
};
var init_compose = () => {};

// node_modules/hono/dist/http-exception.js
var init_http_exception = () => {};

// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT;
var init_constants = __esm(() => {
  GET_MATCH_RESULT = /* @__PURE__ */ Symbol();
});

// node_modules/hono/dist/utils/body.js
async function parseFormData(request, options) {
  const formData = await request.formData();
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
var parseBody = async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = request instanceof HonoRequest ? request.raw.headers : request.headers;
  const contentType = headers.get("Content-Type");
  if (contentType?.startsWith("multipart/form-data") || contentType?.startsWith("application/x-www-form-urlencoded")) {
    return parseFormData(request, { all, dot });
  }
  return {};
}, handleParsingAllValues = (form, key, value) => {
  if (form[key] !== undefined) {
    if (Array.isArray(form[key])) {
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
}, handleParsingNestedValues = (form, key, value) => {
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
};
var init_body = __esm(() => {
  init_request();
});

// node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
}, splitRoutingPath = (routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
}, extractGroupsFromPath = (path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match, index) => {
    const mark = `@${index}`;
    groups.push([mark, match]);
    return mark;
  });
  return { groups, path };
}, replaceGroupMarks = (paths, groups) => {
  for (let i = groups.length - 1;i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1;j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
}, patternCache, getPattern = (label, next) => {
  if (label === "*") {
    return "*";
  }
  const match = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match[1], new RegExp(`^${match[2]}(?=/${next})`)] : [label, match[1], new RegExp(`^${match[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
}, tryDecode = (str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decoder(match);
      } catch {
        return match;
      }
    });
  }
}, tryDecodeURI = (str) => tryDecode(str, decodeURI), getPath = (request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (;i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? undefined : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
}, getPathNoStrict = (request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
}, mergePath = (base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
}, checkOptionalParameter = (path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
}, _decodeURI = (value) => {
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return value.indexOf("%") !== -1 ? tryDecode(value, decodeURIComponent_) : value;
}, _getQueryParam = (url, key, multiple) => {
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? undefined : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return;
    }
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? undefined : nextKeyIndex : valueIndex);
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? undefined : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
}, getQueryParam, getQueryParams = (url, key) => {
  return _getQueryParam(url, key, true);
}, decodeURIComponent_;
var init_url = __esm(() => {
  patternCache = {};
  getQueryParam = _getQueryParam;
  decodeURIComponent_ = decodeURIComponent;
});

// node_modules/hono/dist/request.js
var tryDecodeURIComponent = (str) => tryDecode(str, decodeURIComponent_), HonoRequest;
var init_request = __esm(() => {
  init_http_exception();
  init_constants();
  init_body();
  init_url();
  HonoRequest = class {
    raw;
    #validatedData;
    #matchResult;
    routeIndex = 0;
    path;
    bodyCache = {};
    constructor(request, path = "/", matchResult = [[]]) {
      this.raw = request;
      this.path = path;
      this.#matchResult = matchResult;
      this.#validatedData = {};
    }
    param(key) {
      return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
    }
    #getDecodedParam(key) {
      const paramKey = this.#matchResult[0][this.routeIndex][1][key];
      const param = this.#getParamValue(paramKey);
      return param && /\%/.test(param) ? tryDecodeURIComponent(param) : param;
    }
    #getAllDecodedParams() {
      const decoded = {};
      const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
      for (const key of keys) {
        const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
        if (value !== undefined) {
          decoded[key] = /\%/.test(value) ? tryDecodeURIComponent(value) : value;
        }
      }
      return decoded;
    }
    #getParamValue(paramKey) {
      return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
    }
    query(key) {
      return getQueryParam(this.url, key);
    }
    queries(key) {
      return getQueryParams(this.url, key);
    }
    header(name) {
      if (name) {
        return this.raw.headers.get(name) ?? undefined;
      }
      const headerData = {};
      this.raw.headers.forEach((value, key) => {
        headerData[key] = value;
      });
      return headerData;
    }
    async parseBody(options) {
      return this.bodyCache.parsedBody ??= await parseBody(this, options);
    }
    #cachedBody = (key) => {
      const { bodyCache, raw } = this;
      const cachedBody = bodyCache[key];
      if (cachedBody) {
        return cachedBody;
      }
      const anyCachedKey = Object.keys(bodyCache)[0];
      if (anyCachedKey) {
        return bodyCache[anyCachedKey].then((body) => {
          if (anyCachedKey === "json") {
            body = JSON.stringify(body);
          }
          return new Response(body)[key]();
        });
      }
      return bodyCache[key] = raw[key]();
    };
    json() {
      return this.#cachedBody("text").then((text) => JSON.parse(text));
    }
    text() {
      return this.#cachedBody("text");
    }
    arrayBuffer() {
      return this.#cachedBody("arrayBuffer");
    }
    blob() {
      return this.#cachedBody("blob");
    }
    formData() {
      return this.#cachedBody("formData");
    }
    addValidatedData(target, data) {
      this.#validatedData[target] = data;
    }
    valid(target) {
      return this.#validatedData[target];
    }
    get url() {
      return this.raw.url;
    }
    get method() {
      return this.raw.method;
    }
    get [GET_MATCH_RESULT]() {
      return this.#matchResult;
    }
    get matchedRoutes() {
      return this.#matchResult[0].map(([[, route]]) => route);
    }
    get routePath() {
      return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
    }
  };
});

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase, raw = (value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
}, resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then((res) => Promise.all(res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))).then(() => buffer[0]));
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
};
var init_html = __esm(() => {
  HtmlEscapedCallbackPhase = {
    Stringify: 1,
    BeforeStream: 2,
    Stream: 3
  };
});

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8", setDefaultContentType = (contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
}, createResponseInstance = (body, init) => new Response(body, init), Context = class {
  #rawRequest;
  #req;
  env = {};
  #var;
  finalized = false;
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers
    });
  }
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  setLayout = (layout) => this.#layout = layout;
  getLayout = () => this.#layout;
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  header = (name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers;
    if (value === undefined) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  };
  status = (status) => {
    this.#status = status;
  };
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map;
    this.#var.set(key, value);
  };
  get = (key) => {
    return this.#var ? this.#var.get(key) : undefined;
  };
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    const responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders ?? new Headers;
    if (typeof arg === "object" && "headers" in arg) {
      const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers(arg.headers);
      for (const [key, value] of argHeaders) {
        if (key.toLowerCase() === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          responseHeaders.set(k, v);
        } else {
          responseHeaders.delete(k);
          for (const v2 of v) {
            responseHeaders.append(k, v2);
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, { status, headers: responseHeaders });
  }
  newResponse = (...args) => this.#newResponse(...args);
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  text = (text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
  };
  json = (object, arg, headers) => {
    return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType("application/json", headers));
  };
  html = (html, arg, headers) => {
    const res = (html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  redirect = (location, status) => {
    const locationString = String(location);
    this.header("Location", !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
    return this.newResponse(null, status ?? 302);
  };
  notFound = () => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  };
};
var init_context = __esm(() => {
  init_request();
  init_html();
});

// node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL", METHOD_NAME_ALL_LOWERCASE = "all", METHODS, MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.", UnsupportedPathError;
var init_router = __esm(() => {
  METHODS = ["get", "post", "put", "delete", "options", "patch"];
  UnsupportedPathError = class extends Error {
  };
});

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";
var init_constants2 = () => {};

// node_modules/hono/dist/hono-base.js
var notFoundHandler = (c) => {
  return c.text("404 Not Found", 404);
}, errorHandler = (err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
}, Hono = class _Hono {
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  router;
  getPath;
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  errorHandler = errorHandler;
  route(path, app) {
    const subApp = this.basePath(path);
    app.routes.map((r) => {
      let handler;
      if (app.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler);
    });
    return this;
  }
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = (request) => request;
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = undefined;
      try {
        executionContext = c.executionCtx;
      } catch {}
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = url.pathname.slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    };
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = { basePath: this._basePath, path, method, handler };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
  };
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, undefined, event.request.method));
    });
  };
};
var init_hono_base = __esm(() => {
  init_compose();
  init_context();
  init_router();
  init_constants2();
  init_url();
});

// node_modules/hono/dist/router/reg-exp-router/matcher.js
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = (method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  };
  this.match = match2;
  return match2(method, path);
}
var emptyParam;
var init_matcher = __esm(() => {
  init_router();
  emptyParam = [];
});

// node_modules/hono/dist/router/reg-exp-router/node.js
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var LABEL_REG_EXP_STR = "[^/]+", ONLY_WILDCARD_REG_EXP_STR = ".*", TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)", PATH_ERROR, regExpMetaChars, Node = class _Node {
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, pathErrorCheckOnly) {
    if (tokens.length === 0) {
      if (this.#index !== undefined) {
        throw PATH_ERROR;
      }
      if (pathErrorCheckOnly) {
        return;
      }
      this.#index = index;
      return;
    }
    const [token, ...restTokens] = tokens;
    const pattern = token === "*" ? restTokens.length === 0 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
    let node;
    if (pattern) {
      const name = pattern[1];
      let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
      if (name && pattern[2]) {
        if (regexpStr === ".*") {
          throw PATH_ERROR;
        }
        regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
        if (/\((?!\?:)/.test(regexpStr)) {
          throw PATH_ERROR;
        }
      }
      node = this.#children[regexpStr];
      if (!node) {
        if (Object.keys(this.#children).some((k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR)) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[regexpStr] = new _Node;
        if (name !== "") {
          node.#varIndex = context.varIndex++;
        }
      }
      if (!pathErrorCheckOnly && name !== "") {
        paramMap.push([name, node.#varIndex]);
      }
    } else {
      node = this.#children[token];
      if (!node) {
        if (Object.keys(this.#children).some((k) => k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR)) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[token] = new _Node;
      }
    }
    node.insert(restTokens, index, paramMap, context, pathErrorCheckOnly);
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      return (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + c.buildRegExpStr();
    });
    if (typeof this.#index === "number") {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};
var init_node = __esm(() => {
  PATH_ERROR = /* @__PURE__ */ Symbol();
  regExpMetaChars = new Set(".\\+*[^]$()");
});

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  #context = { varIndex: 0 };
  #root = new Node;
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [];
    for (let i = 0;; ) {
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1;i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1;j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, index, paramAssoc, this.#context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== undefined) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== undefined) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};
var init_trie = __esm(() => {
  init_node();
});

// node_modules/hono/dist/router/reg-exp-router/router.js
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(path === "*" ? "" : `^${path.replace(/\/\*$|([.\\+*[^\]$()])/g, (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)")}$`);
}
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
function buildMatcherFromPreprocessedRoutes(routes) {
  const trie = new Trie;
  const handlerData = [];
  if (routes.length === 0) {
    return nullMatcher;
  }
  const routesWithStaticPathFlag = routes.map((route) => [!/\*|\/:/.test(route[0]), ...route]).sort(([isStaticA, pathA], [isStaticB, pathB]) => isStaticA ? 1 : isStaticB ? -1 : pathA.length - pathB.length);
  const staticMap = /* @__PURE__ */ Object.create(null);
  for (let i = 0, j = -1, len = routesWithStaticPathFlag.length;i < len; i++) {
    const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i];
    if (pathErrorCheckOnly) {
      staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
    } else {
      j++;
    }
    let paramAssoc;
    try {
      paramAssoc = trie.insert(path, j, pathErrorCheckOnly);
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
    if (pathErrorCheckOnly) {
      continue;
    }
    handlerData[j] = handlers.map(([h, paramCount]) => {
      const paramIndexMap = /* @__PURE__ */ Object.create(null);
      paramCount -= 1;
      for (;paramCount >= 0; paramCount--) {
        const [key, value] = paramAssoc[paramCount];
        paramIndexMap[key] = value;
      }
      return [h, paramIndexMap];
    });
  }
  const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
  for (let i = 0, len = handlerData.length;i < len; i++) {
    for (let j = 0, len2 = handlerData[i].length;j < len2; j++) {
      const map = handlerData[i][j]?.[1];
      if (!map) {
        continue;
      }
      const keys = Object.keys(map);
      for (let k = 0, len3 = keys.length;k < len3; k++) {
        map[keys[k]] = paramReplacementMap[map[keys[k]]];
      }
    }
  }
  const handlerMap = [];
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlerData[indexReplacementMap[i]];
  }
  return [regexp, handlerMap, staticMap];
}
function findMiddleware(middleware, path) {
  if (!middleware) {
    return;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return;
}
var nullMatcher, wildcardRegExpCache, RegExpRouter = class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      if (method === METHOD_NAME_ALL) {
        Object.keys(middleware).forEach((m) => {
          middleware[m][path] ||= findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        });
      } else {
        middleware[method][path] ||= findMiddleware(middleware[method], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
      }
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach((p) => re.test(p) && routes[m][p].push([handler, paramCount]));
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length;i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          routes[m][path2] ||= [
            ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
          ];
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = undefined;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const routes = [];
    let hasOwnRoute = method === METHOD_NAME_ALL;
    [this.#middleware, this.#routes].forEach((r) => {
      const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method][path]]) : [];
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true;
        routes.push(...ownRoute);
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(...Object.keys(r[METHOD_NAME_ALL]).map((path) => [path, r[METHOD_NAME_ALL][path]]));
      }
    });
    if (!hasOwnRoute) {
      return null;
    } else {
      return buildMatcherFromPreprocessedRoutes(routes);
    }
  }
};
var init_router2 = __esm(() => {
  init_router();
  init_url();
  init_matcher();
  init_node();
  init_trie();
  nullMatcher = [/^$/, [], /* @__PURE__ */ Object.create(null)];
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
});

// node_modules/hono/dist/router/reg-exp-router/prepared-router.js
var PreparedRegExpRouter = class {
  name = "PreparedRegExpRouter";
  #matchers;
  #relocateMap;
  constructor(matchers, relocateMap) {
    this.#matchers = matchers;
    this.#relocateMap = relocateMap;
  }
  #addWildcard(method, handlerData) {
    const matcher = this.#matchers[method];
    matcher[1].forEach((list) => list && list.push(handlerData));
    Object.values(matcher[2]).forEach((list) => list[0].push(handlerData));
  }
  #addPath(method, path, handler, indexes, map) {
    const matcher = this.#matchers[method];
    if (!map) {
      matcher[2][path][0].push([handler, {}]);
    } else {
      indexes.forEach((index) => {
        if (typeof index === "number") {
          matcher[1][index].push([handler, map]);
        } else {
          matcher[2][index || path][0].push([handler, map]);
        }
      });
    }
  }
  add(method, path, handler) {
    if (!this.#matchers[method]) {
      const all = this.#matchers[METHOD_NAME_ALL];
      const staticMap = {};
      for (const key in all[2]) {
        staticMap[key] = [all[2][key][0].slice(), emptyParam];
      }
      this.#matchers[method] = [
        all[0],
        all[1].map((list) => Array.isArray(list) ? list.slice() : 0),
        staticMap
      ];
    }
    if (path === "/*" || path === "*") {
      const handlerData = [handler, {}];
      if (method === METHOD_NAME_ALL) {
        for (const m in this.#matchers) {
          this.#addWildcard(m, handlerData);
        }
      } else {
        this.#addWildcard(method, handlerData);
      }
      return;
    }
    const data = this.#relocateMap[path];
    if (!data) {
      throw new Error(`Path ${path} is not registered`);
    }
    for (const [indexes, map] of data) {
      if (method === METHOD_NAME_ALL) {
        for (const m in this.#matchers) {
          this.#addPath(m, path, handler, indexes, map);
        }
      } else {
        this.#addPath(method, path, handler, indexes, map);
      }
    }
  }
  buildAllMatchers() {
    return this.#matchers;
  }
  match = match;
};
var init_prepared_router = __esm(() => {
  init_router();
  init_matcher();
  init_router2();
});

// node_modules/hono/dist/router/reg-exp-router/index.js
var init_reg_exp_router = __esm(() => {
  init_router2();
  init_prepared_router();
});

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (;i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length;i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = undefined;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
};
var init_router3 = __esm(() => {
  init_router();
});

// node_modules/hono/dist/router/smart-router/index.js
var init_smart_router = __esm(() => {
  init_router3();
});

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams, hasChildren = (children) => {
  for (const _ in children) {
    return true;
  }
  return false;
}, Node2 = class _Node2 {
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length;i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new _Node2;
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length;i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== undefined) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length;i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0;i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length;j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length;k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              this.#pushHandlerSets(handlerSets, astNode, method, node.#params);
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          if (matcher instanceof RegExp) {
            if (partOffsets === null) {
              partOffsets = new Array(len);
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0;p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.substring(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (hasChildren(child.#children)) {
                child.#params = params;
                const componentCount = m[0].match(/\//)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(handlerSets, child.#children["*"], method, params, node.#params);
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};
var init_node2 = __esm(() => {
  init_router();
  init_url();
  emptyParams = /* @__PURE__ */ Object.create(null);
});

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node2;
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length;i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};
var init_router4 = __esm(() => {
  init_url();
  init_node2();
});

// node_modules/hono/dist/router/trie-router/index.js
var init_trie_router = __esm(() => {
  init_router4();
});

// node_modules/hono/dist/hono.js
var Hono2;
var init_hono = __esm(() => {
  init_hono_base();
  init_reg_exp_router();
  init_smart_router();
  init_trie_router();
  Hono2 = class extends Hono {
    constructor(options = {}) {
      super(options);
      this.router = options.router ?? new SmartRouter({
        routers: [new RegExpRouter, new TrieRouter]
      });
    }
  };
});

// node_modules/hono/dist/index.js
var init_dist = __esm(() => {
  init_hono();
});

// node_modules/hono/dist/middleware/cors/index.js
var cors = (options) => {
  const defaults = {
    origin: "*",
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    allowHeaders: [],
    exposeHeaders: []
  };
  const opts = {
    ...defaults,
    ...options
  };
  const findAllowOrigin = ((optsOrigin) => {
    if (typeof optsOrigin === "string") {
      if (optsOrigin === "*") {
        return () => optsOrigin;
      } else {
        return (origin) => optsOrigin === origin ? origin : null;
      }
    } else if (typeof optsOrigin === "function") {
      return optsOrigin;
    } else {
      return (origin) => optsOrigin.includes(origin) ? origin : null;
    }
  })(opts.origin);
  const findAllowMethods = ((optsAllowMethods) => {
    if (typeof optsAllowMethods === "function") {
      return optsAllowMethods;
    } else if (Array.isArray(optsAllowMethods)) {
      return () => optsAllowMethods;
    } else {
      return () => [];
    }
  })(opts.allowMethods);
  return async function cors2(c, next) {
    function set(key, value) {
      c.res.headers.set(key, value);
    }
    const allowOrigin = await findAllowOrigin(c.req.header("origin") || "", c);
    if (allowOrigin) {
      set("Access-Control-Allow-Origin", allowOrigin);
    }
    if (opts.credentials) {
      set("Access-Control-Allow-Credentials", "true");
    }
    if (opts.exposeHeaders?.length) {
      set("Access-Control-Expose-Headers", opts.exposeHeaders.join(","));
    }
    if (c.req.method === "OPTIONS") {
      if (opts.origin !== "*") {
        set("Vary", "Origin");
      }
      if (opts.maxAge != null) {
        set("Access-Control-Max-Age", opts.maxAge.toString());
      }
      const allowMethods = await findAllowMethods(c.req.header("origin") || "", c);
      if (allowMethods.length) {
        set("Access-Control-Allow-Methods", allowMethods.join(","));
      }
      let headers = opts.allowHeaders;
      if (!headers?.length) {
        const requestHeaders = c.req.header("Access-Control-Request-Headers");
        if (requestHeaders) {
          headers = requestHeaders.split(/\s*,\s*/);
        }
      }
      if (headers?.length) {
        set("Access-Control-Allow-Headers", headers.join(","));
        c.res.headers.append("Vary", "Access-Control-Request-Headers");
      }
      c.res.headers.delete("Content-Length");
      c.res.headers.delete("Content-Type");
      return new Response(null, {
        headers: c.res.headers,
        status: 204,
        statusText: "No Content"
      });
    }
    await next();
    if (opts.origin !== "*") {
      c.header("Vary", "Origin", { append: true });
    }
  };
};
var init_cors = () => {};

// node_modules/hono/dist/utils/compress.js
var COMPRESSIBLE_CONTENT_TYPE_REGEX;
var init_compress = __esm(() => {
  COMPRESSIBLE_CONTENT_TYPE_REGEX = /^\s*(?:text\/(?!event-stream(?:[;\s]|$))[^;\s]+|application\/(?:javascript|json|xml|xml-dtd|ecmascript|dart|postscript|rtf|tar|toml|vnd\.dart|vnd\.ms-fontobject|vnd\.ms-opentype|wasm|x-httpd-php|x-javascript|x-ns-proxy-autoconfig|x-sh|x-tar|x-virtualbox-hdd|x-virtualbox-ova|x-virtualbox-ovf|x-virtualbox-vbox|x-virtualbox-vdi|x-virtualbox-vhd|x-virtualbox-vmdk|x-www-form-urlencoded)|font\/(?:otf|ttf)|image\/(?:bmp|vnd\.adobe\.photoshop|vnd\.microsoft\.icon|vnd\.ms-dds|x-icon|x-ms-bmp)|message\/rfc822|model\/gltf-binary|x-shader\/x-fragment|x-shader\/x-vertex|[^;\s]+?\+(?:json|text|xml|yaml))(?:[;\s]|$)/i;
});

// node_modules/hono/dist/utils/mime.js
var getMimeType = (filename, mimes = baseMimes) => {
  const regexp = /\.([a-zA-Z0-9]+?)$/;
  const match2 = filename.match(regexp);
  if (!match2) {
    return;
  }
  let mimeType = mimes[match2[1]];
  if (mimeType && mimeType.startsWith("text")) {
    mimeType += "; charset=utf-8";
  }
  return mimeType;
}, _baseMimes, baseMimes;
var init_mime = __esm(() => {
  _baseMimes = {
    aac: "audio/aac",
    avi: "video/x-msvideo",
    avif: "image/avif",
    av1: "video/av1",
    bin: "application/octet-stream",
    bmp: "image/bmp",
    css: "text/css",
    csv: "text/csv",
    eot: "application/vnd.ms-fontobject",
    epub: "application/epub+zip",
    gif: "image/gif",
    gz: "application/gzip",
    htm: "text/html",
    html: "text/html",
    ico: "image/x-icon",
    ics: "text/calendar",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    json: "application/json",
    jsonld: "application/ld+json",
    map: "application/json",
    mid: "audio/x-midi",
    midi: "audio/x-midi",
    mjs: "text/javascript",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mpeg: "video/mpeg",
    oga: "audio/ogg",
    ogv: "video/ogg",
    ogx: "application/ogg",
    opus: "audio/opus",
    otf: "font/otf",
    pdf: "application/pdf",
    png: "image/png",
    rtf: "application/rtf",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
    ts: "video/mp2t",
    ttf: "font/ttf",
    txt: "text/plain",
    wasm: "application/wasm",
    webm: "video/webm",
    weba: "audio/webm",
    webmanifest: "application/manifest+json",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    xhtml: "application/xhtml+xml",
    xml: "application/xml",
    zip: "application/zip",
    "3gp": "video/3gpp",
    "3g2": "video/3gpp2",
    gltf: "model/gltf+json",
    glb: "model/gltf-binary"
  };
  baseMimes = _baseMimes;
});

// node_modules/hono/dist/middleware/serve-static/path.js
var defaultJoin = (...paths) => {
  let result = paths.filter((p) => p !== "").join("/");
  result = result.replace(/(?<=\/)\/+/g, "");
  const segments = result.split("/");
  const resolved = [];
  for (const segment of segments) {
    if (segment === ".." && resolved.length > 0 && resolved.at(-1) !== "..") {
      resolved.pop();
    } else if (segment !== ".") {
      resolved.push(segment);
    }
  }
  return resolved.join("/") || ".";
};
var init_path = () => {};

// node_modules/hono/dist/middleware/serve-static/index.js
var ENCODINGS, ENCODINGS_ORDERED_KEYS, DEFAULT_DOCUMENT = "index.html", serveStatic = (options) => {
  const root = options.root ?? "./";
  const optionPath = options.path;
  const join12 = options.join ?? defaultJoin;
  return async (c, next) => {
    if (c.finalized) {
      return next();
    }
    let filename;
    if (options.path) {
      filename = options.path;
    } else {
      try {
        filename = tryDecodeURI(c.req.path);
        if (/(?:^|[\/\\])\.\.(?:$|[\/\\])/.test(filename)) {
          throw new Error;
        }
      } catch {
        await options.onNotFound?.(c.req.path, c);
        return next();
      }
    }
    let path = join12(root, !optionPath && options.rewriteRequestPath ? options.rewriteRequestPath(filename) : filename);
    if (options.isDir && await options.isDir(path)) {
      path = join12(path, DEFAULT_DOCUMENT);
    }
    const getContent = options.getContent;
    let content = await getContent(path, c);
    if (content instanceof Response) {
      return c.newResponse(content.body, content);
    }
    if (content) {
      const mimeType = options.mimes && getMimeType(path, options.mimes) || getMimeType(path);
      c.header("Content-Type", mimeType || "application/octet-stream");
      if (options.precompressed && (!mimeType || COMPRESSIBLE_CONTENT_TYPE_REGEX.test(mimeType))) {
        const acceptEncodingSet = new Set(c.req.header("Accept-Encoding")?.split(",").map((encoding) => encoding.trim()));
        for (const encoding of ENCODINGS_ORDERED_KEYS) {
          if (!acceptEncodingSet.has(encoding)) {
            continue;
          }
          const compressedContent = await getContent(path + ENCODINGS[encoding], c);
          if (compressedContent) {
            content = compressedContent;
            c.header("Content-Encoding", encoding);
            c.header("Vary", "Accept-Encoding", { append: true });
            break;
          }
        }
      }
      await options.onFound?.(path, c);
      return c.body(content);
    }
    await options.onNotFound?.(path, c);
    await next();
    return;
  };
};
var init_serve_static = __esm(() => {
  init_compress();
  init_mime();
  init_url();
  init_path();
  ENCODINGS = {
    br: ".br",
    zstd: ".zst",
    gzip: ".gz"
  };
  ENCODINGS_ORDERED_KEYS = Object.keys(ENCODINGS);
});

// node_modules/hono/dist/adapter/bun/serve-static.js
import { stat } from "fs/promises";
import { join as join12 } from "path";
var serveStatic2 = (options) => {
  return async function serveStatic22(c, next) {
    const getContent = async (path) => {
      const file = Bun.file(path);
      return await file.exists() ? file : null;
    };
    const isDir = async (path) => {
      let isDir2;
      try {
        const stats = await stat(path);
        isDir2 = stats.isDirectory();
      } catch {}
      return isDir2;
    };
    return serveStatic({
      ...options,
      getContent,
      join: join12,
      isDir
    })(c, next);
  };
};
var init_serve_static2 = __esm(() => {
  init_serve_static();
});

// node_modules/hono/dist/client/fetch-result-please.js
var init_fetch_result_please = () => {};

// node_modules/hono/dist/client/utils.js
var init_utils = __esm(() => {
  init_fetch_result_please();
});

// node_modules/hono/dist/utils/concurrent.js
var init_concurrent = () => {};

// node_modules/hono/dist/utils/handler.js
var init_handler = __esm(() => {
  init_constants2();
});

// node_modules/hono/dist/helper/ssg/utils.js
var init_utils2 = __esm(() => {
  init_router();
  init_handler();
});

// node_modules/hono/dist/helper/ssg/middleware.js
var X_HONO_DISABLE_SSG_HEADER_KEY = "x-hono-disable-ssg", SSG_DISABLED_RESPONSE;
var init_middleware = __esm(() => {
  init_utils2();
  SSG_DISABLED_RESPONSE = (() => {
    try {
      return new Response("SSG is disabled", {
        status: 404,
        headers: { [X_HONO_DISABLE_SSG_HEADER_KEY]: "true" }
      });
    } catch {
      return null;
    }
  })();
});

// node_modules/hono/dist/helper/html/index.js
var init_html2 = __esm(() => {
  init_html();
});

// node_modules/hono/dist/helper/ssg/plugins.js
var init_plugins = __esm(() => {
  init_html2();
});

// node_modules/hono/dist/helper/ssg/ssg.js
var init_ssg = __esm(() => {
  init_utils();
  init_concurrent();
  init_mime();
  init_middleware();
  init_plugins();
  init_utils2();
});

// node_modules/hono/dist/helper/ssg/index.js
var init_ssg2 = __esm(() => {
  init_middleware();
  init_plugins();
  init_ssg();
});

// node_modules/hono/dist/adapter/bun/ssg.js
var write;
var init_ssg3 = __esm(() => {
  init_ssg2();
  ({ write } = Bun);
});

// node_modules/hono/dist/helper/websocket/index.js
var WSContext = class {
  #init;
  constructor(init) {
    this.#init = init;
    this.raw = init.raw;
    this.url = init.url ? new URL(init.url) : null;
    this.protocol = init.protocol ?? null;
  }
  send(source, options) {
    this.#init.send(source, options ?? {});
  }
  raw;
  binaryType = "arraybuffer";
  get readyState() {
    return this.#init.readyState;
  }
  url;
  protocol;
  close(code, reason) {
    this.#init.close(code, reason);
  }
}, defineWebSocketHelper = (handler) => {
  return (...args) => {
    if (typeof args[0] === "function") {
      const [createEvents, options] = args;
      return async function upgradeWebSocket(c, next) {
        const events = await createEvents(c);
        const result = await handler(c, events, options);
        if (result) {
          return result;
        }
        await next();
      };
    } else {
      const [c, events, options] = args;
      return (async () => {
        const upgraded = await handler(c, events, options);
        if (!upgraded) {
          throw new Error("Failed to upgrade WebSocket");
        }
        return upgraded;
      })();
    }
  };
};
var init_websocket = () => {};

// node_modules/hono/dist/adapter/bun/server.js
var getBunServer = (c) => ("server" in c.env) ? c.env.server : c.env;
var init_server = () => {};

// node_modules/hono/dist/adapter/bun/websocket.js
var upgradeWebSocket;
var init_websocket2 = __esm(() => {
  init_websocket();
  init_server();
  upgradeWebSocket = defineWebSocketHelper((c, events) => {
    const server = getBunServer(c);
    if (!server) {
      throw new TypeError("env has to include the 2nd argument of fetch.");
    }
    const upgradeResult = server.upgrade(c.req.raw, {
      data: {
        events,
        url: new URL(c.req.url),
        protocol: c.req.url
      }
    });
    if (upgradeResult) {
      return new Response(null);
    }
    return;
  });
});

// node_modules/hono/dist/adapter/bun/conninfo.js
var init_conninfo = __esm(() => {
  init_server();
});

// node_modules/hono/dist/adapter/bun/index.js
var init_bun = __esm(() => {
  init_serve_static2();
  init_ssg3();
  init_websocket2();
  init_conninfo();
  init_server();
});

// src/lib/feed.ts
function parseLine(line) {
  if (!line || !line.includes(" | "))
    return null;
  const parts = line.split(" | ").map((s) => s.trim());
  if (parts.length < 5)
    return null;
  const timestamp = parts[0];
  const oracle = parts[1];
  const host = parts[2];
  const event = parts[3];
  const project = parts[4];
  const rest = parts.slice(5).join(" | ");
  let sessionId = "";
  let message = "";
  const guiIdx = rest.indexOf(" \xBB ");
  if (guiIdx !== -1) {
    sessionId = rest.slice(0, guiIdx).trim();
    message = rest.slice(guiIdx + 3).trim();
  } else {
    sessionId = rest.trim();
  }
  const ts = new Date(timestamp.replace(" ", "T") + "+07:00").getTime();
  if (isNaN(ts))
    return null;
  return { timestamp, oracle, host, event, project, sessionId, message, ts };
}
function activeOracles(events, windowMs = 5 * 60000) {
  const cutoff = Date.now() - windowMs;
  const map = new Map;
  for (const e of events) {
    if (e.ts < cutoff)
      continue;
    const prev = map.get(e.oracle);
    if (!prev || e.ts > prev.ts)
      map.set(e.oracle, e);
  }
  return map;
}
var init_feed = () => {};

// src/feed-tail.ts
import { statSync, openSync, readSync, closeSync } from "fs";
import { join as join13 } from "path";

class FeedTailer {
  path;
  maxBuffer;
  offset = 0;
  buffer = [];
  listeners = new Set;
  timer = null;
  constructor(path, maxBuffer) {
    this.path = path || DEFAULT_PATH;
    this.maxBuffer = maxBuffer || DEFAULT_MAX_BUFFER;
  }
  start() {
    if (this.timer)
      return;
    try {
      const file = Bun.file(this.path);
      const size = file.size;
      if (size > 0) {
        const chunkSize = Math.min(size, 1e5);
        const fd = openSync(this.path, "r");
        const buf = Buffer.alloc(chunkSize);
        readSync(fd, buf, 0, chunkSize, size - chunkSize);
        closeSync(fd);
        const text = buf.toString("utf-8");
        const lines = text.split(`
`).filter(Boolean);
        const tail = lines.slice(-this.maxBuffer);
        for (const line of tail) {
          const event = parseLine(line);
          if (event)
            this.buffer.push(event);
        }
        if (this.buffer.length > this.maxBuffer) {
          this.buffer = this.buffer.slice(-this.maxBuffer);
        }
        this.offset = size;
      }
    } catch {
      this.offset = 0;
    }
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  onEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  getRecent(n) {
    const count = n || this.maxBuffer;
    return this.buffer.slice(-count);
  }
  getActive(windowMs) {
    return activeOracles(this.buffer, windowMs);
  }
  poll() {
    try {
      const stat2 = statSync(this.path);
      const size = stat2.size;
      if (size < this.offset) {
        this.offset = 0;
      }
      if (size <= this.offset)
        return;
      const newBytes = size - this.offset;
      const fd = openSync(this.path, "r");
      const buf = Buffer.alloc(newBytes);
      readSync(fd, buf, 0, newBytes, this.offset);
      closeSync(fd);
      this.offset = size;
      const text = buf.toString("utf-8");
      const lines = text.split(`
`).filter(Boolean);
      for (const line of lines) {
        const event = parseLine(line);
        if (!event)
          continue;
        this.buffer.push(event);
        for (const cb of this.listeners) {
          try {
            cb(event);
          } catch {}
        }
      }
      if (this.buffer.length > this.maxBuffer) {
        this.buffer = this.buffer.slice(-this.maxBuffer);
      }
    } catch {}
  }
}
var DEFAULT_PATH, POLL_MS = 1000, DEFAULT_MAX_BUFFER = 200;
var init_feed_tail = __esm(() => {
  init_feed();
  DEFAULT_PATH = join13(process.env.HOME || "/home/nat", ".oracle", "feed.log");
});

// src/handlers.ts
async function runAction(ws, action, target, fn) {
  try {
    await fn();
    ws.send(JSON.stringify({ type: "action-ok", action, target }));
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
}
function registerBuiltinHandlers(engine) {
  engine.on("subscribe", subscribe);
  engine.on("subscribe-previews", subscribePreviews);
  engine.on("select", select);
  engine.on("send", send);
  engine.on("sleep", sleep);
  engine.on("stop", stop);
  engine.on("wake", wake);
  engine.on("restart", restart);
}
var subscribe = (ws, data, engine) => {
  ws.data.target = data.target;
  engine.pushCapture(ws);
}, subscribePreviews = (ws, data, engine) => {
  ws.data.previewTargets = new Set(data.targets || []);
  engine.pushPreviews(ws);
}, select = (_ws, data) => {
  selectWindow(data.target).catch(() => {});
}, send = async (ws, data, engine) => {
  if (!data.force) {
    try {
      const cmd = await getPaneCommand(data.target);
      if (!/claude|codex|node/i.test(cmd)) {
        ws.send(JSON.stringify({ type: "error", error: `no active Claude session in ${data.target} (running: ${cmd})` }));
        return;
      }
    } catch {}
  }
  sendKeys(data.target, data.text).then(() => {
    ws.send(JSON.stringify({ type: "sent", ok: true, target: data.target, text: data.text }));
    setTimeout(() => engine.pushCapture(ws), 300);
  }).catch((e) => ws.send(JSON.stringify({ type: "error", error: e.message })));
}, sleep = (ws, data) => {
  runAction(ws, "sleep", data.target, () => sendKeys(data.target, "\x03"));
}, stop = (ws, data) => {
  runAction(ws, "stop", data.target, () => ssh(`tmux kill-window -t '${data.target}'`));
}, wake = (ws, data) => {
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  runAction(ws, "wake", data.target, () => sendKeys(data.target, cmd + "\r"));
}, restart = (ws, data) => {
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  runAction(ws, "restart", data.target, async () => {
    await sendKeys(data.target, "\x03");
    await new Promise((r) => setTimeout(r, 2000));
    await sendKeys(data.target, "\x03");
    await new Promise((r) => setTimeout(r, 500));
    await sendKeys(data.target, cmd + "\r");
  });
};
var init_handlers = __esm(() => {
  init_ssh();
  init_config();
});

// src/engine.ts
class MawEngine {
  clients = new Set;
  handlers = new Map;
  lastContent = new Map;
  lastPreviews = new Map;
  lastSessionsJson = "";
  cachedSessions = [];
  captureInterval = null;
  sessionInterval = null;
  previewInterval = null;
  feedUnsub = null;
  feedTailer;
  constructor({ feedTailer }) {
    this.feedTailer = feedTailer;
    registerBuiltinHandlers(this);
  }
  on(type, handler) {
    this.handlers.set(type, handler);
  }
  handleOpen(ws) {
    this.clients.add(ws);
    this.startIntervals();
    if (this.cachedSessions.length > 0) {
      ws.send(JSON.stringify({ type: "sessions", sessions: this.cachedSessions }));
      this.sendBusyAgents(ws);
    } else {
      tmux.listAll().then((sessions) => {
        this.cachedSessions = sessions;
        ws.send(JSON.stringify({ type: "sessions", sessions }));
        this.sendBusyAgents(ws);
      }).catch(() => {});
    }
    ws.send(JSON.stringify({ type: "feed-history", events: this.feedTailer.getRecent(50) }));
  }
  async sendBusyAgents(ws) {
    const allTargets = this.cachedSessions.flatMap((s) => s.windows.map((w) => `${s.name}:${w.index}`));
    const cmds = await tmux.getPaneCommands(allTargets);
    const busy = allTargets.filter((t) => /claude|codex|node/i.test(cmds[t] || "")).map((t) => {
      const [session] = t.split(":");
      const s = this.cachedSessions.find((x) => x.name === session);
      const w = s?.windows.find((w2) => `${s.name}:${w2.index}` === t);
      return { target: t, name: w?.name || t, session };
    });
    if (busy.length > 0) {
      ws.send(JSON.stringify({ type: "recent", agents: busy }));
    }
  }
  handleMessage(ws, msg) {
    try {
      const data = JSON.parse(msg);
      const handler = this.handlers.get(data.type);
      if (handler)
        handler(ws, data, this);
    } catch {}
  }
  handleClose(ws) {
    this.clients.delete(ws);
    this.lastContent.delete(ws);
    this.lastPreviews.delete(ws);
    this.stopIntervals();
  }
  async pushCapture(ws) {
    if (!ws.data.target)
      return;
    try {
      const content = await capture(ws.data.target, 80);
      const prev = this.lastContent.get(ws);
      if (content !== prev) {
        this.lastContent.set(ws, content);
        ws.send(JSON.stringify({ type: "capture", target: ws.data.target, content }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: e.message }));
    }
  }
  async pushPreviews(ws) {
    const targets = ws.data.previewTargets;
    if (!targets || targets.size === 0)
      return;
    const prevMap = this.lastPreviews.get(ws) || new Map;
    const changed = {};
    let hasChanges = false;
    await Promise.allSettled([...targets].map(async (target) => {
      try {
        const content = await capture(target, 3);
        const prev = prevMap.get(target);
        if (content !== prev) {
          prevMap.set(target, content);
          changed[target] = content;
          hasChanges = true;
        }
      } catch {}
    }));
    this.lastPreviews.set(ws, prevMap);
    if (hasChanges) {
      ws.send(JSON.stringify({ type: "previews", data: changed }));
    }
  }
  async broadcastSessions() {
    if (this.clients.size === 0)
      return;
    try {
      const sessions = await tmux.listAll();
      this.cachedSessions = sessions;
      const json = JSON.stringify(sessions);
      if (json === this.lastSessionsJson)
        return;
      this.lastSessionsJson = json;
      const msg = JSON.stringify({ type: "sessions", sessions });
      for (const ws of this.clients)
        ws.send(msg);
    } catch {}
  }
  startIntervals() {
    if (this.captureInterval)
      return;
    this.captureInterval = setInterval(() => {
      for (const ws of this.clients)
        this.pushCapture(ws);
    }, 50);
    this.sessionInterval = setInterval(() => this.broadcastSessions(), 5000);
    this.previewInterval = setInterval(() => {
      for (const ws of this.clients)
        this.pushPreviews(ws);
    }, 2000);
    this.feedTailer.start();
    this.feedUnsub = this.feedTailer.onEvent((event) => {
      const msg = JSON.stringify({ type: "feed", event });
      for (const ws of this.clients)
        ws.send(msg);
    });
  }
  stopIntervals() {
    if (this.clients.size > 0)
      return;
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }
    if (this.sessionInterval) {
      clearInterval(this.sessionInterval);
      this.sessionInterval = null;
    }
    if (this.previewInterval) {
      clearInterval(this.previewInterval);
      this.previewInterval = null;
    }
    if (this.feedUnsub) {
      this.feedUnsub();
      this.feedUnsub = null;
    }
    this.feedTailer.stop();
  }
}
var init_engine = __esm(() => {
  init_ssh();
  init_tmux();
  init_handlers();
});

// src/pty.ts
function isLocalHost() {
  const host = process.env.MAW_HOST || loadConfig().host || "white.local";
  return host === "local" || host === "localhost";
}
function findSession(ws) {
  for (const s of sessions.values()) {
    if (s.viewers.has(ws))
      return s;
  }
}
function handlePtyMessage(ws, msg) {
  if (typeof msg !== "string") {
    const session = findSession(ws);
    if (session?.proc.stdin) {
      session.proc.stdin.write(msg);
      session.proc.stdin.flush();
    }
    return;
  }
  try {
    const data = JSON.parse(msg);
    if (data.type === "attach")
      attach(ws, data.target, data.cols || 120, data.rows || 40);
    else if (data.type === "resize")
      resize(ws, data.cols, data.rows);
    else if (data.type === "detach")
      detach(ws);
  } catch {}
}
function handlePtyClose(ws) {
  detach(ws);
}
async function attach(ws, target, cols, rows) {
  const safe = target.replace(/[^a-zA-Z0-9\-_:.]/g, "");
  if (!safe)
    return;
  detach(ws);
  let session = sessions.get(safe);
  if (session) {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    session.viewers.add(ws);
    ws.send(JSON.stringify({ type: "attached", target: safe }));
    return;
  }
  const sessionName = safe.split(":")[0];
  const windowPart = safe.includes(":") ? safe.split(":").slice(1).join(":") : "";
  const c = Math.max(1, Math.min(500, Math.floor(cols)));
  const r = Math.max(1, Math.min(200, Math.floor(rows)));
  const ptySessionName = `maw-pty-${++nextPtyId}`;
  try {
    await tmux.newGroupedSession(sessionName, ptySessionName, {
      cols: c,
      rows: r,
      window: windowPart || undefined
    });
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Failed to create PTY session" }));
    return;
  }
  let args;
  if (isLocalHost()) {
    const cmd = `stty rows ${r} cols ${c} 2>/dev/null; TERM=xterm-256color tmux attach-session -t '${ptySessionName}'`;
    args = ["script", "-qfc", cmd, "/dev/null"];
  } else {
    const host = process.env.MAW_HOST || loadConfig().host || "white.local";
    args = ["ssh", "-tt", host, `TERM=xterm-256color tmux attach-session -t '${ptySessionName}'`];
  }
  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, TERM: "xterm-256color" }
  });
  session = { proc, target: safe, ptySessionName, viewers: new Set([ws]), cleanupTimer: null };
  sessions.set(safe, session);
  ws.send(JSON.stringify({ type: "attached", target: safe }));
  const s = session;
  const reader = proc.stdout.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        for (const v of s.viewers) {
          try {
            v.send(value);
          } catch {}
        }
      }
    } catch {}
    sessions.delete(safe);
    tmux.killSession(s.ptySessionName);
    for (const v of s.viewers) {
      try {
        v.send(JSON.stringify({ type: "detached", target: safe }));
      } catch {}
    }
  })();
}
function resize(_ws, _cols, _rows) {}
function detach(ws) {
  for (const [target, session] of sessions) {
    if (!session.viewers.has(ws))
      continue;
    session.viewers.delete(ws);
    if (session.viewers.size === 0) {
      session.cleanupTimer = setTimeout(() => {
        try {
          session.proc.kill();
        } catch {}
        tmux.killSession(session.ptySessionName);
        sessions.delete(target);
      }, 5000);
    }
  }
}
var nextPtyId = 0, sessions;
var init_pty = __esm(() => {
  init_tmux();
  init_config();
  sessions = new Map;
});

// src/server.ts
var exports_server = {};
__export(exports_server, {
  startServer: () => startServer,
  app: () => app
});
import { readdirSync as readdirSync7, readFileSync as readFileSync8, writeFileSync as writeFileSync3, renameSync as renameSync2, unlinkSync, existsSync as existsSync4 } from "fs";
import { join as join14, basename } from "path";
function startServer(port = +(process.env.MAW_PORT || loadConfig().port || 3456)) {
  const engine = new MawEngine({ feedTailer });
  const server = Bun.serve({
    port,
    fetch(req, server2) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/pty") {
        if (server2.upgrade(req, { data: { target: null, previewTargets: new Set, mode: "pty" } }))
          return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/ws") {
        if (server2.upgrade(req, { data: { target: null, previewTargets: new Set } }))
          return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return app.fetch(req);
    },
    websocket: {
      open: (ws) => {
        if (ws.data.mode === "pty")
          return;
        engine.handleOpen(ws);
      },
      message: (ws, msg) => {
        if (ws.data.mode === "pty") {
          handlePtyMessage(ws, msg);
          return;
        }
        engine.handleMessage(ws, msg);
      },
      close: (ws) => {
        if (ws.data.mode === "pty") {
          handlePtyClose(ws);
          return;
        }
        engine.handleClose(ws);
      }
    }
  });
  console.log(`maw serve \u2192 http://localhost:${port} (ws://localhost:${port}/ws)`);
  return server;
}
var app, ORACLE_URL, uiStatePath, asksPath, fleetDir, feedTailer;
var init_server2 = __esm(() => {
  init_dist();
  init_cors();
  init_bun();
  init_ssh();
  init_overview();
  init_feed_tail();
  init_engine();
  init_config();
  init_worktrees();
  init_pty();
  app = new Hono2;
  app.use("/api/*", cors());
  app.get("/api/sessions", async (c) => c.json(await listSessions()));
  app.get("/api/capture", async (c) => {
    const target = c.req.query("target");
    if (!target)
      return c.json({ error: "target required" }, 400);
    try {
      return c.json({ content: await capture(target) });
    } catch (e) {
      return c.json({ content: "", error: e.message });
    }
  });
  app.get("/api/mirror", async (c) => {
    const target = c.req.query("target");
    if (!target)
      return c.text("target required", 400);
    const lines = +(c.req.query("lines") || "40");
    const raw2 = await capture(target);
    return c.text(processMirror(raw2, lines));
  });
  app.post("/api/send", async (c) => {
    const { target, text } = await c.req.json();
    if (!target || !text)
      return c.json({ error: "target and text required" }, 400);
    await sendKeys(target, text);
    return c.json({ ok: true, target, text });
  });
  app.post("/api/select", async (c) => {
    const { target } = await c.req.json();
    if (!target)
      return c.json({ error: "target required" }, 400);
    await selectWindow(target);
    return c.json({ ok: true, target });
  });
  app.get("/", serveStatic2({ root: "./dist-office", path: "/index.html" }));
  app.get("/dashboard", (c) => c.redirect("/#orbital"));
  app.get("/office", (c) => c.redirect("/#office"));
  app.get("/assets/*", serveStatic2({ root: "./dist-office" }));
  app.get("/office/*", serveStatic2({
    root: "./",
    rewriteRequestPath: (p) => p.replace(/^\/office/, "/dist-office")
  }));
  app.get("/office-8bit", serveStatic2({ root: "./dist-8bit-office", path: "/index.html" }));
  app.get("/office-8bit/*", serveStatic2({
    root: "./",
    rewriteRequestPath: (p) => p.replace(/^\/office-8bit/, "/dist-8bit-office")
  }));
  app.get("/war-room", serveStatic2({ root: "./dist-war-room", path: "/index.html" }));
  app.get("/war-room/*", serveStatic2({
    root: "./",
    rewriteRequestPath: (p) => p.replace(/^\/war-room/, "/dist-war-room")
  }));
  app.get("/race-track", serveStatic2({ root: "./dist-race-track", path: "/index.html" }));
  app.get("/race-track/*", serveStatic2({
    root: "./",
    rewriteRequestPath: (p) => p.replace(/^\/race-track/, "/dist-race-track")
  }));
  app.get("/superman", serveStatic2({ root: "./dist-superman", path: "/index.html" }));
  app.get("/superman/*", serveStatic2({
    root: "./",
    rewriteRequestPath: (p) => p.replace(/^\/superman/, "/dist-superman")
  }));
  ORACLE_URL = process.env.ORACLE_URL || loadConfig().oracleUrl;
  app.get("/api/oracle/search", async (c) => {
    const q2 = c.req.query("q");
    if (!q2)
      return c.json({ error: "q required" }, 400);
    const params = new URLSearchParams({ q: q2, mode: c.req.query("mode") || "hybrid", limit: c.req.query("limit") || "10" });
    const model = c.req.query("model");
    if (model)
      params.set("model", model);
    try {
      const res = await fetch(`${ORACLE_URL}/api/search?${params}`);
      return c.json(await res.json());
    } catch (e) {
      return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
    }
  });
  app.get("/api/oracle/traces", async (c) => {
    const limit = c.req.query("limit") || "10";
    try {
      const res = await fetch(`${ORACLE_URL}/api/traces?limit=${limit}`);
      return c.json(await res.json());
    } catch (e) {
      return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
    }
  });
  app.get("/api/oracle/stats", async (c) => {
    try {
      const res = await fetch(`${ORACLE_URL}/api/stats`);
      return c.json(await res.json());
    } catch (e) {
      return c.json({ error: `Oracle unreachable: ${e.message}` }, 502);
    }
  });
  uiStatePath = join14(import.meta.dir, "../ui-state.json");
  app.get("/api/ui-state", (c) => {
    try {
      if (!existsSync4(uiStatePath))
        return c.json({});
      return c.json(JSON.parse(readFileSync8(uiStatePath, "utf-8")));
    } catch {
      return c.json({});
    }
  });
  app.post("/api/ui-state", async (c) => {
    try {
      const body = await c.req.json();
      writeFileSync3(uiStatePath, JSON.stringify(body, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e.message }, 400);
    }
  });
  asksPath = join14(import.meta.dir, "../asks.json");
  app.get("/api/asks", (c) => {
    try {
      if (!existsSync4(asksPath))
        return c.json([]);
      return c.json(JSON.parse(readFileSync8(asksPath, "utf-8")));
    } catch {
      return c.json([]);
    }
  });
  app.post("/api/asks", async (c) => {
    try {
      const body = await c.req.json();
      writeFileSync3(asksPath, JSON.stringify(body, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e.message }, 400);
    }
  });
  fleetDir = join14(import.meta.dir, "../fleet");
  app.get("/api/fleet-config", (c) => {
    try {
      const files = readdirSync7(fleetDir).filter((f) => f.endsWith(".json") && !f.endsWith(".disabled"));
      const configs = files.map((f) => JSON.parse(readFileSync8(join14(fleetDir, f), "utf-8")));
      return c.json({ configs });
    } catch (e) {
      return c.json({ configs: [], error: e.message });
    }
  });
  app.get("/api/config-files", (c) => {
    const files = [
      { name: "maw.config.json", path: "maw.config.json", enabled: true }
    ];
    try {
      const entries = readdirSync7(fleetDir).filter((f) => f.endsWith(".json") || f.endsWith(".json.disabled")).sort();
      for (const f of entries) {
        const enabled = !f.endsWith(".disabled");
        files.push({ name: f, path: `fleet/${f}`, enabled });
      }
    } catch {}
    return c.json({ files });
  });
  app.get("/api/config-file", (c) => {
    const filePath = c.req.query("path");
    if (!filePath)
      return c.json({ error: "path required" }, 400);
    const fullPath = join14(import.meta.dir, "..", filePath);
    if (!existsSync4(fullPath))
      return c.json({ error: "not found" }, 404);
    try {
      const content = readFileSync8(fullPath, "utf-8");
      if (filePath === "maw.config.json") {
        const data = JSON.parse(content);
        const display = configForDisplay();
        data.env = display.envMasked;
        return c.json({ content: JSON.stringify(data, null, 2) });
      }
      return c.json({ content });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });
  app.post("/api/config-file", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath)
      return c.json({ error: "path required" }, 400);
    if (filePath !== "maw.config.json" && !filePath.startsWith("fleet/")) {
      return c.json({ error: "invalid path" }, 403);
    }
    try {
      const { content } = await c.req.json();
      JSON.parse(content);
      const fullPath = join14(import.meta.dir, "..", filePath);
      if (filePath === "maw.config.json") {
        const parsed = JSON.parse(content);
        if (parsed.env && typeof parsed.env === "object") {
          const current = loadConfig();
          for (const [k, v] of Object.entries(parsed.env)) {
            if (/\u2022/.test(v))
              parsed.env[k] = current.env[k] || v;
          }
        }
        saveConfig(parsed);
      } else {
        writeFileSync3(fullPath, content + `
`, "utf-8");
      }
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e.message }, 400);
    }
  });
  app.post("/api/config-file/toggle", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath || !filePath.startsWith("fleet/"))
      return c.json({ error: "invalid path" }, 400);
    const fullPath = join14(import.meta.dir, "..", filePath);
    if (!existsSync4(fullPath))
      return c.json({ error: "not found" }, 404);
    const isDisabled = filePath.endsWith(".disabled");
    const newPath = isDisabled ? fullPath.replace(/\.disabled$/, "") : fullPath + ".disabled";
    const newRelPath = isDisabled ? filePath.replace(/\.disabled$/, "") : filePath + ".disabled";
    renameSync2(fullPath, newPath);
    return c.json({ ok: true, newPath: newRelPath });
  });
  app.delete("/api/config-file", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath || !filePath.startsWith("fleet/"))
      return c.json({ error: "cannot delete" }, 400);
    const fullPath = join14(import.meta.dir, "..", filePath);
    if (!existsSync4(fullPath))
      return c.json({ error: "not found" }, 404);
    unlinkSync(fullPath);
    return c.json({ ok: true });
  });
  app.put("/api/config-file", async (c) => {
    const { name, content } = await c.req.json();
    if (!name || !name.endsWith(".json"))
      return c.json({ error: "name must end with .json" }, 400);
    const safeName = basename(name);
    const fullPath = join14(fleetDir, safeName);
    if (existsSync4(fullPath))
      return c.json({ error: "file already exists" }, 409);
    try {
      JSON.parse(content);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    writeFileSync3(fullPath, content + `
`, "utf-8");
    return c.json({ ok: true, path: `fleet/${safeName}` });
  });
  app.get("/api/config", (c) => {
    if (c.req.query("raw") === "1")
      return c.json(loadConfig());
    return c.json(configForDisplay());
  });
  app.post("/api/config", async (c) => {
    try {
      const body = await c.req.json();
      if (body.env && typeof body.env === "object") {
        const current = loadConfig();
        const merged = {};
        for (const [k, v] of Object.entries(body.env)) {
          merged[k] = /\u2022/.test(v) ? current.env[k] || v : v;
        }
        body.env = merged;
      }
      saveConfig(body);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e.message }, 400);
    }
  });
  app.get("/api/worktrees", async (c) => {
    try {
      return c.json(await scanWorktrees());
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });
  app.post("/api/worktrees/cleanup", async (c) => {
    const { path } = await c.req.json();
    if (!path)
      return c.json({ error: "path required" }, 400);
    try {
      const log = await cleanupWorktree(path);
      return c.json({ ok: true, log });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });
  feedTailer = new FeedTailer;
  app.get("/api/feed", (c) => {
    const limit = Math.min(200, +(c.req.query("limit") || "50"));
    const oracle = c.req.query("oracle") || undefined;
    let events = feedTailer.getRecent(limit);
    if (oracle)
      events = events.filter((e) => e.oracle === oracle);
    const active = [...feedTailer.getActive().keys()];
    return c.json({ events: events.reverse(), total: events.length, active_oracles: active });
  });
  app.onError((err, c) => c.json({ error: err.message }, 500));
  if (!process.env.MAW_CLI) {
    startServer();
  }
});

// src/commands/comm.ts
init_ssh();

// src/hooks.ts
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join as join2 } from "path";
import { spawn } from "child_process";
var CONFIG_PATH = join2(homedir(), ".oracle", "maw.hooks.json");
var configCache = null;
async function loadConfig2() {
  if (configCache)
    return configCache;
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    configCache = JSON.parse(raw);
    return configCache;
  } catch {
    configCache = {};
    return configCache;
  }
}
function expandPath(p) {
  if (p.startsWith("~/"))
    return join2(homedir(), p.slice(2));
  return p;
}
function inferCaller() {
  if (process.env.CLAUDE_AGENT_NAME)
    return process.env.CLAUDE_AGENT_NAME;
  const cwd = process.cwd();
  const match = cwd.match(/([^/]+)-oracle/);
  if (match)
    return match[1];
  return "unknown";
}
async function runHook(event, data) {
  const config = await loadConfig2();
  const script = config.hooks?.[event];
  if (!script)
    return;
  const env = {
    ...process.env,
    MAW_EVENT: event,
    MAW_TIMESTAMP: new Date().toISOString(),
    MAW_FROM: data.from || inferCaller(),
    MAW_TO: data.to,
    MAW_MESSAGE: data.message,
    MAW_CHANNEL: data.channel || "hey"
  };
  try {
    const child = spawn("sh", ["-c", expandPath(script)], {
      env,
      stdio: "ignore",
      detached: true
    });
    child.unref();
  } catch {}
}

// src/commands/comm.ts
import { appendFile, mkdir } from "fs/promises";
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";
async function cmdList() {
  const sessions = await listSessions();
  const targets = [];
  for (const s of sessions) {
    for (const w of s.windows)
      targets.push(`${s.name}:${w.index}`);
  }
  const infos = await getPaneInfos(targets);
  for (const s of sessions) {
    console.log(`\x1B[36m${s.name}\x1B[0m`);
    for (const w of s.windows) {
      const target = `${s.name}:${w.index}`;
      const info = infos[target] || { command: "", cwd: "" };
      const isAgent = /claude|codex|node/i.test(info.command);
      const cwdBroken = info.cwd.includes("(deleted)") || info.cwd.includes("(dead)");
      let dot;
      let suffix = "";
      if (cwdBroken) {
        dot = "\x1B[31m\u25CF\x1B[0m";
        suffix = "  \x1B[31m(path deleted)\x1B[0m";
      } else if (w.active && isAgent) {
        dot = "\x1B[32m\u25CF\x1B[0m";
      } else if (isAgent) {
        dot = "\x1B[34m\u25CF\x1B[0m";
      } else {
        dot = "\x1B[31m\u25CF\x1B[0m";
        suffix = `  \x1B[90m(${info.command || "?"})\x1B[0m`;
      }
      console.log(`  ${dot} ${w.index}: ${w.name}${suffix}`);
    }
  }
}
async function cmdPeek(query) {
  const sessions = await listSessions();
  if (!query) {
    for (const s of sessions) {
      for (const w of s.windows) {
        const target2 = `${s.name}:${w.index}`;
        try {
          const content2 = await capture(target2, 3);
          const lastLine = content2.split(`
`).filter((l) => l.trim()).pop() || "(empty)";
          const dot = w.active ? "\x1B[32m*\x1B[0m" : " ";
          console.log(`${dot} \x1B[36m${w.name.padEnd(22)}\x1B[0m ${lastLine.slice(0, 80)}`);
        } catch {
          console.log(`  \x1B[36m${w.name.padEnd(22)}\x1B[0m (unreachable)`);
        }
      }
    }
    return;
  }
  const target = findWindow(sessions, query);
  if (!target) {
    console.error(`window not found: ${query}`);
    process.exit(1);
  }
  const content = await capture(target);
  console.log(`\x1B[36m--- ${target} ---\x1B[0m`);
  console.log(content);
}
async function cmdSend(query, message, force = false) {
  const sessions = await listSessions();
  const target = findWindow(sessions, query);
  if (!target) {
    console.error(`window not found: ${query}`);
    process.exit(1);
  }
  if (!force) {
    const cmd = await getPaneCommand(target);
    const isAgent = /claude|codex|node/i.test(cmd);
    if (!isAgent) {
      console.error(`\x1B[31merror\x1B[0m: no active Claude session in ${target} (running: ${cmd})`);
      console.error(`\x1B[33mhint\x1B[0m:  run \x1B[36mmaw wake ${query}\x1B[0m first, or use \x1B[36m--force\x1B[0m to send anyway`);
      process.exit(1);
    }
  }
  await sendKeys(target, message);
  await runHook("after_send", { to: query, message });
  const logDir = join3(homedir2(), ".oracle");
  const logFile = join3(logDir, "maw-log.jsonl");
  const host = (await import("os")).hostname();
  const from = process.env.CLAUDE_AGENT_NAME || "cli";
  const sid = process.env.CLAUDE_SESSION_ID || null;
  const line = JSON.stringify({ ts: new Date().toISOString(), from, to: query, target, msg: message, host, sid }) + `
`;
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(logFile, line);
  } catch {}
  console.log(`\x1B[32msent\x1B[0m \u2192 ${target}: ${message}`);
}

// src/commands/view.ts
init_ssh();
init_tmux();
init_config();
async function cmdView(agent, windowHint, clean = false) {
  const sessions = await listSessions();
  const allWindows = sessions.flatMap((s) => s.windows.map((w) => ({ session: s.name, ...w })));
  const agentLower = agent.toLowerCase();
  let sessionName = null;
  for (const s of sessions) {
    const sLower = s.name.toLowerCase();
    if (sLower.endsWith(`-${agentLower}`) || sLower === agentLower) {
      sessionName = s.name;
      break;
    }
    if (s.windows.some((w) => w.name.toLowerCase().includes(agentLower))) {
      sessionName = s.name;
      break;
    }
  }
  if (!sessionName) {
    console.error(`session not found for: ${agent}`);
    process.exit(1);
  }
  const viewName = `${agent}-view${windowHint ? `-${windowHint}` : ""}`;
  const t = new Tmux;
  await t.killSession(viewName);
  await t.newGroupedSession(sessionName, viewName, { cols: 200, rows: 50 });
  console.log(`\x1B[36mcreated\x1B[0m \u2192 ${viewName} (grouped with ${sessionName})`);
  if (windowHint) {
    const win = allWindows.find((w) => w.session === sessionName && (w.name === windowHint || w.name.includes(windowHint) || String(w.index) === windowHint));
    if (win) {
      await t.selectWindow(`${viewName}:${win.index}`);
      console.log(`\x1B[36mwindow\x1B[0m  \u2192 ${win.name} (${win.index})`);
    } else {
      console.error(`\x1B[33mwarn\x1B[0m: window '${windowHint}' not found, using default`);
    }
  }
  if (clean) {
    await t.set(viewName, "status", "off");
  }
  const host = process.env.MAW_HOST || loadConfig().host || "white.local";
  const isLocal = host === "local" || host === "localhost";
  const attachArgs = isLocal ? ["tmux", "attach-session", "-t", viewName] : ["ssh", "-tt", host, `tmux attach-session -t '${viewName}'`];
  console.log(`\x1B[36mattach\x1B[0m  \u2192 ${viewName}${clean ? " (clean)" : ""}`);
  const proc = Bun.spawn(attachArgs, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  await t.killSession(viewName);
  console.log(`\x1B[90mcleaned\x1B[0m \u2192 ${viewName}`);
  process.exit(exitCode);
}

// src/commands/completions.ts
import { readdirSync, readFileSync as readFileSync2 } from "fs";
import { join as join4 } from "path";
async function cmdCompletions(sub) {
  if (sub === "commands") {
    console.log("ls peek hey wake fleet stop done overview about oracle pulse view create-view serve");
  } else if (sub === "oracles" || sub === "windows") {
    const fleetDir = join4(import.meta.dir, "../../fleet");
    const names = new Set;
    try {
      for (const f of readdirSync(fleetDir).filter((f2) => f2.endsWith(".json") && !f2.endsWith(".disabled"))) {
        const config = JSON.parse(readFileSync2(join4(fleetDir, f), "utf-8"));
        for (const w of config.windows || []) {
          if (sub === "oracles") {
            if (w.name.endsWith("-oracle"))
              names.add(w.name.replace(/-oracle$/, ""));
          } else {
            names.add(w.name);
          }
        }
      }
    } catch {}
    console.log([...names].sort().join(`
`));
  } else if (sub === "fleet") {
    console.log("init ls renumber validate sync");
  } else if (sub === "pulse") {
    console.log("add ls list");
  }
}

// src/cli.ts
init_overview();

// src/commands/wake.ts
init_ssh();
init_tmux();
init_config();
import { readdirSync as readdirSync2, readFileSync as readFileSync3 } from "fs";
import { join as join5 } from "path";
async function fetchIssuePrompt(issueNum, repo) {
  let repoSlug = repo;
  if (!repoSlug) {
    try {
      const remote = await ssh("git remote get-url origin 2>/dev/null");
      const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (m)
        repoSlug = m[1];
    } catch {}
  }
  if (!repoSlug)
    throw new Error("Could not detect repo \u2014 pass --repo org/name");
  const json = await ssh(`gh issue view ${issueNum} --repo '${repoSlug}' --json title,body,labels`);
  const issue = JSON.parse(json);
  const labels = (issue.labels || []).map((l) => l.name).join(", ");
  const parts = [
    `Work on issue #${issueNum}: ${issue.title}`,
    labels ? `Labels: ${labels}` : "",
    "",
    issue.body || "(no description)"
  ];
  return parts.filter(Boolean).join(`
`);
}
async function resolveOracle(oracle) {
  const ghqOut = await ssh(`ghq list --full-path | grep -i '/${oracle}-oracle$' | head -1`);
  if (ghqOut?.trim()) {
    const repoPath = ghqOut.trim();
    const repoName = repoPath.split("/").pop();
    const parentDir = repoPath.replace(/\/[^/]+$/, "");
    return { repoPath, repoName, parentDir };
  }
  const fleetDir = join5(import.meta.dir, "../../fleet");
  try {
    for (const file of readdirSync2(fleetDir).filter((f) => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync3(join5(fleetDir, file), "utf-8"));
      const win = (config.windows || []).find((w) => w.name === `${oracle}-oracle`);
      if (win?.repo) {
        const fullPath = await ssh(`ghq list --full-path | grep -i '/${win.repo.replace(/^[^/]+\//, "")}$' | head -1`);
        if (fullPath?.trim()) {
          const repoPath = fullPath.trim();
          const repoName = repoPath.split("/").pop();
          const parentDir = repoPath.replace(/\/[^/]+$/, "");
          return { repoPath, repoName, parentDir };
        }
      }
    }
  } catch {}
  console.error(`oracle repo not found: ${oracle} (tried ${oracle}-oracle pattern and fleet configs)`);
  process.exit(1);
}
async function findWorktrees(parentDir, repoName) {
  const lsOut = await ssh(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`);
  return lsOut.split(`
`).filter(Boolean).map((p) => {
    const base = p.split("/").pop();
    const suffix = base.replace(`${repoName}.wt-`, "");
    return { path: p, name: suffix };
  });
}
function getSessionMap() {
  return loadConfig().sessions;
}
function resolveFleetSession(oracle) {
  const fleetDir = join5(import.meta.dir, "../../fleet");
  try {
    for (const file of readdirSync2(fleetDir).filter((f) => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync3(join5(fleetDir, file), "utf-8"));
      const hasOracleWindow = (config.windows || []).some((w) => w.name === `${oracle}-oracle` || w.name === oracle);
      if (hasOracleWindow)
        return config.name;
    }
  } catch {}
  return null;
}
async function detectSession(oracle) {
  const sessions = await tmux.listSessions();
  const mapped = getSessionMap()[oracle];
  if (mapped) {
    const exists = sessions.find((s) => s.name === mapped);
    if (exists)
      return mapped;
  }
  const patternMatch = sessions.find((s) => /^\d+-/.test(s.name) && s.name.endsWith(`-${oracle}`))?.name || sessions.find((s) => s.name === oracle)?.name;
  if (patternMatch)
    return patternMatch;
  const fleetSession = resolveFleetSession(oracle);
  if (fleetSession) {
    const exists = sessions.find((s) => s.name === fleetSession);
    if (exists)
      return fleetSession;
  }
  return null;
}
async function setSessionEnv(session) {
  for (const [key, val] of Object.entries(getEnvVars())) {
    await tmux.setEnvironment(session, key, val);
  }
}
async function cmdWake(oracle, opts) {
  const { repoPath, repoName, parentDir } = await resolveOracle(oracle);
  let session = await detectSession(oracle);
  if (!session) {
    session = getSessionMap()[oracle] || resolveFleetSession(oracle) || oracle;
    const mainWindowName = `${oracle}-oracle`;
    await tmux.newSession(session, { window: mainWindowName, cwd: repoPath });
    await setSessionEnv(session);
    await new Promise((r) => setTimeout(r, 300));
    await tmux.sendText(`${session}:${mainWindowName}`, buildCommand(mainWindowName));
    console.log(`\x1B[32m+\x1B[0m created session '${session}' (main: ${mainWindowName})`);
    const allWt = await findWorktrees(parentDir, repoName);
    for (const wt of allWt) {
      const wtWindowName = `${oracle}-${wt.name}`;
      await tmux.newWindow(session, wtWindowName, { cwd: wt.path });
      await new Promise((r) => setTimeout(r, 300));
      await tmux.sendText(`${session}:${wtWindowName}`, buildCommand(wtWindowName));
      console.log(`\x1B[32m+\x1B[0m window: ${wtWindowName}`);
    }
  } else {
    await setSessionEnv(session);
  }
  let targetPath = repoPath;
  let windowName = `${oracle}-oracle`;
  if (opts.newWt || opts.task) {
    const name = opts.newWt || opts.task;
    const worktrees = await findWorktrees(parentDir, repoName);
    const match = worktrees.find((w) => w.name.endsWith(`-${name}`) || w.name === name);
    if (match) {
      console.log(`\x1B[33m\u26A1\x1B[0m reusing worktree: ${match.path}`);
      targetPath = match.path;
      windowName = `${oracle}-${name}`;
    } else {
      const nums = worktrees.map((w) => parseInt(w.name) || 0);
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const wtName = `${nextNum}-${name}`;
      const wtPath = `${parentDir}/${repoName}.wt-${wtName}`;
      const branch = `agents/${wtName}`;
      try {
        await ssh(`git -C '${repoPath}' branch -D '${branch}' 2>/dev/null`);
      } catch {}
      await ssh(`git -C '${repoPath}' worktree add '${wtPath}' -b '${branch}'`);
      console.log(`\x1B[32m+\x1B[0m worktree: ${wtPath} (${branch})`);
      targetPath = wtPath;
      windowName = `${oracle}-${name}`;
    }
  }
  try {
    const windows = await tmux.listWindows(session);
    const windowNames = windows.map((w) => w.name);
    const nameSuffix = windowName.replace(`${oracle}-`, "");
    const existingWindow = windowNames.find((w) => w === windowName) || windowNames.find((w) => new RegExp(`^${oracle}-\\d+-${nameSuffix}$`).test(w));
    if (existingWindow) {
      if (opts.prompt) {
        console.log(`\x1B[33m\u26A1\x1B[0m '${existingWindow}' exists, sending prompt`);
        await tmux.selectWindow(`${session}:${existingWindow}`);
        const cmd2 = buildCommand(existingWindow);
        const escaped = opts.prompt.replace(/'/g, "'\\''");
        await tmux.sendText(`${session}:${existingWindow}`, `${cmd2} -p '${escaped}'`);
        return `${session}:${existingWindow}`;
      }
      console.log(`\x1B[33m\u26A1\x1B[0m '${existingWindow}' already running in ${session}`);
      await tmux.selectWindow(`${session}:${existingWindow}`);
      return `${session}:${existingWindow}`;
    }
  } catch {}
  await tmux.newWindow(session, windowName, { cwd: targetPath });
  await new Promise((r) => setTimeout(r, 300));
  const cmd = buildCommand(windowName);
  if (opts.prompt) {
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    await tmux.sendText(`${session}:${windowName}`, `${cmd} -p '${escaped}'`);
  } else {
    await tmux.sendText(`${session}:${windowName}`, cmd);
  }
  console.log(`\x1B[32m\u2705\x1B[0m woke '${windowName}' in ${session} \u2192 ${targetPath}`);
  return `${session}:${windowName}`;
}

// src/commands/pulse.ts
init_ssh();
var THAI_DAYS = ["\u0E2D\u0E32\u0E17\u0E34\u0E15\u0E22\u0E4C", "\u0E08\u0E31\u0E19\u0E17\u0E23\u0E4C", "\u0E2D\u0E31\u0E07\u0E04\u0E32\u0E23", "\u0E1E\u0E38\u0E18", "\u0E1E\u0E24\u0E2B\u0E31\u0E2A\u0E1A\u0E14\u0E35", "\u0E28\u0E38\u0E01\u0E23\u0E4C", "\u0E40\u0E2A\u0E32\u0E23\u0E4C"];
function todayDate() {
  const d = new Date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayLabel() {
  const d = new Date;
  const date = todayDate();
  const day = THAI_DAYS[d.getDay()];
  return `${date} (${day})`;
}
function timePeriod() {
  const h = new Date().getHours();
  if (h >= 6 && h < 12)
    return "morning";
  if (h >= 12 && h < 18)
    return "afternoon";
  if (h >= 18)
    return "evening";
  return "midnight";
}
var PERIODS = [
  { key: "morning", label: "\uD83C\uDF05 Morning (06:00-12:00)", hours: [6, 12] },
  { key: "afternoon", label: "\u2600\uFE0F Afternoon (12:00-18:00)", hours: [12, 18] },
  { key: "evening", label: "\uD83C\uDF06 Evening (18:00-24:00)", hours: [18, 24] },
  { key: "midnight", label: "\uD83C\uDF19 Midnight (00:00-06:00)", hours: [0, 6] }
];
async function findOrCreateDailyThread(repo) {
  const date = todayDate();
  const label = todayLabel();
  const searchDate = `\uD83D\uDCC5 ${date}`;
  const threadTitle = `\uD83D\uDCC5 ${label} Daily Thread`;
  const existing = (await ssh(`gh issue list --repo ${repo} --search '${searchDate} in:title' --state open --json number,url,title --limit 1`)).trim();
  const parsed = JSON.parse(existing || "[]");
  if (parsed.length > 0 && parsed[0].title.includes(date)) {
    return { url: parsed[0].url, num: parsed[0].number, isNew: false };
  }
  const url = (await ssh(`gh issue create --repo ${repo} -t '${threadTitle.replace(/'/g, "'\\''")}' -b 'Tasks for ${label}' -l daily-thread`)).trim();
  const m = url.match(/\/(\d+)$/);
  const num = m ? +m[1] : 0;
  console.log(`\x1B[32m+\x1B[0m daily thread #${num}: ${url}`);
  return { url, num, isNew: true };
}
async function ensurePeriodComments(repo, threadNum) {
  const commentsJson = (await ssh(`gh api repos/${repo}/issues/${threadNum}/comments --jq '[.[] | {id: .id, body: .body}]'`)).trim();
  const comments = JSON.parse(commentsJson || "[]");
  const result = {};
  for (const p of PERIODS) {
    const existing = comments.find((c) => c.body.startsWith(p.label));
    if (existing) {
      result[p.key] = existing;
    } else {
      const body = `${p.label}

_(no tasks yet)_`;
      const escaped = body.replace(/'/g, "'\\''");
      const created = (await ssh(`gh api repos/${repo}/issues/${threadNum}/comments -f body='${escaped}' --jq '.id'`)).trim();
      result[p.key] = { id: created, body };
    }
  }
  return result;
}
async function addTaskToPeriodComment(repo, threadNum, period, issueNum, title, oracle) {
  const periodComments = await ensurePeriodComments(repo, threadNum);
  const comment = periodComments[period];
  if (!comment)
    return;
  const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const oracleTag = oracle ? ` \u2192 ${oracle}` : "";
  const taskLine = `- [ ] #${issueNum} ${title} (${now}${oracleTag})`;
  let newBody;
  if (comment.body.includes("_(no tasks yet)_")) {
    newBody = comment.body.replace("_(no tasks yet)_", taskLine);
  } else {
    newBody = comment.body + `
` + taskLine;
  }
  const escaped = newBody.replace(/'/g, "'\\''");
  await ssh(`gh api repos/${repo}/issues/comments/${comment.id} -X PATCH -f body='${escaped}'`);
}
async function cmdPulseAdd(title, opts) {
  const repo = "laris-co/pulse-oracle";
  const projectNum = 6;
  const period = timePeriod();
  const thread = await findOrCreateDailyThread(repo);
  const escaped = title.replace(/'/g, "'\\''");
  const labels = [];
  if (opts.oracle)
    labels.push(`oracle:${opts.oracle}`);
  const labelFlags = labels.length ? labels.map((l) => `-l '${l}'`).join(" ") : "";
  const issueUrl = (await ssh(`gh issue create --repo ${repo} -t '${escaped}' ${labelFlags} -b 'Parent: #${thread.num}'`)).trim();
  const m = issueUrl.match(/\/(\d+)$/);
  const issueNum = m ? +m[1] : 0;
  console.log(`\x1B[32m+\x1B[0m issue #${issueNum} (${period}): ${issueUrl}`);
  await addTaskToPeriodComment(repo, thread.num, period, issueNum, title, opts.oracle);
  console.log(`\x1B[32m+\x1B[0m added to ${period} in daily thread #${thread.num}`);
  try {
    await ssh(`gh project item-add ${projectNum} --owner laris-co --url '${issueUrl}'`);
    console.log(`\x1B[32m+\x1B[0m added to Master Board (#${projectNum})`);
  } catch (e) {
    console.log(`\x1B[33mwarn:\x1B[0m could not add to project board: ${e}`);
  }
  if (opts.oracle) {
    const wakeOpts = {};
    if (opts.wt) {
      wakeOpts.newWt = opts.wt;
    }
    const prompt = `/recap --deep \u2014 You have been assigned issue #${issueNum}: ${title}. Issue URL: ${issueUrl}. Orient yourself, then wait for human instructions.`;
    wakeOpts.prompt = prompt;
    const target = await cmdWake(opts.oracle, wakeOpts);
    console.log(`\x1B[32m\uD83D\uDE80\x1B[0m ${target}: waking up with /recap --deep \u2192 then --continue`);
  }
}
async function cmdPulseLs(opts) {
  const repo = "laris-co/pulse-oracle";
  const issuesJson = (await ssh(`gh issue list --repo ${repo} --state open --json number,title,labels --limit 50`)).trim();
  const issues = JSON.parse(issuesJson || "[]");
  const projects = [];
  const today = [];
  const threads = [];
  for (const issue of issues) {
    const labels = issue.labels.map((l) => l.name);
    if (labels.includes("daily-thread")) {
      threads.push(issue);
      continue;
    }
    if (/^P\d{3}/.test(issue.title)) {
      projects.push(issue);
      continue;
    }
    today.push(issue);
  }
  const toolIssues = [];
  const activeIssues = [];
  for (const issue of today) {
    const isToday = issue.title.includes("Daily") || issue.number > (threads[0]?.number || 0);
    if (isToday && !issue.title.includes("Daily"))
      activeIssues.push(issue);
    else
      toolIssues.push(issue);
  }
  const getOracle = (issue) => {
    const label = issue.labels.find((l) => l.name.startsWith("oracle:"));
    return label ? label.name.replace("oracle:", "") : "\u2014";
  };
  console.log(`
\x1B[36m\uD83D\uDCCB Pulse Board\x1B[0m
`);
  if (projects.length) {
    console.log(`\x1B[33mProjects (${projects.length})\x1B[0m`);
    console.log(`\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u252C${"\u2500".repeat(50)}\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510`);
    for (const p of projects.sort((a, b) => a.number - b.number)) {
      const oracle = getOracle(p);
      console.log(`\u2502 \x1B[32m#${String(p.number).padEnd(3)}\x1B[0m \u2502 ${p.title.slice(0, 48).padEnd(48)} \u2502 ${oracle.padEnd(12)} \u2502`);
    }
    console.log(`\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2534${"\u2500".repeat(50)}\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`);
  }
  if (toolIssues.length) {
    console.log(`
\x1B[33mTools/Infra (${toolIssues.length})\x1B[0m`);
    console.log(`\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u252C${"\u2500".repeat(50)}\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510`);
    for (const t of toolIssues.sort((a, b) => a.number - b.number)) {
      const oracle = getOracle(t);
      console.log(`\u2502 \x1B[32m#${String(t.number).padEnd(3)}\x1B[0m \u2502 ${t.title.slice(0, 48).padEnd(48)} \u2502 ${oracle.padEnd(12)} \u2502`);
    }
    console.log(`\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2534${"\u2500".repeat(50)}\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`);
  }
  if (activeIssues.length) {
    console.log(`
\x1B[33mActive Today (${activeIssues.length})\x1B[0m`);
    for (const a of activeIssues.sort((a2, b) => a2.number - b.number)) {
      const oracle = getOracle(a);
      console.log(`  \x1B[33m\uD83D\uDFE1\x1B[0m #${a.number} ${a.title} \u2192 ${oracle}`);
    }
  }
  console.log(`
\x1B[36m${issues.length - threads.length} open\x1B[0m
`);
  if (opts.sync) {
    const thread = threads.find((t) => t.title.includes(todayDate()));
    if (!thread) {
      console.log("No daily thread found for today");
      return;
    }
    const lines = [`## \uD83D\uDCCB Pulse Board Index (${todayLabel()})`, ""];
    if (projects.length) {
      lines.push(`### Projects (${projects.length})`, "");
      for (const p of projects.sort((a, b) => a.number - b.number)) {
        lines.push(`- [ ] #${p.number} ${p.title} \u2192 ${getOracle(p)}`);
      }
      lines.push("");
    }
    if (toolIssues.length) {
      lines.push(`### Tools/Infra (${toolIssues.length})`, "");
      for (const t of toolIssues.sort((a, b) => a.number - b.number)) {
        lines.push(`- [ ] #${t.number} ${t.title} \u2192 ${getOracle(t)}`);
      }
      lines.push("");
    }
    if (activeIssues.length) {
      lines.push(`### Active Today (${activeIssues.length})`, "");
      for (const a of activeIssues.sort((a2, b) => a2.number - b.number)) {
        lines.push(`- [ ] #${a.number} ${a.title} \u2192 ${getOracle(a)} \uD83D\uDFE1`);
      }
      lines.push("");
    }
    lines.push(`**${issues.length - threads.length} open** \u2014 Homekeeper Oracle \uD83E\uDD16`);
    const body = lines.join(`
`).replace(/'/g, "'\\''");
    const commentsJson2 = (await ssh(`gh api repos/${repo}/issues/${thread.number}/comments --jq '[.[] | {id: .id, body: .body}]'`)).trim();
    const comments = JSON.parse(commentsJson2 || "[]");
    const indexComment = comments.find((c) => c.body.includes("Pulse Board Index"));
    if (indexComment) {
      await ssh(`gh api repos/${repo}/issues/comments/${indexComment.id} -X PATCH -f body='${body}'`);
      console.log(`\x1B[32m\u2705\x1B[0m synced to daily thread #${thread.number}`);
    } else {
      await ssh(`gh api repos/${repo}/issues/${thread.number}/comments -f body='${body}'`);
      console.log(`\x1B[32m+\x1B[0m index posted to daily thread #${thread.number}`);
    }
  }
}

// src/commands/oracle.ts
init_ssh();
import { readdirSync as readdirSync3, readFileSync as readFileSync4 } from "fs";
import { join as join6 } from "path";
async function resolveOracleSafe(oracle) {
  try {
    let ghqOut = await ssh(`ghq list --full-path | grep -i '/${oracle}-oracle$' | head -1`).catch(() => "");
    if (!ghqOut.trim()) {
      ghqOut = await ssh(`ghq list --full-path | grep -i '/${oracle}$' | head -1`).catch(() => "");
    }
    if (!ghqOut.trim())
      return { parentDir: "", repoName: "", repoPath: "" };
    const repoPath = ghqOut.trim();
    const repoName = repoPath.split("/").pop();
    const parentDir = repoPath.replace(/\/[^/]+$/, "");
    return { repoPath, repoName, parentDir };
  } catch {
    return { parentDir: "", repoName: "", repoPath: "" };
  }
}
async function discoverOracles() {
  const names = new Set;
  const fleetDir = join6(import.meta.dir, "../../fleet");
  try {
    for (const file of readdirSync3(fleetDir).filter((f) => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync4(join6(fleetDir, file), "utf-8"));
      for (const w of config.windows || []) {
        if (w.name.endsWith("-oracle"))
          names.add(w.name.replace(/-oracle$/, ""));
      }
    }
  } catch {}
  try {
    const sessions = await listSessions();
    for (const s of sessions) {
      for (const w of s.windows) {
        if (w.name.endsWith("-oracle"))
          names.add(w.name.replace(/-oracle$/, ""));
      }
    }
  } catch {}
  return [...names].sort();
}
async function cmdOracleAbout(oracle) {
  const name = oracle.toLowerCase();
  const sessions = await listSessions();
  console.log(`
  \x1B[36mOracle \u2014 ${oracle.charAt(0).toUpperCase() + oracle.slice(1)}\x1B[0m
`);
  const { repoPath, repoName, parentDir } = await resolveOracleSafe(name);
  console.log(`  Repo:      ${repoPath || "(not found)"}`);
  const session = await detectSession(name);
  if (session) {
    const s = sessions.find((s2) => s2.name === session);
    const windows = s?.windows || [];
    console.log(`  Session:   ${session} (${windows.length} windows)`);
    for (const w of windows) {
      let status = "\x1B[90m\u25CB\x1B[0m";
      try {
        const content = await capture(`${session}:${w.index}`, 3);
        status = content.trim() ? "\x1B[32m\u25CF\x1B[0m" : "\x1B[33m\u25CF\x1B[0m";
      } catch {}
      console.log(`    ${status} ${w.name}`);
    }
  } else {
    console.log(`  Session:   (none)`);
  }
  if (parentDir) {
    const wts = await findWorktrees(parentDir, repoName);
    console.log(`  Worktrees: ${wts.length}`);
    for (const wt of wts) {
      console.log(`    ${wt.name} \u2192 ${wt.path}`);
    }
  }
  const fleetDir = join6(import.meta.dir, "../../fleet");
  let fleetFile = null;
  let fleetWindowCount = 0;
  try {
    for (const file of readdirSync3(fleetDir).filter((f) => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync4(join6(fleetDir, file), "utf-8"));
      const hasOracle = (config.windows || []).some((w) => w.name.toLowerCase() === `${name}-oracle` || w.name.toLowerCase() === name);
      if (hasOracle) {
        fleetFile = file;
        fleetWindowCount = config.windows.length;
        break;
      }
    }
  } catch {}
  if (fleetFile) {
    const actualWindows = session ? sessions.find((s) => s.name === session)?.windows.length || 0 : 0;
    console.log(`  Fleet:     ${fleetFile} (${fleetWindowCount} registered, ${actualWindows} running)`);
    if (actualWindows > fleetWindowCount) {
      const fleetConfig = JSON.parse(readFileSync4(join6(fleetDir, fleetFile), "utf-8"));
      const registeredNames = new Set((fleetConfig.windows || []).map((w) => w.name));
      const runningWindows = sessions.find((s) => s.name === session)?.windows || [];
      const unregistered = runningWindows.filter((w) => !registeredNames.has(w.name));
      console.log(`  \x1B[33m\u26A0\x1B[0m  ${unregistered.length} window(s) not in fleet config \u2014 won't survive reboot`);
      for (const w of unregistered) {
        console.log(`    \x1B[33m\u2192\x1B[0m ${w.name}`);
      }
      console.log(`
  \x1B[90mFix: add to fleet/${fleetFile}\x1B[0m`);
      console.log(`  \x1B[90m  maw fleet init          # regenerate all configs\x1B[0m`);
      console.log(`  \x1B[90m  maw fleet validate      # check for problems\x1B[0m`);
    }
  } else {
    console.log(`  Fleet:     (no config)`);
  }
  console.log();
}
async function cmdOracleList() {
  const sessions = await listSessions();
  const statuses = [];
  for (const oracle of await discoverOracles()) {
    const session = await detectSession(oracle);
    let windows = [];
    if (session) {
      const s = sessions.find((s2) => s2.name === session);
      if (s) {
        windows = s.windows.map((w) => w.name);
      }
    }
    let worktrees = 0;
    try {
      const { parentDir, repoName } = await resolveOracleSafe(oracle);
      if (parentDir) {
        const wts = await findWorktrees(parentDir, repoName);
        worktrees = wts.length;
      }
    } catch {}
    statuses.push({
      name: oracle,
      session,
      windows,
      worktrees,
      status: session ? "awake" : "sleeping"
    });
  }
  statuses.sort((a, b) => {
    if (a.status !== b.status)
      return a.status === "awake" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const awakeCount = statuses.filter((s) => s.status === "awake").length;
  console.log(`
  \x1B[36mOracle Fleet\x1B[0m  (${awakeCount}/${statuses.length} awake)
`);
  console.log(`  ${"Oracle".padEnd(14)} ${"Status".padEnd(10)} ${"Session".padEnd(16)} ${"Windows".padEnd(6)} ${"WT".padEnd(4)} Details`);
  console.log(`  ${"\u2500".repeat(80)}`);
  for (const s of statuses) {
    const icon = s.status === "awake" ? "\x1B[32m\u25CF\x1B[0m" : "\x1B[90m\u25CB\x1B[0m";
    const statusText = s.status === "awake" ? "\x1B[32mawake\x1B[0m " : "\x1B[90msleep\x1B[0m ";
    const sessionText = s.session || "-";
    const winCount = s.windows.length > 0 ? String(s.windows.length) : "-";
    const wtCount = s.worktrees > 0 ? String(s.worktrees) : "-";
    const details = s.windows.length > 0 ? s.windows.slice(0, 4).join(", ") + (s.windows.length > 4 ? ` +${s.windows.length - 4}` : "") : "";
    console.log(`  ${icon} ${s.name.padEnd(13)} ${statusText.padEnd(19)} ${sessionText.padEnd(16)} ${winCount.padEnd(6)} ${wtCount.padEnd(4)} ${details}`);
  }
  console.log();
}

// src/commands/fleet.ts
init_ssh();
init_tmux();
init_config();
import { join as join7 } from "path";
import { readdirSync as readdirSync4, existsSync } from "fs";
var FLEET_DIR = join7(import.meta.dir, "../../fleet");
function loadFleet() {
  const files = readdirSync4(FLEET_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".disabled")).sort();
  return files.map((f) => {
    const raw = __require(join7(FLEET_DIR, f));
    return raw;
  });
}
function loadFleetEntries() {
  const files = readdirSync4(FLEET_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".disabled")).sort();
  return files.map((f) => {
    const raw = __require(join7(FLEET_DIR, f));
    const match = f.match(/^(\d+)-(.+)\.json$/);
    return {
      file: f,
      num: match ? parseInt(match[1], 10) : 0,
      groupName: match ? match[2] : f.replace(".json", ""),
      session: raw
    };
  });
}
async function cmdFleetLs() {
  const entries = loadFleetEntries();
  const disabled = readdirSync4(FLEET_DIR).filter((f) => f.endsWith(".disabled")).length;
  let runningSessions = [];
  try {
    const out = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null");
    runningSessions = out.trim().split(`
`).filter(Boolean);
  } catch {}
  const numCount = new Map;
  for (const e of entries) {
    const list = numCount.get(e.num) || [];
    list.push(e.groupName);
    numCount.set(e.num, list);
  }
  const conflicts = [...numCount.entries()].filter(([, names]) => names.length > 1);
  console.log(`
  \x1B[36mFleet Configs\x1B[0m (${entries.length} active, ${disabled} disabled)
`);
  console.log(`  ${"#".padEnd(4)} ${"Session".padEnd(20)} ${"Win".padEnd(5)} Status`);
  console.log(`  ${"\u2500".repeat(4)} ${"\u2500".repeat(20)} ${"\u2500".repeat(5)} ${"\u2500".repeat(20)}`);
  for (const e of entries) {
    const numStr = String(e.num).padStart(2, "0");
    const name = e.session.name.padEnd(20);
    const wins = String(e.session.windows.length).padEnd(5);
    const isRunning = runningSessions.includes(e.session.name);
    const isConflict = (numCount.get(e.num)?.length ?? 0) > 1;
    let status = isRunning ? "\x1B[32mrunning\x1B[0m" : "\x1B[90mstopped\x1B[0m";
    if (isConflict)
      status += "  \x1B[31mCONFLICT\x1B[0m";
    console.log(`  ${numStr}  ${name} ${wins} ${status}`);
  }
  if (conflicts.length > 0) {
    console.log(`
  \x1B[31m\u26A0 ${conflicts.length} conflict(s) found.\x1B[0m Run \x1B[36mmaw fleet renumber\x1B[0m to fix.`);
  }
  console.log();
}
async function cmdFleetRenumber() {
  const entries = loadFleetEntries();
  const numCount = new Map;
  for (const e of entries)
    numCount.set(e.num, (numCount.get(e.num) || 0) + 1);
  const hasConflicts = [...numCount.values()].some((c) => c > 1);
  if (!hasConflicts) {
    console.log(`
  \x1B[32mNo conflicts found.\x1B[0m Fleet numbering is clean.
`);
    return;
  }
  let runningSessions = [];
  try {
    const out = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null");
    runningSessions = out.trim().split(`
`).filter(Boolean);
  } catch {}
  console.log(`
  \x1B[36mRenumbering fleet...\x1B[0m
`);
  const sorted = [...entries].sort((a, b) => a.num - b.num || a.groupName.localeCompare(b.groupName));
  const regular = sorted.filter((e) => e.num !== 99);
  const overview = sorted.filter((e) => e.num === 99);
  let num = 1;
  for (const e of regular) {
    const newNum = String(num).padStart(2, "0");
    const newFile = `${newNum}-${e.groupName}.json`;
    const newName = `${newNum}-${e.groupName}`;
    const oldName = e.session.name;
    if (newFile !== e.file) {
      e.session.name = newName;
      await Bun.write(join7(FLEET_DIR, newFile), JSON.stringify(e.session, null, 2) + `
`);
      const oldPath = join7(FLEET_DIR, e.file);
      if (existsSync(oldPath) && newFile !== e.file) {
        const { unlinkSync } = __require("fs");
        unlinkSync(oldPath);
      }
      if (runningSessions.includes(oldName)) {
        try {
          await ssh(`tmux rename-session -t '${oldName}' '${newName}'`);
          console.log(`  ${e.file.padEnd(28)} \u2192 ${newFile}  (tmux renamed)`);
        } catch {
          console.log(`  ${e.file.padEnd(28)} \u2192 ${newFile}  (tmux rename failed)`);
        }
      } else {
        console.log(`  ${e.file.padEnd(28)} \u2192 ${newFile}`);
      }
    } else {
      console.log(`  ${e.file.padEnd(28)}   (unchanged)`);
    }
    num++;
  }
  console.log(`
  \x1B[32mDone.\x1B[0m ${regular.length} configs renumbered.
`);
}
async function cmdFleetValidate() {
  const entries = loadFleetEntries();
  const issues = [];
  const numMap = new Map;
  for (const e of entries) {
    const list = numMap.get(e.num) || [];
    list.push(e.groupName);
    numMap.set(e.num, list);
  }
  for (const [num, names] of numMap) {
    if (names.length > 1) {
      issues.push(`\x1B[31mDuplicate #${String(num).padStart(2, "0")}\x1B[0m: ${names.join(", ")}`);
    }
  }
  const oracleMap = new Map;
  for (const e of entries) {
    for (const w of e.session.windows) {
      const oracles = oracleMap.get(w.name) || [];
      oracles.push(e.session.name);
      oracleMap.set(w.name, oracles);
    }
  }
  for (const [oracle, sessions] of oracleMap) {
    if (sessions.length > 1) {
      issues.push(`\x1B[33mDuplicate oracle\x1B[0m: ${oracle} in ${sessions.join(", ")}`);
    }
  }
  const ghqRoot = loadConfig().ghqRoot;
  for (const e of entries) {
    for (const w of e.session.windows) {
      const repoPath = join7(ghqRoot, w.repo);
      if (!existsSync(repoPath)) {
        issues.push(`\x1B[33mMissing repo\x1B[0m: ${w.repo} (in ${e.file})`);
      }
    }
  }
  let runningSessions = [];
  try {
    const out = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null");
    runningSessions = out.trim().split(`
`).filter(Boolean);
    const configNames = new Set(entries.map((e) => e.session.name));
    for (const s of runningSessions) {
      if (!configNames.has(s)) {
        issues.push(`\x1B[90mOrphan session\x1B[0m: tmux '${s}' has no fleet config`);
      }
    }
  } catch {}
  for (const e of entries) {
    if (!runningSessions.includes(e.session.name))
      continue;
    try {
      const winOut = await ssh(`tmux list-windows -t '${e.session.name}' -F '#{window_name}' 2>/dev/null`);
      const runningWindows = winOut.trim().split(`
`).filter(Boolean);
      const registeredWindows = new Set(e.session.windows.map((w) => w.name));
      const unregistered = runningWindows.filter((w) => !registeredWindows.has(w));
      for (const w of unregistered) {
        issues.push(`\x1B[33mUnregistered window\x1B[0m: '${w}' in ${e.session.name} \u2014 won't survive reboot`);
      }
    } catch {}
  }
  console.log(`
  \x1B[36mFleet Validation\x1B[0m (${entries.length} configs)
`);
  if (issues.length === 0) {
    console.log(`  \x1B[32m\u2713 All clear.\x1B[0m No issues found.
`);
  } else {
    for (const issue of issues) {
      console.log(`  \u26A0 ${issue}`);
    }
    console.log(`
  \x1B[31m${issues.length} issue(s) found.\x1B[0m
`);
  }
}
async function cmdFleetSync() {
  const entries = loadFleetEntries();
  let added = 0;
  let runningSessions = [];
  try {
    const out = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null");
    runningSessions = out.trim().split(`
`).filter(Boolean);
  } catch {
    return;
  }
  const ghqRoot = loadConfig().ghqRoot;
  for (const e of entries) {
    if (!runningSessions.includes(e.session.name))
      continue;
    try {
      const winOut = await ssh(`tmux list-windows -t '${e.session.name}' -F '#{window_name}:#{pane_current_path}' 2>/dev/null`);
      const runningWindows = winOut.trim().split(`
`).filter(Boolean);
      const registeredNames = new Set(e.session.windows.map((w) => w.name));
      for (const line of runningWindows) {
        const [winName, cwdPath] = line.split(":");
        if (!winName || registeredNames.has(winName))
          continue;
        let repo = "";
        if (cwdPath?.startsWith(ghqRoot + "/")) {
          repo = cwdPath.slice(ghqRoot.length + 1);
        }
        e.session.windows.push({ name: winName, repo });
        console.log(`  \x1B[32m+\x1B[0m ${winName} \u2192 ${e.file}${repo ? ` (${repo})` : ""}`);
        added++;
      }
    } catch {}
    if (added > 0) {
      const filePath = join7(FLEET_DIR, e.file);
      await Bun.write(filePath, JSON.stringify(e.session, null, 2) + `
`);
    }
  }
  if (added === 0) {
    console.log(`
  \x1B[32m\u2713 Fleet in sync.\x1B[0m No unregistered windows.
`);
  } else {
    console.log(`
  \x1B[32m${added} window(s) added to fleet configs.\x1B[0m
`);
  }
}
async function cmdSleep() {
  const sessions = loadFleet();
  let killed = 0;
  for (const sess of sessions) {
    try {
      await ssh(`tmux kill-session -t '${sess.name}' 2>/dev/null`);
      console.log(`  \x1B[90m\u25CF\x1B[0m ${sess.name} \u2014 sleep`);
      killed++;
    } catch {}
  }
  console.log(`
  ${killed} sessions put to sleep.
`);
}
async function resumeActiveItems() {
  const repo = "laris-co/pulse-oracle";
  try {
    const issuesJson = await ssh(`gh issue list --repo ${repo} --state open --json number,title,labels --limit 50`);
    const issues = JSON.parse(issuesJson || "[]");
    const oracleItems = issues.filter((i) => !i.labels.some((l) => l.name === "daily-thread")).map((i) => ({
      ...i,
      oracle: i.labels.find((l) => l.name.startsWith("oracle:"))?.name.replace("oracle:", "")
    })).filter((i) => i.oracle);
    if (!oracleItems.length) {
      console.log("  \x1B[90mNo active board items to resume.\x1B[0m");
      return;
    }
    const byOracle = new Map;
    for (const item of oracleItems) {
      const list = byOracle.get(item.oracle) || [];
      list.push(item);
      byOracle.set(item.oracle, list);
    }
    for (const [oracle, items] of byOracle) {
      const windowName = `${oracle}-oracle`;
      const sessions = await tmux.listSessions();
      for (const sess of sessions) {
        try {
          const windows = await tmux.listWindows(sess.name);
          const win = windows.find((w) => w.name.toLowerCase() === windowName.toLowerCase());
          if (win) {
            const titles = items.map((i) => `#${i.number}`).join(", ");
            await new Promise((r) => setTimeout(r, 2000));
            await tmux.sendText(`${sess.name}:${win.name}`, `/recap --deep \u2014 Resume after reboot. Active items: ${titles}`);
            console.log(`  \x1B[32m\u21BB\x1B[0m ${oracle}: /recap sent (${titles})`);
            break;
          }
        } catch {}
      }
    }
  } catch (e) {
    console.log(`  \x1B[33mresume skipped:\x1B[0m ${e}`);
  }
}
async function cmdWakeAll(opts = {}) {
  const allSessions = loadFleet();
  const sessions = opts.all ? allSessions : allSessions.filter((s) => {
    const num = parseInt(s.name.split("-")[0], 10);
    return isNaN(num) || num < 20 || num >= 99;
  });
  const skipped = allSessions.length - sessions.length;
  if (opts.kill) {
    console.log(`
  \x1B[33mKilling existing sessions...\x1B[0m
`);
    await cmdSleep();
  }
  const disabled = readdirSync4(FLEET_DIR).filter((f) => f.endsWith(".disabled")).length;
  const skipMsg = skipped > 0 ? `, ${skipped} dormant skipped` : "";
  console.log(`
  \x1B[36mWaking fleet...\x1B[0m  (${sessions.length} sessions${disabled ? `, ${disabled} disabled` : ""}${skipMsg})
`);
  let sessCount = 0;
  let winCount = 0;
  for (const sess of sessions) {
    try {
      await ssh(`tmux has-session -t '${sess.name}' 2>/dev/null`);
      console.log(`  \x1B[33m\u25CF\x1B[0m ${sess.name} \u2014 already awake`);
      continue;
    } catch {}
    const first = sess.windows[0];
    const firstPath = `${loadConfig().ghqRoot}/${first.repo}`;
    await ssh(`tmux new-session -d -s '${sess.name}' -n '${first.name}' -c '${firstPath}'`);
    for (const [key, val] of Object.entries(getEnvVars())) {
      await ssh(`tmux set-environment -t '${sess.name}' '${key}' '${val}'`);
    }
    if (!sess.skip_command) {
      try {
        await ssh(`tmux send-keys -t '${sess.name}:${first.name}' '${buildCommand(first.name)}' Enter`);
      } catch {}
    }
    winCount++;
    for (let i = 1;i < sess.windows.length; i++) {
      const win = sess.windows[i];
      const winPath = `${loadConfig().ghqRoot}/${win.repo}`;
      try {
        await ssh(`tmux new-window -t '${sess.name}' -n '${win.name}' -c '${winPath}'`);
        if (!sess.skip_command) {
          await ssh(`tmux send-keys -t '${sess.name}:${win.name}' '${buildCommand(win.name)}' Enter`);
        }
        winCount++;
      } catch {}
    }
    try {
      await ssh(`tmux select-window -t '${sess.name}:1'`);
    } catch {}
    sessCount++;
    console.log(`  \x1B[32m\u25CF\x1B[0m ${sess.name} \u2014 ${sess.windows.length} windows`);
  }
  console.log(`
  \x1B[32m${sessCount} sessions, ${winCount} windows woke up.\x1B[0m
`);
  if (opts.resume) {
    console.log(`  \x1B[36mResuming active board items...\x1B[0m
`);
    await resumeActiveItems();
  }
}

// src/commands/fleet-init.ts
init_ssh();
import { join as join8 } from "path";
import { existsSync as existsSync2, mkdirSync } from "fs";
var GROUPS = {
  pulse: { session: "pulse", order: 1 },
  hermes: { session: "hermes", order: 2 },
  neo: { session: "neo", order: 3 },
  homekeeper: { session: "homekeeper", order: 4 },
  volt: { session: "volt", order: 5 },
  floodboy: { session: "floodboy", order: 6 },
  fireman: { session: "fireman", order: 7 },
  dustboy: { session: "dustboy", order: 8 },
  dustboychain: { session: "dustboychain", order: 9 },
  arthur: { session: "arthur", order: 10 },
  calliope: { session: "calliope", order: 11 },
  odin: { session: "odin", order: 12 },
  mother: { session: "mother", order: 13 },
  nexus: { session: "nexus", order: 14 },
  xiaoer: { session: "xiaoer", order: 15 },
  lake: { session: "lake", order: 20 },
  sea: { session: "sea", order: 21 },
  phukhao: { session: "phukhao", order: 22 },
  shrimp: { session: "shrimp", order: 23 },
  tworivers: { session: "tworivers", order: 24 },
  brewsboy: { session: "brewsboy", order: 25 },
  natsbrain: { session: "natsbrain", order: 26 },
  opensourcenatbrain: { session: "opensourcenatbrain", order: 27 },
  maeoncraft: { session: "maeoncraft", order: 28 },
  maeon: { session: "maeoncraft", order: 28 },
  landing: { session: "landing", order: 29 }
};
async function cmdFleetInit() {
  const fleetDir = join8(import.meta.dir, "../../fleet");
  if (!existsSync2(fleetDir))
    mkdirSync(fleetDir, { recursive: true });
  console.log(`
  \x1B[36mScanning for oracle repos...\x1B[0m
`);
  const ghqOut = await ssh("ghq list --full-path");
  const allRepos = ghqOut.trim().split(`
`).filter(Boolean);
  const oracleRepos = [];
  for (const repoPath of allRepos) {
    const parts = repoPath.split("/");
    const repoName = parts.pop();
    const org = parts.pop();
    const parentDir = parts.join("/") + "/" + org;
    let oracleName = null;
    if (repoName.endsWith("-oracle")) {
      oracleName = repoName.replace(/-oracle$/, "").replace(/-/g, "");
    } else if (repoName === "homelab") {
      oracleName = "homekeeper";
    }
    if (!oracleName)
      continue;
    if (repoName.includes(".wt-"))
      continue;
    const worktrees = [];
    try {
      const wtOut = await ssh(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`);
      for (const wtPath of wtOut.split(`
`).filter(Boolean)) {
        const wtBase = wtPath.split("/").pop();
        const suffix = wtBase.replace(`${repoName}.wt-`, "");
        worktrees.push({
          name: `${oracleName}-${suffix}`,
          path: wtPath,
          repo: `${org}/${wtBase}`
        });
      }
    } catch {}
    oracleRepos.push({
      name: oracleName,
      path: repoPath,
      repo: `${org}/${repoName}`,
      worktrees
    });
    const wtInfo = worktrees.length > 0 ? ` + ${worktrees.length} worktrees` : "";
    console.log(`  found: ${oracleName.padEnd(15)} ${org}/${repoName}${wtInfo}`);
  }
  const sessionMap = new Map;
  for (const oracle of oracleRepos) {
    const group = GROUPS[oracle.name] || { session: oracle.name, order: 50 };
    const key = group.session;
    if (!sessionMap.has(key)) {
      sessionMap.set(key, { order: group.order, windows: [] });
    }
    const sess = sessionMap.get(key);
    sess.windows.push({ name: `${oracle.name}-oracle`, repo: oracle.repo });
    for (const wt of oracle.worktrees) {
      sess.windows.push({ name: wt.name, repo: wt.repo });
    }
  }
  console.log(`
  \x1B[36mWriting fleet configs...\x1B[0m
`);
  const sorted = [...sessionMap.entries()].sort((a, b) => a[1].order - b[1].order);
  let num = 1;
  for (const [groupName, data] of sorted) {
    const paddedNum = String(num).padStart(2, "0");
    const sessionName = `${paddedNum}-${groupName}`;
    const config = { name: sessionName, windows: data.windows };
    const filePath = join8(fleetDir, `${sessionName}.json`);
    await Bun.write(filePath, JSON.stringify(config, null, 2) + `
`);
    console.log(`  \x1B[32m\u2713\x1B[0m ${sessionName}.json \u2014 ${data.windows.length} windows`);
    num++;
  }
  if (oracleRepos.length > 0) {
    const overviewConfig = {
      name: "99-overview",
      windows: [{ name: "live", repo: oracleRepos[0].repo }],
      skip_command: true
    };
    await Bun.write(join8(fleetDir, "99-overview.json"), JSON.stringify(overviewConfig, null, 2) + `
`);
    console.log(`  \x1B[32m\u2713\x1B[0m 99-overview.json \u2014 1 window`);
  }
  console.log(`
  \x1B[32m${sorted.length + 1} fleet configs written to fleet/\x1B[0m`);
  console.log(`  Run \x1B[36mmaw wake all\x1B[0m to start the fleet.
`);
}

// src/commands/done.ts
init_ssh();
init_config();
import { readdirSync as readdirSync5, readFileSync as readFileSync5, writeFileSync as writeFileSync2 } from "fs";
import { join as join9 } from "path";
var FLEET_DIR2 = join9(import.meta.dir, "../../fleet");
async function cmdDone(windowName_) {
  let windowName = windowName_;
  const sessions = await listSessions();
  const ghqRoot = loadConfig().ghqRoot;
  const windowNameLower = windowName.toLowerCase();
  let sessionName = null;
  let windowIndex = null;
  for (const s of sessions) {
    const w = s.windows.find((w2) => w2.name.toLowerCase() === windowNameLower);
    if (w) {
      sessionName = s.name;
      windowIndex = w.index;
      windowName = w.name;
      break;
    }
  }
  if (sessionName !== null && windowIndex !== null) {
    try {
      await ssh(`tmux kill-window -t '${sessionName}:${windowName}'`);
      console.log(`  \x1B[32m\u2713\x1B[0m killed window ${sessionName}:${windowName}`);
    } catch {
      console.log(`  \x1B[33m\u26A0\x1B[0m could not kill window (may already be closed)`);
    }
  } else {
    console.log(`  \x1B[90m\u25CB\x1B[0m window '${windowName}' not running`);
  }
  let removedWorktree = false;
  try {
    for (const file of readdirSync5(FLEET_DIR2).filter((f) => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync5(join9(FLEET_DIR2, file), "utf-8"));
      const win = (config.windows || []).find((w) => w.name.toLowerCase() === windowNameLower);
      if (!win?.repo)
        continue;
      const fullPath = join9(ghqRoot, win.repo);
      if (win.repo.includes(".wt-")) {
        const parts = win.repo.split("/");
        const wtDir = parts.pop();
        const org = parts.join("/");
        const mainRepo = wtDir.split(".wt-")[0];
        const mainPath = join9(ghqRoot, org, mainRepo);
        try {
          let branch = "";
          try {
            branch = (await ssh(`git -C '${fullPath}' rev-parse --abbrev-ref HEAD`)).trim();
          } catch {}
          await ssh(`git -C '${mainPath}' worktree remove '${fullPath}' --force`);
          await ssh(`git -C '${mainPath}' worktree prune`);
          console.log(`  \x1B[32m\u2713\x1B[0m removed worktree ${win.repo}`);
          removedWorktree = true;
          if (branch && branch !== "main" && branch !== "HEAD") {
            try {
              await ssh(`git -C '${mainPath}' branch -d '${branch}'`);
              console.log(`  \x1B[32m\u2713\x1B[0m deleted branch ${branch}`);
            } catch {}
          }
        } catch (e) {
          console.log(`  \x1B[33m\u26A0\x1B[0m worktree remove failed: ${e.message || e}`);
        }
      }
      break;
    }
  } catch {}
  if (!removedWorktree) {
    try {
      const suffix = windowName.replace(/^[^-]+-/, "");
      const ghqOut = await ssh(`find ${ghqRoot} -maxdepth 3 -name '*.wt-*' -type d 2>/dev/null`);
      const allWtPaths = ghqOut.trim().split(`
`).filter(Boolean);
      const exactMatch = allWtPaths.filter((p) => {
        const base = p.split("/").pop();
        const wtSuffix = base.replace(/^.*\.wt-(?:\d+-)?/, "");
        return wtSuffix.toLowerCase() === suffix.toLowerCase();
      });
      for (const wtPath of exactMatch) {
        const base = wtPath.split("/").pop();
        const mainRepo = base.split(".wt-")[0];
        const mainPath = wtPath.replace(base, mainRepo);
        try {
          let branch = "";
          try {
            branch = (await ssh(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim();
          } catch {}
          await ssh(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
          await ssh(`git -C '${mainPath}' worktree prune`);
          console.log(`  \x1B[32m\u2713\x1B[0m removed worktree ${base}`);
          removedWorktree = true;
          if (branch && branch !== "main" && branch !== "HEAD") {
            try {
              await ssh(`git -C '${mainPath}' branch -d '${branch}'`);
              console.log(`  \x1B[32m\u2713\x1B[0m deleted branch ${branch}`);
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }
  if (!removedWorktree) {
    console.log(`  \x1B[90m\u25CB\x1B[0m no worktree to remove (may be a main window)`);
  }
  let removedFromConfig = false;
  try {
    for (const file of readdirSync5(FLEET_DIR2).filter((f) => f.endsWith(".json"))) {
      const filePath = join9(FLEET_DIR2, file);
      const config = JSON.parse(readFileSync5(filePath, "utf-8"));
      const before = config.windows?.length || 0;
      config.windows = (config.windows || []).filter((w) => w.name.toLowerCase() !== windowNameLower);
      if (config.windows.length < before) {
        writeFileSync2(filePath, JSON.stringify(config, null, 2) + `
`);
        console.log(`  \x1B[32m\u2713\x1B[0m removed from ${file}`);
        removedFromConfig = true;
      }
    }
  } catch {}
  if (!removedFromConfig) {
    console.log(`  \x1B[90m\u25CB\x1B[0m not in any fleet config`);
  }
  console.log();
}

// src/commands/log.ts
import { readFileSync as readFileSync6 } from "fs";
import { join as join10 } from "path";
import { homedir as homedir3 } from "os";
var LOG_FILE = join10(homedir3(), ".oracle", "maw-log.jsonl");
function readLog() {
  try {
    const raw = readFileSync6(LOG_FILE, "utf-8");
    return raw.split(`
`).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
function cmdLogLs(opts) {
  let entries = readLog();
  if (opts.from)
    entries = entries.filter((e) => e.from.toLowerCase().includes(opts.from.toLowerCase()));
  if (opts.to)
    entries = entries.filter((e) => e.to.toLowerCase().includes(opts.to.toLowerCase()));
  const limit = opts.limit || 20;
  const shown = entries.slice(-limit);
  if (shown.length === 0) {
    console.log(`
  \x1B[90mNo messages found.\x1B[0m
`);
    return;
  }
  console.log(`
  \x1B[36mmaw log\x1B[0m (${entries.length} total, showing last ${shown.length})
`);
  console.log(`  ${"Time".padEnd(8)} ${"From".padEnd(16)} ${"To".padEnd(16)} Message`);
  console.log(`  ${"\u2500".repeat(8)} ${"\u2500".repeat(16)} ${"\u2500".repeat(16)} ${"\u2500".repeat(40)}`);
  for (const e of shown) {
    const time = new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const from = e.from.slice(0, 15).padEnd(16);
    const to = e.to.slice(0, 15).padEnd(16);
    const msg = e.msg.slice(0, 60).replace(/\n/g, " ");
    console.log(`  ${time.padEnd(8)} \x1B[32m${from}\x1B[0m \x1B[33m${to}\x1B[0m ${msg}`);
  }
  console.log();
}
function cmdLogExport(opts) {
  let entries = readLog();
  if (opts.date) {
    entries = entries.filter((e) => e.ts.startsWith(opts.date));
  }
  if (opts.from)
    entries = entries.filter((e) => e.from.toLowerCase().includes(opts.from.toLowerCase()));
  if (opts.to)
    entries = entries.filter((e) => e.to.toLowerCase().includes(opts.to.toLowerCase()));
  if (opts.format === "json") {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  const dateLabel = opts.date || "all";
  console.log(`# Oracle Conversations \u2014 ${dateLabel}`);
  console.log();
  console.log(`> ${entries.length} messages`);
  console.log();
  for (const e of entries) {
    const time = new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const from = e.from.replace(/-oracle$/, "").replace(/-/g, " ");
    console.log(`**${time}** \u2014 **${from}** \u2192 ${e.to}`);
    console.log();
    console.log(e.msg);
    console.log();
    console.log("---");
    console.log();
  }
}

// src/cli.ts
process.env.MAW_CLI = "1";
var args = process.argv.slice(2);
var cmd = args[0]?.toLowerCase();
function usage() {
  console.log(`\x1B[36mmaw\x1B[0m \u2014 Multi-Agent Workflow

\x1B[33mUsage:\x1B[0m
  maw ls                      List sessions + windows
  maw peek [agent]            Peek agent screen (or all)
  maw hey <agent> <msg...>    Send message to agent (alias: tell)
  maw wake <oracle> [task]    Wake oracle in tmux window + claude
  maw wake <oracle> --issue N Wake oracle with GitHub issue as prompt
  maw fleet init              Scan ghq repos, generate fleet/*.json
  maw fleet ls                List fleet configs with conflict detection
  maw fleet renumber          Fix numbering conflicts (sequential)
  maw fleet validate          Check for problems (dupes, orphans, missing repos)
  maw fleet sync              Add unregistered windows to fleet configs
  maw wake all [--kill]       Wake fleet (01-15 + 99, skips dormant 20+)
  maw wake all --all          Wake ALL including dormant
  maw wake all --resume       Wake fleet + send /recap to active board items
  maw stop                    Stop all fleet sessions
  maw about <oracle>           Oracle profile \u2014 session, worktrees, fleet
  maw oracle ls               Fleet status (awake/sleeping/worktrees)
  maw overview              War-room: all oracles in split panes
  maw overview neo hermes   Only specific oracles
  maw overview --kill       Tear down overview
  maw done <window>            Clean up finished worktree window
  maw pulse add "task" [opts] Create issue + wake oracle
  maw pulse cleanup [--dry-run] Clean stale/orphan worktrees
  maw view <agent> [window]   Grouped tmux session (interactive attach)
  maw create-view <agent> [w] Alias for view
  maw view <agent> --clean    Hide status bar (full screen)
  maw <agent> <msg...>        Shorthand for hey
  maw <agent>                 Shorthand for peek
  maw serve [port]            Start web UI (default: 3456)

\x1B[33mWake modes:\x1B[0m
  maw wake neo                Wake main repo
  maw wake hermes bitkub      Wake existing worktree
  maw wake neo --new free     Create worktree + wake
  maw wake neo --issue 5      Fetch issue #5 + send as claude -p prompt
  maw wake neo --issue 5 --repo org/repo   Explicit repo

\x1B[33mPulse add:\x1B[0m
  maw pulse ls                Board table (terminal)
  maw pulse ls --sync         + update daily thread checkboxes
  maw pulse add "Fix bug" --oracle neo
  maw pulse add "task" --oracle neo --wt oracle-v2

\x1B[33mEnv:\x1B[0m
  MAW_HOST=white.local        SSH target (default: white.local)

\x1B[33mExamples:\x1B[0m
  maw wake neo --new bitkub   Create worktree + start claude
  maw pulse add "Fix IME" --oracle neo --priority P1
  maw hey neo what is your status
  maw serve 8080`);
}
if (cmd === "--version" || cmd === "-v") {
  const pkg = require_package();
  let hash = "";
  try {
    hash = __require("child_process").execSync("git rev-parse --short HEAD", { cwd: import.meta.dir }).toString().trim();
  } catch {}
  console.log(`maw v${pkg.version}${hash ? ` (${hash})` : ""}`);
} else if (!cmd || cmd === "--help" || cmd === "-h") {
  usage();
} else if (cmd === "ls" || cmd === "list") {
  await cmdList();
} else if (cmd === "peek" || cmd === "see") {
  await cmdPeek(args[1]);
} else if (cmd === "hey" || cmd === "send" || cmd === "tell") {
  const force = args.includes("--force");
  const msgArgs = args.slice(2).filter((a) => a !== "--force");
  if (!args[1] || !msgArgs.length) {
    console.error("usage: maw hey <agent> <message> [--force]");
    process.exit(1);
  }
  await cmdSend(args[1], msgArgs.join(" "), force);
} else if (cmd === "fleet" && args[1] === "init") {
  await cmdFleetInit();
} else if (cmd === "fleet" && args[1] === "ls") {
  await cmdFleetLs();
} else if (cmd === "fleet" && args[1] === "renumber") {
  await cmdFleetRenumber();
} else if (cmd === "fleet" && args[1] === "validate") {
  await cmdFleetValidate();
} else if (cmd === "fleet" && args[1] === "sync") {
  await cmdFleetSync();
} else if (cmd === "fleet" && !args[1]) {
  await cmdFleetLs();
} else if (cmd === "log") {
  const sub = args[1]?.toLowerCase();
  if (sub === "export") {
    const logOpts = {};
    for (let i = 2;i < args.length; i++) {
      if (args[i] === "--date" && args[i + 1])
        logOpts.date = args[++i];
      else if (args[i] === "--from" && args[i + 1])
        logOpts.from = args[++i];
      else if (args[i] === "--to" && args[i + 1])
        logOpts.to = args[++i];
      else if (args[i] === "--format" && args[i + 1])
        logOpts.format = args[++i];
    }
    cmdLogExport(logOpts);
  } else {
    const logOpts = {};
    for (let i = 1;i < args.length; i++) {
      if (args[i] === "--limit" && args[i + 1])
        logOpts.limit = +args[++i];
      else if (args[i] === "--from" && args[i + 1])
        logOpts.from = args[++i];
      else if (args[i] === "--to" && args[i + 1])
        logOpts.to = args[++i];
    }
    cmdLogLs(logOpts);
  }
} else if (cmd === "done" || cmd === "finish") {
  if (!args[1]) {
    console.error(`usage: maw done <window-name>
       e.g. maw done neo-freelance`);
    process.exit(1);
  }
  await cmdDone(args[1]);
} else if (cmd === "stop" || cmd === "sleep" || cmd === "rest") {
  await cmdSleep();
} else if (cmd === "wake") {
  if (!args[1]) {
    console.error(`usage: maw wake <oracle> [task] [--new <name>]
       maw wake all [--kill]`);
    process.exit(1);
  }
  if (args[1].toLowerCase() === "all") {
    await cmdWakeAll({ kill: args.includes("--kill"), all: args.includes("--all"), resume: args.includes("--resume") });
  } else {
    const wakeOpts = {};
    let issueNum = null;
    let repo;
    for (let i = 2;i < args.length; i++) {
      if (args[i] === "--new" && args[i + 1]) {
        wakeOpts.newWt = args[++i];
      } else if (args[i] === "--issue" && args[i + 1]) {
        issueNum = +args[++i];
      } else if (args[i] === "--repo" && args[i + 1]) {
        repo = args[++i];
      } else if (!wakeOpts.task) {
        wakeOpts.task = args[i];
      }
    }
    if (issueNum) {
      console.log(`\x1B[36m\u26A1\x1B[0m fetching issue #${issueNum}...`);
      wakeOpts.prompt = await fetchIssuePrompt(issueNum, repo);
      if (!wakeOpts.task)
        wakeOpts.task = `issue-${issueNum}`;
    }
    await cmdWake(args[1], wakeOpts);
  }
} else if (cmd === "pulse") {
  const subcmd = args[1];
  if (subcmd === "add") {
    const pulseOpts = {};
    let title = "";
    for (let i = 2;i < args.length; i++) {
      if (args[i] === "--oracle" && args[i + 1]) {
        pulseOpts.oracle = args[++i];
      } else if (args[i] === "--priority" && args[i + 1]) {
        pulseOpts.priority = args[++i];
      } else if ((args[i] === "--wt" || args[i] === "--worktree") && args[i + 1]) {
        pulseOpts.wt = args[++i];
      } else if (!title) {
        title = args[i];
      }
    }
    if (!title) {
      console.error('usage: maw pulse add "task title" --oracle <name> [--wt <repo>]');
      process.exit(1);
    }
    await cmdPulseAdd(title, pulseOpts);
  } else if (subcmd === "ls" || subcmd === "list") {
    const sync = args.includes("--sync");
    await cmdPulseLs({ sync });
  } else if (subcmd === "cleanup" || subcmd === "clean") {
    const { scanWorktrees: scanWorktrees2, cleanupWorktree: cleanupWorktree2 } = await Promise.resolve().then(() => (init_worktrees(), exports_worktrees));
    const worktrees = await scanWorktrees2();
    const stale = worktrees.filter((wt) => wt.status !== "active");
    if (!stale.length) {
      console.log("\x1B[32m\u2713\x1B[0m All worktrees are active. Nothing to clean.");
      process.exit(0);
    }
    console.log(`
\x1B[36mWorktree Cleanup\x1B[0m
`);
    console.log(`  \x1B[32m${worktrees.filter((w) => w.status === "active").length} active\x1B[0m | \x1B[33m${worktrees.filter((w) => w.status === "stale").length} stale\x1B[0m | \x1B[31m${worktrees.filter((w) => w.status === "orphan").length} orphan\x1B[0m
`);
    for (const wt of stale) {
      const color = wt.status === "orphan" ? "\x1B[31m" : "\x1B[33m";
      console.log(`${color}${wt.status}\x1B[0m  ${wt.name} (${wt.mainRepo}) [${wt.branch}]`);
      if (!args.includes("--dry-run")) {
        const log = await cleanupWorktree2(wt.path);
        for (const line of log)
          console.log(`  \x1B[32m\u2713\x1B[0m ${line}`);
      }
    }
    if (args.includes("--dry-run"))
      console.log(`
\x1B[90m(dry run \u2014 use without --dry-run to clean)\x1B[0m`);
    console.log();
  } else {
    console.error("usage: maw pulse <add|ls|cleanup> [opts]");
    process.exit(1);
  }
} else if (cmd === "overview" || cmd === "warroom" || cmd === "ov") {
  await cmdOverview(args.slice(1));
} else if (cmd === "about" || cmd === "info") {
  if (!args[1]) {
    console.error("usage: maw about <oracle>");
    process.exit(1);
  }
  await cmdOracleAbout(args[1]);
} else if (cmd === "oracle" || cmd === "oracles") {
  const subcmd = args[1]?.toLowerCase();
  if (!subcmd || subcmd === "ls" || subcmd === "list") {
    await cmdOracleList();
  } else {
    console.error("usage: maw oracle ls");
    process.exit(1);
  }
} else if (cmd === "completions") {
  await cmdCompletions(args[1]);
} else if (cmd === "view" || cmd === "create-view" || cmd === "attach") {
  if (!args[1]) {
    console.error("usage: maw view <agent> [window] [--clean]");
    process.exit(1);
  }
  const clean = args.includes("--clean");
  const viewArgs = args.slice(1).filter((a) => a !== "--clean");
  await cmdView(viewArgs[0], viewArgs[1], clean);
} else if (cmd === "serve") {
  const { startServer: startServer2 } = await Promise.resolve().then(() => (init_server2(), exports_server));
  startServer2(args[1] ? +args[1] : 3456);
} else {
  if (args.length >= 2) {
    const f = args.includes("--force");
    const m = args.slice(1).filter((a) => a !== "--force");
    await cmdSend(args[0], m.join(" "), f);
  } else {
    await cmdPeek(args[0]);
  }
}
