/**
 * maw profile — subcommand implementations (#888 / Phase 1 of #640).
 *
 * Thin shell around `src/lib/profile-loader.ts`. Phase 1 ships READ + active-
 * pointer-write only; profile authoring (`maw profile create`) is intentionally
 * NOT here yet — operators write the JSON themselves in Phase 1, and a follow-up
 * sub-issue will add a scaffolding verb once Phase 2 wires the loader into the
 * registry.
 *
 * Verb shape mirrors `src/commands/plugins/scope/impl.ts` (#642 Phase 1 — same
 * primitive-with-CLI pattern).
 */

import {
  getActiveProfile,
  loadAllProfiles,
  loadProfile,
  setActiveProfile,
} from "../../../lib/profile-loader";
import type { TProfile } from "../../../lib/schemas";

export function cmdList(): TProfile[] {
  return loadAllProfiles();
}

export function cmdShow(name: string): TProfile | null {
  return loadProfile(name);
}

export function cmdCurrent(): string {
  return getActiveProfile();
}

/**
 * Switch the active profile. Refuses to point at a profile file that doesn't
 * exist — Phase 1 has no scaffolder, so a typo would silently brick plugin
 * activation in Phase 2 if we let unknown names through.
 */
export function cmdUse(name: string): TProfile {
  const profile = loadProfile(name);
  if (!profile) {
    throw new Error(`profile "${name}" not found — see "maw profile list"`);
  }
  setActiveProfile(name);
  return profile;
}

// ─── Format ──────────────────────────────────────────────────────────────────

export function formatList(rows: TProfile[], active: string): string {
  if (!rows.length) return "no profiles";
  const header = ["", "name", "plugins", "tiers", "description"];
  const lines = rows.map((r) => [
    r.name === active ? "*" : " ",
    r.name,
    r.plugins ? String(r.plugins.length) : "-",
    r.tiers && r.tiers.length ? r.tiers.join(",") : "-",
    r.description ?? "",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map((l) => l[i].length))
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [
    fmt(header),
    fmt(widths.map((w) => "-".repeat(w))),
    ...lines.map(fmt),
  ].join("\n");
}
