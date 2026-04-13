/**
 * artifact-manager — TS plugin for task artifact lifecycle.
 *
 * Drop this in ~/.oracle/commands/ or install via `maw plugins install`.
 * No WASM, no compilation — pure TypeScript, full access to maw-js internals.
 *
 * Usage:
 *   maw art ls [team]                    # list artifacts
 *   maw art get <team> <task-id>         # show full artifact
 *   maw art write <team> <task-id> <msg> # write result
 *   maw art attach <team> <task-id> <file> # add attachment
 *   maw art init <team> <task-id> <subject> <desc> # create manually
 */

import {
  createArtifact,
  updateArtifact,
  writeResult,
  addAttachment,
  listArtifacts,
  getArtifact,
  artifactDir,
} from "../../../lib/artifacts";
import { readFileSync } from "fs";
import { basename } from "path";

export const command = {
  name: ["art", "artifact-manager"],
  description: "Task artifact manager — ls, get, write, attach, init",
  flags: {
    "--json": Boolean,
    "--team": String,
  },
};

export default async function handler(args: string[], flags: Record<string, any>) {
  const sub = args[0] ?? "ls";
  const json = flags["--json"];

  switch (sub) {
    case "ls":
    case "list": {
      const team = args[1] ?? flags["--team"];
      const items = listArtifacts(team);
      if (json) { console.log(JSON.stringify(items, null, 2)); return; }
      if (items.length === 0) { console.log("No artifacts."); return; }

      const w = { team: 16, id: 6, status: 12, owner: 14, files: 6, result: 8 };
      console.log(
        col("TEAM", w.team) + col("ID", w.id) + col("STATUS", w.status) +
        col("OWNER", w.owner) + col("FILES", w.files) + col("RESULT", w.result) + "SUBJECT",
      );
      console.log("─".repeat(80));
      for (const a of items) {
        const st = a.status === "completed" ? "\x1b[32m✓\x1b[0m done" :
                   a.status === "in_progress" ? "\x1b[33m⚡\x1b[0m wip" : "pending";
        const res = a.hasResult ? "\x1b[32myes\x1b[0m" : "\x1b[90m—\x1b[0m";
        console.log(
          col(a.team, w.team) + col(a.taskId, w.id) + col(st, w.status) +
          col(a.owner ?? "—", w.owner) + col(String(a.files), w.files) +
          col(res, w.result) + a.subject.slice(0, 36),
        );
      }
      break;
    }

    case "get":
    case "show": {
      const [, team, taskId] = args;
      if (!team || !taskId) { console.error("usage: maw art get <team> <task-id>"); return; }
      const art = getArtifact(team, taskId);
      if (!art) { console.error(`not found: ${team}/${taskId}`); return; }
      if (json) { console.log(JSON.stringify(art, null, 2)); return; }

      console.log(`\x1b[1m${art.meta.subject}\x1b[0m`);
      console.log(`${art.meta.team}/${art.meta.taskId} · ${art.meta.status} · ${art.meta.owner ?? "unowned"}`);
      if (art.meta.commitHash) console.log(`commit: ${art.meta.commitHash}`);
      console.log("");
      console.log("\x1b[36m─── spec ───\x1b[0m");
      console.log(art.spec.trim().slice(0, 500));
      if (art.result) {
        console.log("\n\x1b[32m─── result ───\x1b[0m");
        console.log(art.result.trim().slice(0, 1000));
      }
      if (art.attachments.length) {
        console.log(`\n\x1b[33m─── attachments (${art.attachments.length}) ───\x1b[0m`);
        art.attachments.forEach(a => console.log(`  📎 ${a}`));
      }
      console.log(`\n\x1b[90m${art.dir}\x1b[0m`);
      break;
    }

    case "write": {
      const [, team, taskId, ...rest] = args;
      if (!team || !taskId || rest.length === 0) {
        console.error("usage: maw art write <team> <task-id> <message...>");
        return;
      }
      writeResult(team, taskId, rest.join(" "));
      console.log(`\x1b[32m✓\x1b[0m result written → ${artifactDir(team, taskId)}/result.md`);
      break;
    }

    case "attach": {
      const [, team, taskId, filePath] = args;
      if (!team || !taskId || !filePath) {
        console.error("usage: maw art attach <team> <task-id> <file-path>");
        return;
      }
      const data = readFileSync(filePath);
      const dest = addAttachment(team, taskId, basename(filePath), data);
      console.log(`\x1b[32m✓\x1b[0m attached → ${dest}`);
      break;
    }

    case "init":
    case "create": {
      const [, team, taskId, subject, ...descParts] = args;
      if (!team || !taskId || !subject) {
        console.error("usage: maw art init <team> <task-id> <subject> [description...]");
        return;
      }
      const dir = createArtifact(team, taskId, subject, descParts.join(" ") || subject);
      console.log(`\x1b[32m✓\x1b[0m artifact created → ${dir}`);
      break;
    }

    default:
      console.error("usage: maw art [ls|get|write|attach|init] [--json]");
  }
}

function col(s: string, n: number): string { return s.padEnd(n); }
