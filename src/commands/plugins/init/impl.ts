import { homedir, hostname } from "os";
import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { CONFIG_FILE, FLEET_DIR } from "../../../core/paths";
import { runPromptLoop, ttyAsk, type AskFn } from "./prompts";
import { parseNonInteractive } from "./non-interactive";
import {
  buildConfig,
  configExists,
  backupConfig,
  writeConfigAtomic,
} from "./write-config";
import { generateFederationToken } from "./federation";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const GRAY = "\x1b[90m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function detectGhqRoot(): string {
  try {
    const root = execSync("ghq root", { encoding: "utf-8" }).trim();
    const ghRoot = join(root, "github.com");
    if (existsSync(ghRoot)) return ghRoot;
    return root;
  } catch {
    return join(homedir(), "Code/github.com");
  }
}

function defaults() {
  return { node: hostname(), ghqRoot: detectGhqRoot() };
}

export type ExistingChoice = "overwrite" | "backup" | "abort";

export async function chooseExistingAction(ask: AskFn, defaultChoice: ExistingChoice = "abort"): Promise<ExistingChoice> {
  const ans = (await ask("Existing config found — [o]verwrite, [b]ackup+overwrite, [A]bort", "")).toLowerCase();
  if (ans === "o" || ans === "overwrite") return "overwrite";
  if (ans === "b" || ans === "backup") return "backup";
  if (ans === "a" || ans === "abort" || ans === "") return defaultChoice;
  return defaultChoice;
}

export interface CmdInitOpts {
  args: string[];
  /** Override prompt for tests */
  ask?: AskFn;
  /** Override writer (default console.log) */
  writer?: (msg: string) => void;
}

export interface CmdInitResult {
  ok: boolean;
  error?: string;
  configPath?: string;
  config?: Record<string, unknown>;
}

export async function cmdInit(opts: CmdInitOpts): Promise<CmdInitResult> {
  const ask = opts.ask ?? ttyAsk;
  const write = opts.writer ?? ((m: string) => console.log(m));
  const isNonInteractive = opts.args.includes("--non-interactive");
  const home = homedir();
  const def = defaults();

  if (isNonInteractive) {
    const parsed = parseNonInteractive(opts.args, home, def);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    if (configExists(CONFIG_FILE) && !parsed.opts.force) {
      return { ok: false, error: `Config exists at ${CONFIG_FILE}. Use --force to overwrite.` };
    }

    const federationToken = parsed.opts.federate
      ? (parsed.opts.federationToken ?? generateFederationToken())
      : undefined;

    const config = buildConfig({
      node: parsed.opts.node,
      ghqRoot: parsed.opts.ghqRoot,
      token: parsed.opts.token,
      federate: parsed.opts.federate,
      peers: parsed.opts.peers,
      federationToken,
    });

    writeConfigAtomic(CONFIG_FILE, config, /* overwrite */ true);
    write(`${GREEN}✓${RESET} Wrote ${CONFIG_FILE}`);
    if (federationToken && parsed.opts.federate) {
      write(`${CYAN}federation token${RESET}: ${federationToken}`);
      write(`${GRAY}  share with each peer in their maw.config.json${RESET}`);
    }
    return { ok: true, configPath: CONFIG_FILE, config };
  }

  // ─── interactive mode ──────────────────────────────────────────────
  write(`${BOLD}maw init${RESET} — first-run setup`);
  write("");

  if (configExists(CONFIG_FILE)) {
    write(`${GRAY}Found existing config at ${CONFIG_FILE}${RESET}`);
    const choice = await chooseExistingAction(ask);
    if (choice === "abort") {
      write("Aborted. Existing config untouched.");
      return { ok: true };
    }
    if (choice === "backup") {
      const bak = backupConfig(CONFIG_FILE);
      write(`${GREEN}✓${RESET} backed up to ${bak}`);
    }
  }

  let answers;
  try {
    answers = await runPromptLoop(ask, def, home, write);
  } catch (e: any) {
    return { ok: false, error: e.message };
  }

  const federationToken = answers.federate ? generateFederationToken() : undefined;

  const config = buildConfig({
    node: answers.node,
    ghqRoot: answers.ghqRoot,
    token: answers.token,
    federate: answers.federate,
    peers: answers.peers,
    federationToken,
  });

  writeConfigAtomic(CONFIG_FILE, config, /* overwrite */ true);

  write("");
  write(`${GREEN}✓${RESET} Wrote ${CONFIG_FILE}`);
  if (existsSync(FLEET_DIR)) {
    const fleetCount = readdirSync(FLEET_DIR).filter(f => f.endsWith(".json")).length;
    write(`${GREEN}✓${RESET} Fleet dir ready: ${FLEET_DIR} ${GRAY}(${fleetCount} entr${fleetCount === 1 ? "y" : "ies"})${RESET}`);
  }

  if (federationToken) {
    write("");
    write(`${CYAN}Generated federation token${RESET} (share with all peers):`);
    write(`  ${federationToken}`);
    write(`${GRAY}  copy this verbatim into each peer's maw.config.json under "federationToken"${RESET}`);
  }

  write("");
  write(`${BOLD}Next steps${RESET}:`);
  write(`  maw serve              ${GRAY}# start the local daemon${RESET}`);
  write(`  maw wake <repo>        ${GRAY}# spawn your first agent${RESET}`);
  write(`  maw bud <name>         ${GRAY}# create a new oracle (writes fleet/<NN>-<name>.json)${RESET}`);

  return { ok: true, configPath: CONFIG_FILE, config };
}
