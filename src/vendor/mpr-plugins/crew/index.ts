/**
 * maw company crew — deterministic idempotent crew-cell spawn (kobo-358).
 *
 *   maw company crew spawn <company>
 *
 * Module surface only (mirrors home/worklog/task) — invoked by `maw company
 * crew`, not a standalone top-level command. `runCrew` is the single source of
 * truth: logic lives in the binary (source symlink = always latest), never
 * re-interpreted by an LLM reading stale skill prose — that re-interpretation
 * was the ROOT CAUSE of the version-skew this card fixes (dup crew-workers
 * windows from an old session spawning v2 over v1 leftovers).
 */
import { crewSpawn } from "./spawn";

export async function runCrew(
  args: string[],
  emit: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const subcmd = args[0]?.toLowerCase();

  if (subcmd === "spawn") {
    return await crewSpawn(args[1], emit);
  }

  return { ok: false, error: "usage: maw company crew spawn <company>" };
}
