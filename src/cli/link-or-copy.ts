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
    if (err?.code === "EPERM" || err?.code === "ENOSYS" || err?.code === "ENOTSUP" || err?.code === "EACCES") {
      cpSync(src, dest, { recursive: true });
      return "copy";
    }
    throw err;
  }
}

export { linkOrCopy };
