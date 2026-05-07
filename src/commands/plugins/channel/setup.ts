import { existsSync, readFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import {
  loadOracleChannels, saveOracleChannels,
  type ChannelPlugin,
} from "../../shared/channel-loader";

const CHANNELS_BASE = join(homedir(), ".claude", "channels");
const PLUGINS_CACHE = join(homedir(), ".claude/plugins/cache/claude-plugins-official");

interface SetupOpts {
  pass?: string;
  guild?: string;
  env?: Record<string, string>;
  nonInteractive?: boolean;
}

function isInstalled(provider: string): boolean {
  return existsSync(join(PLUGINS_CACHE, provider));
}

function extractClientId(token: string): string | null {
  try {
    const first = token.split(".")[0];
    return Buffer.from(first + "==", "base64").toString("utf8");
  } catch { return null; }
}

// #1170 — use native fetch instead of execSync curl: shell-spawned curl puts
// the token in process argv (visible to `ps`, EDR, crash logs). fetch keeps
// the token in-memory in this process only. AbortSignal.timeout matches the
// 10s subprocess timeout this replaced.
async function fetchGuilds(token: string): Promise<Array<{ id: string; name: string }>> {
  try {
    const r = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return [];
    const data = await r.json() as any[];
    return data.map((g) => ({ id: g.id, name: g.name }));
  } catch { return []; }
}

function getTokenFromPass(passKey: string): string | null {
  try {
    return execSync(`pass show ${passKey}`, { encoding: "utf8", timeout: 5000 }).trim() || null;
  } catch { return null; }
}

export async function runSetup(oracle: string, provider: string, args: string[]) {
  if (!oracle || !provider) {
    console.log("  usage: maw channel setup <oracle> <provider>");
    console.log("         maw channel setup hermes-discord discord");
    console.log("         maw channel setup myoracle github:ARRA-01/claude-channel-relay");
    return;
  }

  const opts: SetupOpts = { env: {} };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pass" && args[i + 1]) { opts.pass = args[++i]; continue; }
    if (args[i] === "--guild" && args[i + 1]) { opts.guild = args[++i]; continue; }
    if (args[i] === "--env" && args[i + 1]?.includes("=")) {
      const [k, ...v] = args[++i].split("=");
      opts.env![k] = v.join("=");
      continue;
    }
    if (args[i] === "--no-interactive") { opts.nonInteractive = true; continue; }
  }

  if (provider === "discord" || provider === "telegram" || provider === "imessage") {
    await setupOfficial(oracle, provider, opts);
  } else if (provider.startsWith("github:")) {
    await setupGit(oracle, provider, opts);
  } else {
    console.log(`  \x1b[31m✗\x1b[0m unknown provider: ${provider}`);
    console.log("  supported: discord, telegram, imessage, github:<org>/<repo>");
  }
}

async function setupOfficial(oracle: string, provider: string, opts: SetupOpts) {
  const pluginId = `plugin:${provider}@claude-plugins-official`;
  const stateDir = join(CHANNELS_BASE, oracle);
  let step = 0;
  const total = provider === "imessage" ? 4 : 7;

  const s = (n: number, label: string) => {
    step = n;
    console.log(`\n  \x1b[36mStep ${n}/${total}: ${label}\x1b[0m`);
  };

  console.log(`\n  \x1b[36;1m🔧 ${provider} Channel Setup for ${oracle}\x1b[0m`);
  console.log(`  ${"─".repeat(45)}`);

  // Step 1: Plugin check
  s(1, "Plugin check");
  if (isInstalled(provider)) {
    console.log(`  \x1b[32m✓\x1b[0m ${pluginId} installed`);
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${pluginId} not installed`);
    console.log(`  \x1b[90mrun: /plugin install ${provider}@claude-plugins-official\x1b[0m`);
    return;
  }

  if (provider === "imessage") {
    // iMessage — minimal setup
    s(2, "macOS check");
    if (process.platform !== "darwin") {
      console.log(`  \x1b[31m✗\x1b[0m iMessage requires macOS`);
      return;
    }
    console.log(`  \x1b[32m✓\x1b[0m macOS detected`);
    console.log(`  \x1b[90mℹ Full Disk Access required for Messages.app — grant when prompted\x1b[0m`);

    s(3, "Register channel");
    const config = loadOracleChannels(oracle) || { plugins: [] };
    if (!config.plugins.some(p => p.id === pluginId)) {
      config.plugins.push({ id: pluginId });
      saveOracleChannels(oracle, config);
    }
    console.log(`  \x1b[32m✓\x1b[0m registered`);

    s(4, "Done!");
    printNextSteps(oracle, provider);
    return;
  }

  // Discord / Telegram — full setup
  // Step 2: Token
  s(2, "Bot token");
  let token: string | null = null;
  const envFile = join(stateDir, ".env");

  if (opts.pass) {
    token = getTokenFromPass(opts.pass);
    if (token) {
      console.log(`  \x1b[32m✓\x1b[0m token from pass: ${opts.pass}`);
    } else {
      console.log(`  \x1b[31m✗\x1b[0m pass key '${opts.pass}' not found`);
      console.log(`  \x1b[90mrun: pass insert ${opts.pass}\x1b[0m`);
      return;
    }
  } else if (existsSync(envFile)) {
    const envContent = readFileSync(envFile, "utf8");
    const tokenKey = provider === "discord" ? "DISCORD_BOT_TOKEN" : "TELEGRAM_BOT_TOKEN";
    const m = envContent.match(new RegExp(`${tokenKey}=(.+)`));
    if (m) {
      token = m[1].trim();
      console.log(`  \x1b[32m✓\x1b[0m token found in .env`);
    }
  }

  if (!token) {
    console.log(`  \x1b[33m⚠\x1b[0m no token found`);
    console.log(`  \x1b[90mstore with: pass insert ${provider}/${oracle}-token\x1b[0m`);
    console.log(`  \x1b[90mthen: maw channel setup ${oracle} ${provider} --pass ${provider}/${oracle}-token\x1b[0m`);
    return;
  }

  // Validate token
  if (provider === "discord") {
    const clientId = extractClientId(token);
    if (clientId) console.log(`  \x1b[90mclient: ${clientId}\x1b[0m`);
  }

  // Step 3: State dir
  s(3, "State directory");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  console.log(`  \x1b[32m✓\x1b[0m ${stateDir.replace(homedir(), "~")}/`);

  // Write token to .env if not from pass
  if (!opts.pass) {
    const tokenKey = provider === "discord" ? "DISCORD_BOT_TOKEN" : "TELEGRAM_BOT_TOKEN";
    const { writeFileSync } = require("fs");
    writeFileSync(envFile, `${tokenKey}=${token}\n`);
    chmodSync(envFile, 0o600);
    console.log(`  \x1b[32m✓\x1b[0m .env written (0o600)`);
  }

  // Step 4: Guild (Discord only)
  if (provider === "discord") {
    s(4, "Guild / Server");
    const guilds = await fetchGuilds(token);
    if (guilds.length > 0) {
      for (let i = 0; i < guilds.length; i++) {
        const selected = opts.guild === guilds[i].id ? " ←" : "";
        console.log(`    ${i + 1}. ${guilds[i].name} (${guilds[i].id})${selected}`);
      }
      const guild = opts.guild ? guilds.find(g => g.id === opts.guild) : guilds[0];
      if (guild) {
        console.log(`  \x1b[32m✓\x1b[0m guild: ${guild.name}`);
      }
    } else {
      console.log(`  \x1b[33m⚠\x1b[0m no guilds found — bot may need to be invited first`);
      const clientId = extractClientId(token);
      if (clientId) {
        console.log(`  \x1b[90minvite: https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=101376\x1b[0m`);
      }
    }
  } else {
    s(4, "Config");
    console.log(`  \x1b[32m✓\x1b[0m ready`);
  }

  // Step 5: Access config + auto-seed Nat
  s(5, "Access config + seed");
  const accessPath = join(stateDir, "access.json");
  const NAT_DISCORD_ID = "691531480689541170";
  const seedAccess = {
    dmPolicy: "allowlist",
    allowFrom: [NAT_DISCORD_ID],
    groups: {},
    pending: {},
  };

  if (!existsSync(accessPath)) {
    writeFileSync(accessPath, JSON.stringify(seedAccess, null, 2) + "\n");
    console.log(`  \x1b[32m✓\x1b[0m access.json seeded (Nat pre-approved, dmPolicy: allowlist)`);
    console.log(`  \x1b[90mno pairing needed — Nat can DM immediately\x1b[0m`);
  } else {
    // Check if Nat is already in allowFrom
    try {
      const existing = JSON.parse(readFileSync(accessPath, "utf8"));
      if (!existing.allowFrom?.includes(NAT_DISCORD_ID)) {
        existing.allowFrom = existing.allowFrom || [];
        existing.allowFrom.push(NAT_DISCORD_ID);
        existing.dmPolicy = "allowlist";
        delete existing.pending;
        existing.pending = {};
        writeFileSync(accessPath, JSON.stringify(existing, null, 2) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m Nat seeded into existing access.json`);
      } else {
        console.log(`  \x1b[32m✓\x1b[0m Nat already in allowlist`);
      }
    } catch {
      writeFileSync(accessPath, JSON.stringify(seedAccess, null, 2) + "\n");
      console.log(`  \x1b[32m✓\x1b[0m access.json reset + Nat seeded`);
    }
  }

  // Step 6: Register
  s(6, "Register channel");
  const config = loadOracleChannels(oracle) || { plugins: [] };
  const newPlugin: ChannelPlugin = { id: pluginId };
  if (provider === "discord") {
    newPlugin.env = { DISCORD_STATE_DIR: `~/${stateDir.replace(homedir() + "/", "")}` };
  }
  if (opts.pass) {
    config.token_source = `pass:${opts.pass}`;
  }

  if (!config.plugins.some(p => p.id === pluginId)) {
    config.plugins.push(newPlugin);
    saveOracleChannels(oracle, config);
    console.log(`  \x1b[32m✓\x1b[0m registered: ${oracle} → ${pluginId}`);
  } else {
    console.log(`  \x1b[32m✓\x1b[0m already registered`);
  }

  // Step 7: Next steps
  s(7, "Done!");
  printNextSteps(oracle, provider);
}

async function setupGit(oracle: string, source: string, opts: SetupOpts) {
  const repo = source.replace(/^github:/, "");
  console.log(`\n  \x1b[36;1m🔧 Git Channel Setup for ${oracle}\x1b[0m`);
  console.log(`  ${"─".repeat(45)}`);

  // Step 1: Clone
  console.log(`\n  \x1b[36mStep 1/5: Clone\x1b[0m`);
  let repoPath: string;
  try {
    const ghqRoot = execSync("ghq root", { encoding: "utf8" }).trim();
    repoPath = join(ghqRoot, "github.com", repo);
    if (!existsSync(repoPath)) {
      console.log(`  \x1b[90mcloning ${repo}...\x1b[0m`);
      execSync(`ghq get https://github.com/${repo}`, { timeout: 30000 });
    }
    console.log(`  \x1b[32m✓\x1b[0m ${repoPath.replace(homedir(), "~")}`);
  } catch (e: any) {
    console.log(`  \x1b[31m✗\x1b[0m clone failed: ${e.message}`);
    return;
  }

  // Step 2: Install deps
  console.log(`\n  \x1b[36mStep 2/5: Dependencies\x1b[0m`);
  if (existsSync(join(repoPath, "package.json"))) {
    try {
      execSync("bun install", { cwd: repoPath, timeout: 30000, stdio: "pipe" });
      console.log(`  \x1b[32m✓\x1b[0m bun install complete`);
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m bun install failed — may still work`);
    }
  } else {
    console.log(`  \x1b[90mno package.json — skipping\x1b[0m`);
  }

  // Step 3: Detect MCP server
  console.log(`\n  \x1b[36mStep 3/5: Detect MCP server\x1b[0m`);
  let serverName = "relay";
  let serverCmd = "bun";
  let serverArgs = ["run", "--cwd", repoPath, "start"];

  const mcpJson = join(repoPath, ".mcp.json");
  if (existsSync(mcpJson)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpJson, "utf8"));
      const servers = Object.entries(mcp.mcpServers || {});
      if (servers.length > 0) {
        const [name, cfg] = servers[0] as [string, any];
        serverName = name;
        serverCmd = cfg.command || "bun";
        serverArgs = (cfg.args || []).map((a: string) =>
          a.replace("${CLAUDE_PLUGIN_ROOT}", repoPath),
        );
        console.log(`  \x1b[32m✓\x1b[0m found server: ${serverName}`);
        console.log(`  \x1b[90m${serverCmd} ${serverArgs.join(" ")}\x1b[0m`);
      }
    } catch { /* skip */ }
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m no .mcp.json — using defaults`);
  }

  // Step 4: Register
  console.log(`\n  \x1b[36mStep 4/5: Register channel\x1b[0m`);
  const pluginId = `server:${serverName}`;
  const config = loadOracleChannels(oracle) || { plugins: [] };
  const newPlugin: ChannelPlugin = {
    id: pluginId,
    env: { ...opts.env },
  };
  (newPlugin as any).source = `github:${repo}`;
  (newPlugin as any).path = repoPath;
  (newPlugin as any).mcp = { command: serverCmd, args: serverArgs };
  (newPlugin as any).dev = true;

  if (opts.pass) config.token_source = `pass:${opts.pass}`;

  if (!config.plugins.some(p => p.id === pluginId)) {
    config.plugins.push(newPlugin);
    saveOracleChannels(oracle, config);
    console.log(`  \x1b[32m✓\x1b[0m registered: ${oracle} → ${pluginId} [dev]`);
  } else {
    console.log(`  \x1b[32m✓\x1b[0m already registered`);
  }

  // Step 5: Done
  console.log(`\n  \x1b[36mStep 5/5: Done!\x1b[0m`);
  console.log(`\n  \x1b[32m✅ Setup complete!\x1b[0m\n`);
  console.log(`  Start oracle with channels:`);
  console.log(`    \x1b[36mmaw wake ${oracle}\x1b[0m`);
  console.log(`\n  \x1b[90mNote: git channels use --dangerously-load-development-channels\x1b[0m`);
  console.log(`  \x1b[90mSource: github:${repo}\x1b[0m`);
}

function printNextSteps(oracle: string, provider: string) {
  console.log(`\n  \x1b[32m✅ Setup complete!\x1b[0m\n`);
  console.log(`  Start oracle with channels:`);
  console.log(`    \x1b[36mmaw wake ${oracle}\x1b[0m\n`);
  console.log(`  \x1b[90mNat pre-approved — no pairing needed. Bot responds immediately.\x1b[0m`);
  if (provider !== "imessage") {
    console.log(`  \x1b[90mAdd others: /discord:access allow <user-id>\x1b[0m`);
  }
}
