import { symlinkSync } from "fs";
import { win32 as win32Path } from "path";

/**
 * Create a directory symlink that works on Windows without elevated privileges.
 *
 * On Windows this creates a directory junction (which does not require
 * Developer Mode/admin rights) using an absolute target path. On Unix it
 * creates a normal directory symlink and preserves relative targets.
 */
export function symlinkDirSync(target: string, linkPath: string): void {
  if (process.platform === "win32") {
    const absoluteTarget = win32Path.isAbsolute(target)
      ? target
      : win32Path.resolve(win32Path.dirname(linkPath), target);
    // Windows antivirus / indexing can briefly lock the parent directory,
    // causing EBUSY on junction creation. Retry a few times before giving up.
    let lastErr: unknown;
    for (let i = 0; i < 8; i++) {
      try {
        symlinkSync(absoluteTarget, linkPath, "junction");
        return;
      } catch (err: any) {
        lastErr = err;
        if (err?.code !== "EBUSY") break;
        // Exponential-ish backoff: 10ms, 20ms, 40ms ... up to ~1.2s total.
        const delay = Math.min(10 * 2 ** i, 200);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
    throw lastErr;
  } else {
    symlinkSync(target, linkPath, "dir");
  }
}
