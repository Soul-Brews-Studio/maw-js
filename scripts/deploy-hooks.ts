#!/usr/bin/env bun
/**
 * Deploy status-reporter hooks to all oracle agents.
 * Merges SessionStart + Stop hooks into each oracle's .claude/settings.json
 * without clobbering existing hooks.
 *
 * Usage: bun scripts/deploy-hooks.ts [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { ensureStatusReporterScript, statusReporterPath } from "../src/core/status-reporter";

const GHQ_ROOT = join(process.env.HOME!, "ghq/github.com/meganechan");
const HOOK_SCRIPT = join(process.env.HOME!, ".config/maw/hooks/status-reporter.sh");

// Auto-discover oracles from fleet + ghq
const FLEET_DIR = join(process.env.HOME!, ".maw/fleet");
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

// Provision the hook script itself — the wired path was never shipped.
if (DRY_RUN) {
  console.log(existsSync(statusReporterPath())
    ? `  ok: status-reporter.sh present`
    : `  dry: status-reporter.sh — would install`);
} else {
  const r = ensureStatusReporterScript();
  console.log(`  ${r.created ? "done: status-reporter.sh installed" : "ok: status-reporter.sh present"}`);
}

function makeHookEntry(event: string) {
  return {
    type: "command",
    command: `CLAUDE_HOOK_EVENT=${event} ${HOOK_SCRIPT}`,
  };
}

function isStatusReporterHook(hook: any): boolean {
  return typeof hook?.command === "string" && hook.command.includes("status-reporter.sh");
}

for (const oracle of ORACLES) {
  const oracleDir = join(GHQ_ROOT, oracle);
  if (!existsSync(oracleDir)) {
    console.log(`  skip: ${oracle} (dir not found)`);
    continue;
  }

  const settingsDir = join(oracleDir, ".claude");
  const settingsPath = join(settingsDir, "settings.json");

  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.log(`  warn: ${oracle} — invalid JSON, creating fresh`);
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  let changed = false;

  for (const event of ["SessionStart", "Stop"]) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    const entries = settings.hooks[event] as any[];
    const alreadyHas = entries.some((e: any) =>
      e.hooks?.some(isStatusReporterHook) ||
      (Array.isArray(e) && e.some(isStatusReporterHook))
    );

    if (alreadyHas) continue;

    entries.push({
      matcher: "",
      hooks: [makeHookEntry(event)],
    });
    changed = true;
  }

  if (!changed) {
    console.log(`  ok: ${oracle} (already configured)`);
    continue;
  }

  if (DRY_RUN) {
    console.log(`  dry: ${oracle} — would update .claude/settings.json`);
    continue;
  }

  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  done: ${oracle} — hooks added`);
}

console.log(DRY_RUN ? "\n(dry run — no files changed)" : "\nDeploy complete.");
