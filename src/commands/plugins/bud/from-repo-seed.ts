/**
 * File-copy helpers for `maw bud --from-repo` (#588 final pair).
 *
 *   seedFromParent     — copy parent oracle's ψ/memory/ into target's ψ/memory/
 *   copyPeersSnapshot  — snapshot host peers.json into <target>/ψ/peers.json
 *
 * Both are dest-biased ("Nothing is Deleted") — pre-existing target files
 * are preserved, missing source is a logged skip (never a throw), and
 * neither mutates `~/.maw/` or any path outside <target>.
 *
 * Design: docs/bud/from-repo-impl.md section (i).
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../../config";
import { getGhqRoot } from "../../../config/ghq-root";
import { peersPath } from "../peers/store";

type Log = (msg: string) => void;

/** Resolve parent oracle's ψ/memory/ path via on-demand ghq root (#680). */
export function parentMemoryPath(parentStem: string): string {
  const cfg = loadConfig();
  const org = cfg.githubOrg || "Soul-Brews-Studio";
  return join(getGhqRoot(), "github.com", org, `${parentStem}-oracle`, "ψ", "memory");
}

/**
 * Copy parent's ψ/memory/ into target's ψ/memory/.
 *
 * - Requires target's ψ/memory/ to already exist (writeVault runs first).
 * - `force: false` preserves pre-existing target files ("Nothing is Deleted").
 * - Missing parent vault is a logged skip — injection continues.
 */
export function seedFromParent(
  target: string,
  parentStem: string,
  log: Log,
): void {
  const src = parentMemoryPath(parentStem);
  if (!existsSync(src)) {
    log(`  \x1b[33m!\x1b[0m --seed: parent ${parentStem} has no ψ/memory/ at ${src} — skip`);
    return;
  }
  if (!statSync(src).isDirectory()) {
    log(`  \x1b[33m!\x1b[0m --seed: parent ψ/memory is not a directory — skip`);
    return;
  }
  const dst = join(target, "ψ", "memory");
  mkdirSync(dst, { recursive: true });
  // lgtm[js/file-system-race] — PRIVATE-PATH: scaffold dest is user-owned, see docs/security/file-system-race-stance.md
  cpSync(src, dst, { recursive: true, errorOnExist: false, force: false });
  log(`  \x1b[32m✓\x1b[0m --seed: copied parent ${parentStem}'s ψ/memory/ → ${dst}`);
}

/**
 * Snapshot host peers.json into <target>/ψ/peers.json. Meant as a portable
 * seed — other hosts that later clone the target can import the file.
 *
 * - Source: peersPath() (respects PEERS_FILE / MAW_HOME / default).
 * - Missing source: logged skip.
 */
export function copyPeersSnapshot(target: string, log: Log): void {
  const src = peersPath();
  if (!existsSync(src)) {
    log(`  \x1b[33m!\x1b[0m --sync-peers: no peers.json at ${src} — skip`);
    return;
  }
  const dst = join(target, "ψ", "peers.json");
  mkdirSync(join(target, "ψ"), { recursive: true });
  // lgtm[js/file-system-race] — PRIVATE-PATH: scaffold dest is user-owned, see docs/security/file-system-race-stance.md
  copyFileSync(src, dst);
  log(`  \x1b[32m✓\x1b[0m --sync-peers: snapshot peers.json → ${dst}`);
}
