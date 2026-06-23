/**
 * Company/dept attach marker store — a server-readable record of which oracles
 * are currently "attached" via `maw company attach`, so the policy-inject
 * endpoint knows to inject company/dept policy for that oracle's session.
 *
 * The marker is keyed by ORACLE and is STICKY: once set, it persists for the
 * whole session until an explicit `detach` clears it. A plain wake of a
 * never-attached / detached oracle has no marker → no policy injection.
 *
 * Anchored on COMPANIES_DIR (the company-helpers live binding) so tests can
 * relocate the registry via `_setCompaniesDir`. Markers live under
 *   <COMPANIES_DIR>/_attach/<oracle>.json
 *
 * Best-effort throughout: a missing directory / file / malformed JSON yields
 * null (or a no-op), never an exception — attach marker I/O must never block or
 * crash the agent or the policy-inject path.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { COMPANIES_DIR } from "../../vendor/mpr-plugins/company/company-helpers";

export interface AttachMarker {
  company: string;
  dept: string;
  /** ISO timestamp of when the marker was set. */
  attachedAt: string;
}

/** Directory holding per-oracle attach markers. */
export function attachDir(): string {
  return join(COMPANIES_DIR, "_attach");
}

/** Reject names that could escape the attach dir (path separators / traversal). */
function isUnsafeOracle(oracle: string): boolean {
  return !oracle || oracle.includes("/") || oracle.includes("..");
}

function markerPath(oracle: string): string {
  return join(attachDir(), `${oracle}.json`);
}

/**
 * Write (or refresh) the attach marker for an oracle, stamping `attachedAt` to
 * now. Creates the store dir if needed. No-op for unsafe oracle names.
 */
export function setPolicyAttach(oracle: string, m: { company: string; dept: string }): void {
  if (isUnsafeOracle(oracle)) return;
  try {
    mkdirSync(attachDir(), { recursive: true });
    const marker: AttachMarker = {
      company: m.company,
      dept: m.dept,
      attachedAt: new Date().toISOString(),
    };
    // lgtm[js/file-system-race] — PRIVATE-PATH: markers under ~/.maw/companies/_attach/
    writeFileSync(markerPath(oracle), JSON.stringify(marker, null, 2) + "\n");
  } catch {
    // best-effort — never throw on I/O failure
  }
}

/** Read an oracle's attach marker, or null when absent / unparseable. */
export function getPolicyAttach(oracle: string): AttachMarker | null {
  if (isUnsafeOracle(oracle)) return null;
  try {
    const path = markerPath(oracle);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as AttachMarker;
  } catch {
    return null;
  }
}

/** True when an oracle currently has an attach marker. */
export function isPolicyAttached(oracle: string): boolean {
  return getPolicyAttach(oracle) !== null;
}

/**
 * Delete an oracle's attach marker (an explicit detach). Returns true when a
 * marker file was removed, false when there was none. Never throws.
 */
export function clearPolicyAttach(oracle: string): boolean {
  if (isUnsafeOracle(oracle)) return false;
  try {
    const path = markerPath(oracle);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}
