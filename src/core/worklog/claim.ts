/**
 * Claim / soft-lock — announce "I'm doing X" so a second worker sees it before
 * starting the same task (collision guard, acceptance B). Soft: it never blocks,
 * it surfaces — claims are injected before an agent acts and collisions ping.
 */

import { appendWorklog, openClaims } from "./store";
import { companyOfOracle } from "./company-scope";
import type { WorklogEntry } from "./types";

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Two task strings overlap if equal or one contains the other (after norm). */
export function tasksOverlap(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** Open claims by *other* oracles that overlap the given task. */
export function collidingClaims(company: string | null | undefined, oracle: string, task: string): WorklogEntry[] {
  return openClaims(company).filter(c => c.oracle !== oracle && tasksOverlap(c.task ?? c.summary, task));
}

export interface ClaimResult {
  entry: WorklogEntry;
  collisions: WorklogEntry[];
}

/** Record a claim; return any colliding open claims by others. */
export function addClaim(oracle: string, task: string): ClaimResult {
  const company = companyOfOracle(oracle) ?? undefined;
  const collisions = collidingClaims(company, oracle, task);
  const entry: WorklogEntry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    oracle,
    company,
    kind: "claim",
    summary: `claim: ${task}`,
    task,
  };
  appendWorklog(entry);
  return { entry, collisions };
}

/** Release a previously announced claim. */
export function releaseClaim(oracle: string, task: string): WorklogEntry {
  const company = companyOfOracle(oracle) ?? undefined;
  const entry: WorklogEntry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    oracle,
    company,
    kind: "claim-release",
    summary: `release: ${task}`,
    task,
  };
  appendWorklog(entry);
  return entry;
}
