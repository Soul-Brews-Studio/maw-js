// kobo-463 — a REAL separate OS process, spawned ALONGSIDE append-worker.ts. Busy-loops
// readWorklog synchronously (no async yields — a genuine tight loop, since this process
// does nothing else) until the writer's sentinel file appears, recording the max entry
// count ever seen and whether that count's summaries were ever non-distinct. Needs to be
// a real process, not an async loop in the test runner: the race this chases is a
// microsecond-scale gap between two syscalls (worklogCacheProbe's stat, then
// readFileSync) — an async loop bounded by setTimeout/microtask granularity samples far
// too few times per second to reliably land in a window that small.
import { existsSync, writeFileSync } from "fs";
import { readWorklog } from "../store";

const [, , company, sentinelPath, resultPath, readyPath] = process.argv;

if (readyPath) writeFileSync(readyPath, "ready"); // signal BEFORE the loop starts, so the caller knows this process is actually spinning, not still starting up

let maxLen = 0;
let sawDuplicate = false;
let reads = 0;
while (!existsSync(sentinelPath)) {
  const entries = readWorklog(company);
  reads++;
  if (entries.length > maxLen) maxLen = entries.length;
  const summaries = entries.map((e) => e.summary);
  if (new Set(summaries).size !== summaries.length) sawDuplicate = true;
}
// one final read after the sentinel, to catch the tail end
const finalEntries = readWorklog(company);
const finalSummaries = finalEntries.map((e) => e.summary);
if (new Set(finalSummaries).size !== finalSummaries.length) sawDuplicate = true;

await Bun.write(resultPath, JSON.stringify({ reads, maxLen, sawDuplicate, finalCount: finalEntries.length }));
