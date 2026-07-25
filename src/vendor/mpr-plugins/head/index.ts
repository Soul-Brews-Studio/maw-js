/**
 * maw company head — deterministic idempotent head-cell spawn (kobo-364).
 *
 *   maw company head spawn <company>
 *
 * Module surface only (mirrors home/worklog/task/crew) — invoked by `maw
 * company head`, not a standalone top-level command. Same treatment kobo-358
 * gave /crew: layout/spawn mechanics move from Claude-Code-skill PROSE into
 * this binary verb (source symlink = always latest, no LLM re-interpretation
 * of stale prose at spawn time).
 */
import { headSpawn, type HeadSpawnResult } from "./spawn";

export async function runHead(
  args: string[],
  emit: (line: string) => void,
): Promise<HeadSpawnResult> {
  const subcmd = args[0]?.toLowerCase();

  if (subcmd === "spawn") {
    return await headSpawn(args[1], emit);
  }

  return { ok: false, error: "usage: maw company head spawn <company>" };
}
