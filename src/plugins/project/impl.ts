/**
 * maw project — stub implementation (#523).
 *
 * Migration scaffold for Oracle skill /project. Real flow (ghq clone,
 * symlink into ψ/learn/<owner>/<repo> or ψ/incubate/<owner>/<repo>,
 * tracked-repo search, list across both roots, --offload/--contribute/
 * --flash workflow flags for `incubate`) is tracked as follow-up work.
 *
 * Until that lands, each action stub:
 *   - Echoes a well-shaped stub message naming the action + args
 *   - Points users at the Oracle skill for actual behavior
 *
 * The functions are pure (no I/O, no process spawning) so they are
 * safe to unit test and safe to wire into the CLI ahead of the real
 * impl. Keeping one function per action gives the follow-up PR clear
 * attachment points (swap the body, keep the signature).
 */

export type ProjectAction = "learn" | "incubate" | "find" | "list";

const TRACK_URL = "https://github.com/Soul-Brews-Studio/maw-js/issues/523";
const ORACLE_SKILL = "Oracle skill /project";

function stubLine(action: ProjectAction, detail: string): string {
  return [
    `project ${action}: ${detail} — not yet implemented in core plugin; use ${ORACLE_SKILL} for full behavior.`,
    `  track: ${TRACK_URL}`,
  ].join("\n");
}

/** Stub: clone repo for study (symlink into ψ/learn/<owner>/<repo>). */
export async function stubLearn(url: string): Promise<string> {
  const message = stubLine("learn", `would clone "${url}" and symlink into ψ/learn/<owner>/<repo>`);
  console.log(message);
  return message;
}

/** Stub: clone repo for development (symlink into ψ/incubate/<owner>/<repo>). */
export async function stubIncubate(url: string): Promise<string> {
  const message = stubLine("incubate", `would clone "${url}" and symlink into ψ/incubate/<owner>/<repo>`);
  console.log(message);
  return message;
}

/** Stub: search tracked repos by query. */
export async function stubFind(query: string): Promise<string> {
  const message = stubLine("find", `would search tracked repos for "${query}" across ψ/learn and ψ/incubate`);
  console.log(message);
  return message;
}

/** Stub: list all tracked repos (learn + incubate). */
export async function stubList(): Promise<string> {
  const message = stubLine("list", `would list all tracked repos from ψ/learn and ψ/incubate`);
  console.log(message);
  return message;
}

/** Dispatcher help text — printed on missing / unknown subcommand. */
export function helpText(): string {
  return [
    "usage: maw project <learn|incubate|find|list> [args...]",
    "  learn    <url>   — clone repo for study (symlink in ψ/learn/)",
    "  incubate <url>   — clone repo for development (symlink in ψ/incubate/)",
    "  find     <query> — search tracked repos (alias: search)",
    "  list             — list all tracked repos",
    "",
    `see ${ORACLE_SKILL} for the full implementation (scaffold tracks ${TRACK_URL}).`,
  ].join("\n");
}
