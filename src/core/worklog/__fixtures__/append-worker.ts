// kobo-463 — a REAL separate OS process, spawned by worklog.test.ts's cold-start
// concurrency test. Appends N entries to one company's worklog AS FAST AS POSSIBLE
// (no delay — %5's repro, c13) while a concurrently-polling reader in the SAME window
// hammers readWorklog. The race is the stat()-then-readFileSync() gap in the cold-start
// branch — a few microseconds wide — so high append THROUGHPUT (not pacing) is what
// gives the reader's syscalls enough attempts to land in that gap. A same-process
// sequential test cannot produce this at all: appendWorklog/readWorklog calls in one
// process never interleave with each other.
import { appendWorklog } from "../store";
import { writeFileSync } from "fs";

const [, , company, prefix, countArg, sentinelPath] = process.argv;
const count = parseInt(countArg, 10);

for (let i = 0; i < count; i++) {
  appendWorklog({ ts: Date.now(), iso: new Date().toISOString(), oracle: prefix, company, kind: "tool", summary: `${prefix}-${i}` });
}
if (sentinelPath) writeFileSync(sentinelPath, "done"); // signals the reader process to stop polling
