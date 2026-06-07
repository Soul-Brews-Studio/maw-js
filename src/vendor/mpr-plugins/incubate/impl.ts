/**
 * incubate — bud + wake + fire `/incubate <source>` in the new oracle.
 *
 * Composition (mirror of `awaken`, but for source-wrapping rather than birth):
 *   1. Derive oracle stem from source (`org/foo` → `foo`).
 *   2. cmdBud(stem, { repo: source, ...opts }) — creates the new
 *      `<stem>-oracle` repo, ψ vault, fleet entry, and wakes it
 *      (cmdBud calls cmdWake internally with noAttach: true).
 *   3. cmdSendText({ target: stem, text: "/incubate <source>" }) — fires
 *      the `/incubate` skill into the NEW oracle's TUI; the skill clones
 *      via ghq, symlinks into the NEW oracle's ψ/incubate/, manages
 *      .origins + hub file inside the new oracle.
 *
 * Result: a dedicated oracle with the source repo as its primary focus.
 *
 * Verb family completed:
 *   bud      — creates new oracle (blank or seeded)
 *   awaken   — bud + wake + /awaken (one-shot birth)
 *   incubate — bud + wake + /incubate <source> (one-shot wrap)
 *
 * For "add a source to the CURRENT oracle's ψ/incubate" workflow, use
 * the `/incubate <source>` skill directly inside an oracle's TUI — that's
 * the multi-source-per-oracle pattern that existed before this plugin.
 */
import { cmdBud, type BudOpts } from "../bud/impl";
import { cmdSendText } from "../send-text/impl";
import { listSessions, resolveTarget } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";

export type IncubateMode = "default" | "flash" | "contribute";

export interface IncubateOpts extends BudOpts {
  /** Source repo (org/repo, URL, or local path). Required. */
  source: string;
  /** Override auto-derived oracle stem (default: source basename). */
  stem?: string;
  /** Skill mode passed through to `/incubate` in the new oracle. */
  mode?: IncubateMode;
  /** Custom trigger override (replaces auto-built `/incubate <source>`). */
  trigger?: string;
  /** Skip firing the skill (just bud + wake — debug). */
  noTrigger?: boolean;
}

/**
 * Derive the oracle stem from a source slug.
 *   "Soul-Brews-Studio/foo"           → "foo"
 *   "https://github.com/org/foo"      → "foo"
 *   "https://github.com/org/foo.git"  → "foo"
 *   "foo"                             → "foo"
 */
export function deriveStemFromSource(source: string): string {
  const lastSlash = source.lastIndexOf("/");
  let name = lastSlash >= 0 ? source.slice(lastSlash + 1) : source;
  name = name.replace(/\.git$/, "");
  return name;
}

/**
 * Build the slash-command line. Pure — testable without IO.
 *
 *   { source: "org/foo" }                          → "/incubate org/foo"
 *   { source: "org/foo", mode: "flash" }           → "/incubate org/foo --flash"
 *   { source: "org/foo", mode: "contribute" }      → "/incubate org/foo --contribute"
 *   { source: "org/foo", trigger: "/foo-custom" }  → "/foo-custom"  (override)
 */
export function buildSkillCommand(opts: IncubateOpts): string {
  if (opts.trigger) return opts.trigger;
  const parts = ["/incubate", opts.source];
  if (opts.mode === "flash") parts.push("--flash");
  else if (opts.mode === "contribute") parts.push("--contribute");
  return parts.join(" ");
}

export async function cmdIncubate(opts: IncubateOpts): Promise<void> {
  if (!opts.source) {
    throw new Error('usage: maw incubate <source-repo> [--stem <name>] [--flash | --contribute] [--from <oracle>] [--root] ...all bud flags');
  }

  const stem = opts.stem ?? deriveStemFromSource(opts.source);
  if (!stem) {
    throw new Error(`could not derive stem from source: "${opts.source}"`);
  }

  const trigger = opts.noTrigger ? null : buildSkillCommand(opts);

  // Step 1: bud (creates <stem>-oracle, seeds ψ from source via --repo, wakes)
  const budOpts: BudOpts = { ...opts };
  // BudOpts doesn't have source/stem/mode/trigger/noTrigger — strip them.
  delete (budOpts as any).source;
  delete (budOpts as any).stem;
  delete (budOpts as any).mode;
  delete (budOpts as any).trigger;
  delete (budOpts as any).noTrigger;
  // Pass source as bud's --repo flag (one-time ψ seed copy if source has ψ/memory)
  budOpts.repo = opts.source;

  await cmdBud(stem, budOpts);

  // Dry-run / root-without-wake: bud already returned early, nothing to send.
  if (opts.dryRun) {
    if (trigger) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would send \x1b[33m${trigger}\x1b[0m to ${stem}`);
    } else {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] --no-trigger: would NOT fire /incubate`);
    }
    return;
  }

  if (!trigger) {
    console.log(`  \x1b[90m○\x1b[0m --no-trigger: bud + wake done, skipping /incubate`);
    return;
  }

  // Step 2: resolve the new oracle's pane (no readiness wait — graceful).
  const config = loadConfig();
  const sessions = await listSessions();
  const result = resolveTarget(stem, config, sessions);

  if (!result || result.type === "error") {
    console.log(
      `  \x1b[33m⚠\x1b[0m could not resolve ${stem} after wake — skipping ${trigger}`,
    );
    console.log(`  \x1b[90m  try manually: maw send-text ${stem} '${trigger}'\x1b[0m`);
    return;
  }

  // Step 3: fire the skill into the NEW oracle's pane
  console.log(`  \x1b[36m🔔\x1b[0m firing \x1b[33m${trigger}\x1b[0m → ${stem}`);
  try {
    await cmdSendText({ target: stem, text: trigger });
    console.log(`  \x1b[32m✓\x1b[0m incubation dispatched`);
  } catch (e: any) {
    console.log(`  \x1b[33m⚠\x1b[0m send-text failed: ${e?.message || e}`);
    console.log(`  \x1b[90m  try manually: maw send-text ${stem} '${trigger}'\x1b[0m`);
  }
}

/**
 * Resolve mode from flag booleans. Mutually exclusive.
 */
export function resolveMode(flash: boolean, contribute: boolean): IncubateMode {
  if (flash && contribute) {
    throw new Error("--flash and --contribute are mutually exclusive");
  }
  if (flash) return "flash";
  if (contribute) return "contribute";
  return "default";
}
