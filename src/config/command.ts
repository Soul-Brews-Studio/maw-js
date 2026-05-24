import { loadConfig } from "./load";
import { homedir } from "os";
import { hasContinuableSession } from "../core/util/claude-projects";

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Channel config (`~/.claude/channels/<oracle>/config.json`) accepts paths
 * like `"~/.claude/channels/foo"` in env values. JSON has no shell, so the
 * tilde reaches `buildCommand` as a literal `~`. The env-prepend block
 * single-quotes values, which suppresses tilde expansion at exec time too,
 * so the plugin sees `DISCORD_STATE_DIR=~/.claude/...` literally and either
 * fails to find the dir or silently falls back to a default.
 *
 * Expand here, before quoting. Only triggers when `~` is the first character
 * and followed by `/` or end-of-string — won't touch usernames embedded
 * elsewhere in the value. (#1135)
 */
function expandTilde(value: string): string {
  return value.replace(/^~(?=\/|$)/, homedir());
}

function matchGlob(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export interface BuildCommandOpts {
  engine?: string;
  channels?: string[];
  channelEnv?: Record<string, string>;
  devChannels?: boolean;
  /**
   * #1146 — gate `--dangerously-skip-permissions` injection for channel-enabled bots.
   *   "skip" (default) — inject the flag (current behavior, autonomous bots).
   *   "relay"          — omit the flag; permission prompts flow through the channel
   *                      (e.g. Discord DM ✅/❌ buttons via the MCP permission relay).
   * Only meaningful when `channels` is non-empty. Undefined ⇒ "skip" semantics
   * so existing setups are unchanged.
   */
  permissionMode?: "skip" | "relay";
  /**
   * Resume a specific engine session by id.
   * - claude: emits `claude … --resume "<id>"` (UUID from ~/.claude/projects)
   * - codex:  emits `codex resume "<id>" …`     (id from session_meta payload)
   *
   * Used by directed-inbox routing to pin follow-up wakes for one campaign to
   * the same conversation instead of spawning fresh sessions every time.
   */
  resume?: string;
  /**
   * Strip `--continue` / `--resume` and skip the `||` shell-fallback. Set
   * by `--fresh` callers OR auto-detected by `buildCommandInDir` when the
   * target cwd has no JSONL under `~/.claude/projects/<encoded>/`. Without
   * this, `claude --continue` exits 0 with "No conversation found to
   * continue" in a fresh cwd, so the `||` fallback never fires and the
   * pane lands at an empty shell with the prompt discarded.
   */
  fresh?: boolean;
  /**
   * First-message prompt for the agent. Baked into the command as
   * - claude: `-p '<escaped>'`
   * - codex:  positional `'<escaped>'`
   *
   * The prompt is baked INSIDE the `{ … }` brace group and BEFORE the
   * `; <reset>` suffix. Appending `-p` to buildCommand()'s *return value*
   * (the pre-#541 pattern, reintroduced by the LOC-round-4 refactor) puts
   * the flag on the trailing `clear`, not on `claude`, so the prompt is
   * silently dropped and the pane lands idle at an empty input box. When
   * the `||` fallback is emitted the prompt is baked into BOTH branches so
   * it lands regardless of which one runs.
   */
  prompt?: string;
}

export function buildCommand(agentName: string, optsOrEngine?: string | BuildCommandOpts): string {
  const opts: BuildCommandOpts = typeof optsOrEngine === "string"
    ? { engine: optsOrEngine }
    : (optsOrEngine || {});
  const config = loadConfig();
  let cmd: string;

  if (opts.engine && config.commands[opts.engine]) {
    cmd = config.commands[opts.engine];
  } else if (opts.engine === "codex") {
    // Fleet may pin engine=codex before local config defines commands.codex.
    // Keep a safe built-in fallback so wake still launches the requested engine.
    cmd = "codex";
  } else {
    cmd = config.commands.default || "claude";
    for (const [pattern, command] of Object.entries(config.commands)) {
      if (pattern === "default") continue;
      if (matchGlob(pattern, agentName)) { cmd = command; break; }
    }
  }

  // Prepend channel env vars directly to command (not tmux set-environment)
  // because tmux set-environment only affects NEW shells, not the existing one.
  //
  // #1148 — defer to shell env when set. Precedence: shell env (non-empty)
  // wins over channel config.json. Empty-string env is treated as unset
  // (otherwise stale `export DISCORD_STATE_DIR=` would silently disable
  // the config value — same #1135 trap shape through a different door).
  if (opts.channelEnv && Object.keys(opts.channelEnv).length > 0) {
    const envPrefix = Object.entries(opts.channelEnv)
      .filter(([k]) => process.env[k] === undefined || process.env[k] === "")
      .map(([k, v]) => `${k}='${expandTilde(v).replace(/'/g, "'\\''")}'`)
      .join(" ");
    if (envPrefix) cmd = `${envPrefix} ${cmd}`;
  }

  if (opts.channels?.length) {
    cmd += " --channels " + opts.channels.join(" ");
    // #1108: channel-enabled oracles (Discord/Telegram bots) run autonomous —
    // permission prompts block unattended sessions (Mother stuck 20+ min).
    //
    // #1146: opt-out via permissionMode: "relay". When set, the bot keeps the
    // channel + --continue plumbing but the skip flag is omitted so that
    // permission prompts route through the channel (e.g. Discord DM ✅/❌).
    // Default (undefined or "skip") preserves the #1108 behavior.
    if (opts.permissionMode !== "relay" && !cmd.includes("--dangerously-skip-permissions")) {
      cmd += " --dangerously-skip-permissions";
    }
  }
  if (opts.devChannels) {
    cmd += " --dangerously-load-development-channels";
  }

  const stripEnvPrefix = (value: string): string =>
    value.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:'[^']*'|\S*)\s+)+/, "");

  // Engine kind after optional env-prefix injection from channelEnv.
  let cmdPart = stripEnvPrefix(cmd);
  let isClaudeEngine = cmdPart.startsWith("claude");
  let isCodexEngine = cmdPart.startsWith("codex");

  // Caller-provided resume id wins over implicit continuation behavior.
  // Engine-specific resume wiring:
  // - claude: keep legacy `--resume "<sid>"` flag
  // - codex:  use the dedicated subcommand `codex resume "<sid>"`
  if (opts.resume) {
    cmd = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
    if (isCodexEngine) {
      cmd = cmd
        // normalize accidental pre-baked `codex resume ...` templates
        .replace(/^((?:[A-Z_][A-Z0-9_]*=(?:'[^']*'|\S*)\s+)*)codex\s+resume(?:\s+"[^"]*"|\s+\S+)?\b/, "$1codex")
        // inject explicit session id for codex resume
        .replace(/^((?:[A-Z_][A-Z0-9_]*=(?:'[^']*'|\S*)\s+)*)codex\b/, `$1codex resume "${opts.resume}"`);
      // defensive fallback for unusual non-codex templates while engine=codex.
      if (!stripEnvPrefix(cmd).startsWith("codex resume")) cmd += ` --resume "${opts.resume}"`;
    } else {
      cmd += ` --resume "${opts.resume}"`;
    }
    cmdPart = stripEnvPrefix(cmd);
    isClaudeEngine = cmdPart.startsWith("claude");
    isCodexEngine = cmdPart.startsWith("codex");
  }

  // Caller-asserted (or auto-probed) fresh cwd: strip any pre-existing
  // --continue / --resume so we don't try to resume a session that doesn't
  // exist. The `||` fallback block below also bails out for fresh runs.
  if (opts.fresh) {
    cmd = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
  }

  // #1174 — `--continue` is the default for ALL claude wakes (not just
  // channel-enabled bots), so `maw wake <oracle>` resumes the prior
  // conversation in that oracle's cwd instead of starting fresh.
  //
  // Engine-aware guard: only inject for `claude` commands. `codex` (and any
  // other non-claude engine in `commands.<engine>`) doesn't recognize
  // `--continue`, and the `||` fallback below only fires on non-zero exit —
  // codex may silently ignore unknown flags, never tripping the fallback.
  // The simplest safe rule: cmd must start with `claude` (after optional env-
  // var prefix from `channelEnv`).
  cmdPart = stripEnvPrefix(cmd);
  isClaudeEngine = cmdPart.startsWith("claude");
  isCodexEngine = cmdPart.startsWith("codex");
  if (
    isClaudeEngine &&
    !opts.fresh &&
    !cmd.includes("--continue") &&
    !cmd.includes("--resume")
  ) {
    cmd += " --continue";
  }

  // Strip --dangerously-skip-permissions when running as root (#181)
  if (process.getuid?.() === 0) {
    cmd = cmd.replace(/\s*--dangerously-skip-permissions\b/, "");
  }

  // Inject --session-id if configured for this agent
  const sessionIds: Record<string, string> = (config as any).sessionIds || {};
  const sessionId = sessionIds[agentName]
    || Object.entries(sessionIds).find(([p]) => p !== "default" && matchGlob(p, agentName))?.[1];
  if (sessionId) {
    if (cmd.includes("--continue")) {
      cmd = cmd.replace(/\s*--continue\b/, ` --resume "${sessionId}"`);
    } else {
      cmd += ` --resume "${sessionId}"`;
    }
  }

  // Fallback for --continue/--resume: retry without it (fresh worktree / expired session).
  // Keep --session-id (if set) so the first run creates the session with that ID.
  // Reset terminal after Claude TUI exits — prevents frozen prompt (#1091)
  const reset = 'printf "\\e[?1049l\\e[0m"; stty sane 2>/dev/null; clear';

  // Bake the first-message prompt into the agent command. This MUST happen
  // before the `; ${reset}` suffix is appended and, for the fallback form,
  // inside the `{ … }` brace group on BOTH branches — otherwise `-p` lands
  // on the trailing `clear` and the prompt is silently lost (#wake-no-prompt
  // regression: watcher wakes landed idle at an empty input box).
  const withPrompt = (c: string): string => {
    if (!opts.prompt) return c;
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    const cPart = stripEnvPrefix(c);
    if (cPart.startsWith("codex")) return `${c} '${escaped}'`;
    return `${c} -p '${escaped}'`;
  };

  // Skip the || fallback for fresh runs — the cmd has no --continue/--resume
  // so there's nothing to fall back from.
  if (!opts.fresh && (cmd.includes("--continue") || cmd.includes("--resume"))) {
    let fallback = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
    if (sessionId) fallback += ` --session-id "${sessionId}"`;
    return `{ ${withPrompt(cmd)} || ${withPrompt(fallback)}; }; ${reset}`;
  }

  return `${withPrompt(cmd)}; ${reset}`;
}

/**
 * Previously wrapped buildCommand with `cd '<cwd>' && { ... }` to survive tmux
 * server reboots that reset pane pwd. Dropped in #541 — tmux newWindow(cwd:)
 * already sets the initial pane cwd, and the scrollback noise wasn't worth
 * the reboot-recovery edge case. `cwd` param kept for API compat + future use.
 */
export function buildCommandInDir(agentName: string, cwd: string, optsOrEngine?: string | BuildCommandOpts): string {
  // Auto-probe for "no continuable session" silent-fail. When the caller
  // didn't explicitly opt in (fresh) or out (resume) and the target cwd
  // has no JSONL under `~/.claude/projects/<encoded>/`, we set fresh=true
  // ourselves — otherwise `claude --continue` exits 0 with "No conversation
  // found to continue" and the `||` fallback never fires. This keeps every
  // wake site safe without forcing every caller to remember the probe.
  const opts: BuildCommandOpts = typeof optsOrEngine === "string"
    ? { engine: optsOrEngine }
    : (optsOrEngine || {});
  if (opts.fresh === undefined && opts.resume === undefined && cwd) {
    // Claudе-only probe: codex uses `codex resume` (not `--continue`) so the
    // ~/.claude/projects check would force pointless fresh-mode behavior.
    if (opts.engine !== "codex" && !hasContinuableSession(cwd)) {
      opts.fresh = true;
    }
  }
  return buildCommand(agentName, opts);
}

export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
