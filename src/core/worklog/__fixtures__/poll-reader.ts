// kobo-463 — a REAL separate OS process, spawned ALONGSIDE append-worker.ts. Busy-loops
// readWorklog synchronously (no async yields — a genuine tight loop, since this process
// does nothing else) until the writer's sentinel file appears, recording the max entry
// count ever seen and whether that count's summaries were ever non-distinct. Needs to be
// a real process, not an async loop in the test runner: the race this chases is a
// microsecond-scale gap between two syscalls (worklogCacheProbe's stat, then
// readFileSync) — an async loop bounded by setTimeout/microtask granularity samples far
// too few times per second to reliably land in a window that small.
import { existsSync, writeFileSync, statSync } from "fs";
import { readWorklog, worklogPath } from "../store";

const [, , company, sentinelPath, resultPath, readyPath] = process.argv;

if (readyPath) writeFileSync(readyPath, "ready"); // signal BEFORE the loop starts, so the caller knows this process is actually spinning, not still starting up

// kobo-463, %5 c19: this bug can only fire on the FIRST readWorklog call in this
// process's life (cold-start branch — every later call has a cache and takes the
// already-fixed incremental path). If that first call lands on an EMPTY or
// barely-started file, there is nothing for it to miss — the race needs the file
// to already be sizeable AND still actively growing. Hold the first read until the
// file has real bytes, so that first call has something to actually race against.
const MIN_BYTES_BEFORE_FIRST_READ = 20_000; // %5's measured threshold
const p = worklogPath(company);
while (!existsSync(sentinelPath)) {
  let sz = 0;
  try { sz = statSync(p).size; } catch { /* not created yet */ }
  if (sz >= MIN_BYTES_BEFORE_FIRST_READ) break;
}

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
