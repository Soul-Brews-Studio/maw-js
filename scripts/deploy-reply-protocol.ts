#!/usr/bin/env bun
/**
 * Deploy request-reply protocol section to all oracle CLAUDE.md files.
 * Appends the section before "Run `/awaken`" or at the end if not found.
 *
 * Usage: bun scripts/deploy-reply-protocol.ts [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const GHQ_ROOT = join(process.env.HOME!, "ghq/github.com/meganechan");
const FLEET_DIR = join(process.env.HOME!, ".maw/fleet");

// Auto-discover oracles from fleet
const ORACLES: string[] = [];
if (existsSync(FLEET_DIR)) {
  for (const f of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
    try {
      const cfg = JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8"));
      for (const w of cfg.windows ?? []) {
        if (w.name?.endsWith("-oracle")) ORACLES.push(w.name);
      }
    } catch {}
  }
}

const DRY_RUN = process.argv.includes("--dry-run");

const SECTION = `## Request-Reply Protocol

When you receive a message starting with \`[request:<correlationId>]\`:
1. Extract the correlationId (e.g. \`req-1-abc123-xyz\`)
2. Do the requested work
3. When done, reply with: \`maw reply <correlationId> "<your answer>"\`

To see pending requests awaiting your reply: \`maw reply --list\``;

for (const oracle of ORACLES) {
  const claudeMd = join(GHQ_ROOT, oracle, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    console.log(`  skip: ${oracle} (CLAUDE.md not found)`);
    continue;
  }

  let content = readFileSync(claudeMd, "utf-8");

  if (content.includes("Request-Reply Protocol")) {
    console.log(`  ok: ${oracle} (already has protocol)`);
    continue;
  }

  const awakenMarker = "Run `/awaken`";
  if (content.includes(awakenMarker)) {
    content = content.replace(awakenMarker, `${SECTION}\n\n${awakenMarker}`);
  } else {
    content = content.trimEnd() + "\n\n" + SECTION + "\n";
  }

  if (DRY_RUN) {
    console.log(`  dry: ${oracle} — would update CLAUDE.md`);
    continue;
  }

  writeFileSync(claudeMd, content);
  console.log(`  done: ${oracle} — protocol added`);
}

console.log(DRY_RUN ? "\n(dry run — no files changed)" : "\nDeploy complete.");
