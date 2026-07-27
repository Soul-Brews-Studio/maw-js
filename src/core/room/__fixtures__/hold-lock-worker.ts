// kobo-430 — holds ONE room's lock for a fixed duration, so a test can prove the lock is
// scoped per-room-file (a DIFFERENT room's write is not blocked) rather than global (which
// would serialize every room's writes on one lockfile).
import { writeFileSync } from "fs";
import { withPeersLock } from "../../../lib/peers/lock";
import { roomLockPath } from "../store";

const [, , company, roomId, msArg, sentinelPath] = process.argv;
const ms = parseInt(msArg, 10);

// goes through the SAME roomLockPath production code uses — see store.ts's comment on
// why this matters for what the scope test can actually catch.
withPeersLock(roomLockPath(company, roomId), () => {
  // signal ACQUIRED, not just "process started" — a fixed sleep before checking would be a
  // guess about subprocess startup time; a test that races that guess isn't testing scope,
  // it's testing scheduler luck (caught this the hard way: an earlier version of this test
  // slipped a real per-company mutation through once out of several runs).
  writeFileSync(sentinelPath, String(process.pid));
  const end = Date.now() + ms;
  while (Date.now() < end) { /* hold synchronously — same busy-wait shape as the lock itself */ }
});
