import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { execSync } from "child_process";
import { basename } from "path";

export const command = {
  name: "oracle-workon",
  description: "Spawn a worktree team for oracle work — composes maw wake --task --split + maw swarm.",
};

const HELP = `\x1b[36mmaw oracle-workon\x1b[0m — Spawn a worktree team for oracle work

USAGE
  maw oracle-workon --task <slug> [--with codex,thclaws]
                    [--engine claude47] [--tiled] [--prompt '<text>']
                    [--dry-run] [<oracle>]

FLAGS
  --task <slug>       worktree branch slug (required)
  --with <list>       comma-separated extra engines (e.g. codex,thclaws)
  --engine <name>     leader engine (default: claude47)
  --tiled             tiled swarm layout instead of split
  --prompt <text>     initial prompt for the leader
  --dry-run           print commands without executing
  --help, -h          show this help

POSITIONAL
  <oracle>            optional oracle override; auto-detected from cwd
                      (basename stripped of trailing '-oracle')

EXAMPLES
  maw oracle-workon --task ship-fix
  maw oracle-workon --task ship-fix --with codex,thclaws
  maw oracle-workon --task long-investigation --engine claude46 --with codex
  maw oracle-workon arra --task ship-cache --with codex --tiled
  maw oracle-workon --task ship-fix --dry-run

CLEANUP
  maw done <oracle>-<slug>            full cleanup
  maw done <oracle>-<slug> --force    skip rrr/git
`;

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], ...names: string[]): boolean {
  return names.some((n) => args.includes(n));
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];

    if (hasFlag(args, "--help", "-h") || args.length === 0) {
      console.log(HELP);
      return { ok: true, output: logs.join("\n") || undefined };
    }

    if (!process.env.TMUX) {
      console.error("⚠ maw oracle-workon requires tmux (splits need a pane to split FROM).");
      console.error("  Try: tmux attach -t 01-mawjs   or   tmux new -s play");
      return { ok: false, error: "not in tmux", output: logs.join("\n") || undefined };
    }

    const slug = getFlag(args, "--task");
    if (!slug) {
      console.error("⚠ --task <slug> is required. Try: maw oracle-workon --task ship-fix");
      return { ok: false, error: "missing --task", output: logs.join("\n") || undefined };
    }

    const withList = getFlag(args, "--with") ?? "";
    const agents = withList ? withList.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const engine = getFlag(args, "--engine") ?? "claude47";
    const prompt = getFlag(args, "--prompt");
    const tiled = hasFlag(args, "--tiled");
    const dryRun = hasFlag(args, "--dry-run");

    const positional = args.filter((a, i) => {
      if (a.startsWith("-")) return false;
      const prev = args[i - 1];
      if (prev === "--task" || prev === "--with" || prev === "--engine" || prev === "--prompt") return false;
      return true;
    });

    let oracle = positional[0];
    if (!oracle) {
      const cwdBase = basename(process.cwd());
      const stripped = cwdBase.replace(/-oracle$/, "");
      if (stripped === cwdBase) {
        console.error(`⚠ cwd '${cwdBase}' is not an oracle repo. Pass <oracle> as positional.`);
        return { ok: false, error: "oracle not detected", output: logs.join("\n") || undefined };
      }
      oracle = stripped;
      console.log(`  auto-detected oracle: ${oracle} (from cwd: ${cwdBase})`);
    }

    console.log(`  oracle:  ${oracle}`);
    console.log(`  slug:    ${slug}`);
    console.log(`  engine:  ${engine}`);
    console.log(`  agents:  ${agents.length ? agents.join(" ") : "none"}`);

    let leaderCmd = `maw wake ${oracle} --task ${slug} --split --no-attach --engine ${engine}`;
    if (prompt) leaderCmd += ` --prompt '${prompt.replace(/'/g, "'\\''")}'`;

    const swarmCmd = agents.length
      ? `maw swarm ${agents.join(" ")}${tiled ? " --tiled" : ""}`
      : "";

    if (dryRun) {
      console.log("");
      console.log(`▶ ${leaderCmd}`);
      if (swarmCmd) console.log(`▶ (in new pane) ${swarmCmd}`);
      console.log("");
      console.log("[dry-run] no changes made.");
      return { ok: true, output: logs.join("\n") || undefined };
    }

    console.log("");
    console.log(`▶ ${leaderCmd}`);
    execSync(leaderCmd, { stdio: "inherit" });

    await new Promise((r) => setTimeout(r, 2000));

    let newPane = "";
    if (agents.length) {
      const panes = execSync("tmux list-panes -a -F '#{pane_id} #{pane_title}'", { encoding: "utf8" });
      const match = panes
        .split("\n")
        .find((line: string) => line.toLowerCase().includes(slug.toLowerCase()));
      if (match) newPane = match.split(" ")[0];

      if (!newPane) {
        console.error(`⚠ Could not find new pane via title. Check: maw panes --all | grep ${slug}`);
        console.log("(leader is up; swarm skipped)");
        return { ok: true, output: logs.join("\n") || undefined };
      }

      console.log(`▶ (in ${newPane}) ${swarmCmd}`);
      await new Promise((r) => setTimeout(r, 3000));
      execSync(`maw run ${newPane} '${swarmCmd.replace(/'/g, "'\\''")}'`, { stdio: "inherit" });
    }

    console.log("");
    console.log("✓ oracle-workon complete:");
    console.log(`  oracle:    ${oracle}`);
    console.log(`  slug:      ${slug}`);
    console.log(`  leader:    ${newPane || "(check: maw panes)"}`);
    if (agents.length) console.log(`  agents:    ${agents.join(" ")}`);
    console.log("");
    console.log(`  cleanup:   maw done ${oracle}-${slug}`);

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
