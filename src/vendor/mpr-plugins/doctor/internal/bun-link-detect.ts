import { readlinkSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname, resolve } from "path";

/**
 * #1281 — Detect whether `maw` is bun-linked to a local maw-js dev checkout.
 *
 * When `bun link` has been run inside a maw-js checkout, bun creates a
 * symlink at `~/.bun/install/global/node_modules/maw-js` pointing to that
 * checkout. If `maw doctor` then auto-reinstalls via
 * `bun add -g github:Soul-Brews-Studio/maw-js`, bun silently replaces the
 * symlink with a fresh clone — blowing away the dev workflow and confusing
 * the operator. Doctor's auto-reinstall path must skip when a link is
 * present.
 *
 * Returns the absolute path of the linked checkout if the symlink exists
 * AND resolves to a directory whose `package.json` declares `name: maw-js`.
 * Returns null in every other case (no symlink, broken symlink, missing
 * or wrong-named package.json, unreadable JSON).
 *
 * @param globalNodeModules base path of bun's global `node_modules`.
 *   Defaults to `~/.bun/install/global/node_modules`. Override in tests.
 */
export function detectBunLinkedCheckout(
  globalNodeModules: string = join(homedir(), ".bun/install/global/node_modules"),
): string | null {
  const link = join(globalNodeModules, "maw-js");
  let target: string;
  try {
    target = readlinkSync(link);
  } catch {
    // Not a symlink, or doesn't exist — either way, no dev link to protect.
    return null;
  }
  const abs = target.startsWith("/") ? target : resolve(dirname(link), target);
  const pkgPath = join(abs, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg?.name !== "maw-js") return null;
    return abs;
  } catch {
    return null;
  }
}
