import { mkdirSync, existsSync, readdirSync, symlinkSync, cpSync, readFileSync, lstatSync, unlinkSync, realpathSync } from "fs";
import { info, warn } from "./verbosity";

/**
 * Create a link to `src` at `dest`. Tries `symlinkSync` first (cheap, single
 * source of truth); falls back to `cpSync({ recursive: true })` on
 * `EPERM`/`ENOSYS`/`ENOTSUP` so the daemon still works on Windows when
 * the user is non-admin or Developer Mode is off.
 *
 * If the destination already exists, leave it alone (idempotent).
 */
function linkOrCopy(src: string, dest: string): "symlink" | "copy" | "exists" {
  if (existsSync(dest)) return "exists";
  try {
    symlinkSync(src, dest);
    return "symlink";
  } catch (err: any) {
    // EPERM/ENOSYS/ENOTSUP/EACCES → filesystem refuses symlinks (Windows non-admin).
    // ENOENT → parent dir of dest is missing (e.g. fresh plugin dir before mkdir).
    // `cpSync({ recursive: true })` creates missing parents and copies content,
    // so routing ENOENT here is safe and lets callers skip mkdir before bootstrap.
    const code = err?.code;
    if (code === "EPERM" || code === "ENOSYS" || code === "ENOTSUP" || code === "EACCES" || code === "ENOENT") {
      cpSync(src, dest, { recursive: true });
      return "copy";
    }
    throw err;
  }
}

export { linkOrCopy };
