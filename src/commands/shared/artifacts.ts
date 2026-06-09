/**
 * maw artifacts — discover what teams produced.
 *
 *   maw artifacts              # list all
 *   maw artifacts ls [team]    # list, optionally filtered
 *   maw artifacts get <team> <task-id>  # show full artifact
 *   maw artifacts --json       # machine-readable
 */

import { listArtifacts, getArtifact } from "../../lib/artifacts";
import { UserError } from "../../core/util/user-error";

export async function cmdArtifacts(sub: string, args: string[], flags: Record<string, any>) {
  const json = flags["--json"];

  if (!sub || sub === "ls" || sub === "list") {
    const team = args[0];
    const items = listArtifacts(team);

    if (json) { console.log(JSON.stringify(items, null, 2)); return; }
    if (items.length === 0) { console.log("No artifacts found." + (team ? ` (team: ${team})` : "")); return; }

    // Table header
    console.log(
      pad("TEAM", 18) + pad("TASK", 6) + pad("STATUS", 12) +
      pad("OWNER", 16) + pad("FILES", 6) + pad("RESULT", 8) + "SUBJECT",
    );
    console.log("-".repeat(90));

    for (const a of items) {
      console.log(
        pad(a.team, 18) +
        pad(a.taskId, 6) +
        pad(colorStatus(a.status), 12) +
        pad(a.owner ?? "-", 16) +
        pad(String(a.files), 6) +
        pad(a.hasResult ? "\x1b[32myes\x1b[0m" : "\x1b[90mno\x1b[0m", 8) +
        a.subject.slice(0, 40),
      );
    }
    return;
  }

  if (sub === "get" || sub === "show") {
    const team = args[0];
    const taskId = args[1];
    if (!team || !taskId) throw new UserError("usage: maw artifacts get <team> <task-id>");

    const art = getArtifact(team, taskId);
    if (!art) throw new UserError(`artifact not found: ${team}/${taskId}`);

    if (json) { console.log(JSON.stringify(art, null, 2)); return; }

    console.log(`\x1b[1m${art.meta.subject}\x1b[0m`);
    console.log(`Team: ${art.meta.team} | Task: ${art.meta.taskId} | Status: ${colorStatus(art.meta.status)}`);
    console.log(`Owner: ${art.meta.owner ?? "-"} | Created: ${art.meta.createdAt}`);
    if (art.meta.commitHash) console.log(`Commit: ${art.meta.commitHash}`);
    console.log("");

    console.log("\x1b[36m── spec.md ──\x1b[0m");
    console.log(art.spec.trim());
    console.log("");

    if (art.result) {
      console.log("\x1b[32m── result.md ──\x1b[0m");
      console.log(art.result.trim());
      console.log("");
    } else {
      console.log("\x1b[90m(no result.md yet)\x1b[0m\n");
    }

    if (art.attachments.length > 0) {
      console.log(`\x1b[33m── attachments (${art.attachments.length}) ──\x1b[0m`);
      for (const a of art.attachments) console.log(`  ${a}`);
    }

    console.log(`\n\x1b[90mDir: ${art.dir}\x1b[0m`);
    return;
  }

  throw new UserError("usage: maw artifacts [ls|get] [team] [task-id] [--json]");
}

function pad(s: string, n: number): string { return s.padEnd(n); }
function colorStatus(s: string): string {
  if (s === "completed") return "\x1b[32mcompleted\x1b[0m";
  if (s === "in_progress") return "\x1b[33min_progress\x1b[0m";
  return s;
}
