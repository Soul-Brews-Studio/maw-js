# TOCTOU in lock files — fd-based read/write (#474)

Status: applied 2026-04-19. Mirrors the #562 / #581 fix in `src/cli/update-lock.ts`.

## The three sites

CodeQL `js/file-system-race` raised three alerts from 2026-04-18 commits:

| Alert | File | Line | Pattern |
|------|------|------|---------|
| #87 | `src/commands/plugins/peers/lock.ts` | 42 | `openSync(lockPath,"wx")` → `writeFileSync(lockPath, pid)` |
| #88 | `src/commands/plugins/peers/lock.ts` | 47 | on EEXIST: `readFileSync(lockPath, "utf-8")` |
| #84 | `src/cli/instance-pid.ts` | 56 | on EEXIST: `readFileSync(file, "utf-8")` |

All three are the exact pre-#581 shape: we open or probe a lock file by **path a second time** after the initial `O_CREAT | O_EXCL` returned or failed. Between the two resolutions an attacker with write access to the parent directory (or a crashed cleanup racing us) can swap `lockPath` for a symlink pointing at an arbitrary file.

- On the **write path** (alert #87): the PID ends up written into the attacker-chosen target.
- On the **read path** (alerts #88, #84): we parse attacker-controlled content as an integer and treat it as the holder PID — mis-stealing (or refusing to steal) the lock as the attacker chooses.

None of this requires a remote attacker; a co-tenant user on the host who can write to the lock directory is sufficient. `~/.maw/` is user-owned, so the practical risk is narrow, but the pattern is identical to the update-lock race CodeQL already flagged and we already fixed once — so we fix it the same way rather than argue the severity.

## The fix (#562 / #581 pattern)

`openSync(path, "wx")` returns a file descriptor bound to the **inode we just created**. Subsequent operations on that fd are immune to path-level symlink swaps. Likewise, `openSync(path, "r")` followed by `fstatSync` + `readSync` binds to whatever inode the path resolved to **at open time**, not at every subsequent syscall.

### Before (peers/lock.ts)
```ts
fd = openSync(lockPath, "wx");
writeFileSync(lockPath, String(process.pid));      // ← path TOCTOU
// ...
holderPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10); // ← path TOCTOU
```

### After
```ts
fd = openSync(lockPath, "wx");
const pidBytes = Buffer.from(String(process.pid));
writeSync(fd, pidBytes, 0, pidBytes.length, 0);    // fd-based — same inode

// on EEXIST:
let readFd: number | null = null;
try {
  readFd = openSync(lockPath, "r");
  const size = fstatSync(readFd).size;
  const buf = Buffer.alloc(Math.min(size, 64));
  readSync(readFd, buf, 0, buf.length, 0);         // fd-based — same inode
  holderPid = parseInt(buf.toString("utf-8").trim(), 10);
} catch { /* malformed / gone — treat as stale */ }
finally { if (readFd !== null) { try { closeSync(readFd); } catch {} } }
```

Same fix for `instance-pid.ts` on the liveness-probe read (the write there already used `writeSync(fd, …)`).

## Back-compat

No behavioural change except concurrency correctness:
- Acquisition still uses `O_CREAT | O_EXCL`.
- Holder PID is still written as a decimal ASCII string.
- Stale-holder detection still uses `kill(pid, 0)`.
- `unlinkSync` / cleanup paths unchanged.

PID-file consumers read at most 64 bytes (enough for any realistic PID). Existing lock files from prior runs are one line of digits — well under 64 bytes.

## Test plan

- `bun run test:all` must stay green — these are pure refactors of the lock prologue/probe.
- No new contention tests. Reliable fs-race tests require a controlled scheduler; `setImmediate`-based races are flaky and test the mock, not the fix. `withPeersLock` is already exercised by `test/commands/peers/peers-lock.test.ts`; `acquirePidLock` by the serve integration tests.
- Manual check (optional): `ln -sf /tmp/evil ~/.maw/maw.pid` before starting `maw serve` should no longer redirect the PID write to `/tmp/evil`; the attempt fails at `openSync(…, "wx")` with EEXIST and the liveness probe binds to the symlink target at open time rather than re-resolving on every syscall.

## References

- #474 — issue (tracker)
- #581 — exemplar fix in `src/cli/update-lock.ts`
- #562 / #552 — original TOCTOU discussion and symlink-swap model
- CodeQL alerts: #87, #88, #84
