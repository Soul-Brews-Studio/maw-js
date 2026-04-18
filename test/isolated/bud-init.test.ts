/**
 * bud-init.ts — filesystem + fleet-config scaffolding tests.
 *
 * These cover the 4 exported steps of `maw bud` post parent-resolution:
 *   initVault · generateClaudeMd · configureFleet · writeBirthNote
 *
 * Why isolated: `configureFleet` resolves `FLEET_DIR` from `src/core/paths`,
 * which at module-load does `mkdirSync(FLEET_DIR, { recursive: true })`
 * against `~/.config/maw/fleet`. We mock.module that path to redirect to a
 * per-run tmpdir BEFORE importing bud-init; mock.module is process-global so
 * this has to live in test/isolated/ (same rationale as peers-send.test.ts).
 *
 * The other 3 functions (initVault, generateClaudeMd, writeBirthNote) only
 * touch the bud repo path we pass in, so they use real fs via mkdtempSync —
 * which matches test/plugin-build.test.ts's convention ("mock only what
 * touches destructive outside state").
 */
import { describe, test, expect, mock, afterAll, beforeEach } from "bun:test";
import {
  mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Redirect FLEET_DIR to a scratch tmpdir BEFORE bud-init loads ────────────

const tmpBase = mkdtempSync(join(tmpdir(), "maw-bud-init-"));
const tmpFleet = join(tmpBase, "fleet");
mkdirSync(tmpFleet, { recursive: true });

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: tmpBase,
  FLEET_DIR: tmpFleet,
  CONFIG_FILE: join(tmpBase, "maw.config.json"),
  MAW_ROOT: tmpBase,
  resolveHome: () => tmpBase, // #566
}));

const {
  initVault, generateClaudeMd, configureFleet, writeBirthNote,
} = await import("../../src/commands/plugins/bud/bud-init");

afterAll(() => {
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
});

// Silence the `  ✓ …` success lines that bud-init emits — keeps test output clean.
const origLog = console.log;
beforeEach(() => { console.log = () => {}; });
afterAll(() => { console.log = origLog; });

// ─── Helpers ────────────────────────────────────────────────────────────────

function freshBudRepo(): string {
  const d = mkdtempSync(join(tmpBase, "bud-"));
  return d;
}

function clearFleet(): void {
  for (const f of readdirSync(tmpFleet)) rmSync(join(tmpFleet, f));
}

// ─── initVault ──────────────────────────────────────────────────────────────

describe("initVault", () => {
  test("creates the full ψ/ subtree and returns its path", () => {
    const bud = freshBudRepo();
    const psi = initVault(bud);

    expect(psi).toBe(join(bud, "ψ"));
    for (const sub of [
      "memory/learnings", "memory/retrospectives", "memory/traces",
      "memory/resonance", "inbox", "outbox", "plans",
    ]) {
      expect(existsSync(join(psi, sub))).toBe(true);
    }
  });

  test("is idempotent — running twice does not throw", () => {
    const bud = freshBudRepo();
    initVault(bud);
    expect(() => initVault(bud)).not.toThrow();
    // Existing dirs are still present after the second call.
    expect(existsSync(join(bud, "ψ", "memory", "learnings"))).toBe(true);
  });

  test("does NOT create anything outside ψ/ in the bud repo", () => {
    const bud = freshBudRepo();
    initVault(bud);
    // Nothing unexpected at the bud root — only the ψ directory.
    const entries = readdirSync(bud);
    expect(entries).toEqual(["ψ"]);
  });
});

// ─── generateClaudeMd ───────────────────────────────────────────────────────

describe("generateClaudeMd", () => {
  test("root oracle (parentName null) — header says 'Root oracle', field says 'Origin: root'", () => {
    const bud = freshBudRepo();
    generateClaudeMd(bud, "white-wormhole", null);

    const body = readFileSync(join(bud, "CLAUDE.md"), "utf-8");
    expect(body).toContain("# white-wormhole-oracle");
    expect(body).toContain("Root oracle — born ");
    expect(body).toContain("(no parent lineage)");
    expect(body).toContain("**Origin**: root (no parent)");
    expect(body).not.toContain("**Budded from**");
    expect(body).not.toContain("null");
    expect(body).not.toContain("undefined");
  });

  test("parent oracle — header has 'Budded from <parent> on <date>', field has parent name", () => {
    const bud = freshBudRepo();
    generateClaudeMd(bud, "mawjs", "neo");

    const body = readFileSync(join(bud, "CLAUDE.md"), "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    expect(body).toContain("# mawjs-oracle");
    expect(body).toContain(`> Budded from **neo** on ${today}`);
    expect(body).toContain("**Budded from**: neo");
    expect(body).not.toContain("Root oracle");
    expect(body).not.toContain("Origin: root");
  });

  test("file embeds federation tag template with the oracle name", () => {
    const bud = freshBudRepo();
    generateClaudeMd(bud, "alpha", "neo");
    const body = readFileSync(join(bud, "CLAUDE.md"), "utf-8");
    expect(body).toContain("`[<host>:alpha]`");
    expect(body).toContain("[mba:alpha]");
    expect(body).toContain("[oracle-world:alpha]");
  });

  test("file contains Rule 6 signature contexts (federation / public / git trailer)", () => {
    const bud = freshBudRepo();
    generateClaudeMd(bud, "zeta", "neo");
    const body = readFileSync(join(bud, "CLAUDE.md"), "utf-8");
    expect(body).toContain("Rule 6: Oracle Never Pretends to Be Human");
    expect(body).toContain("maw hey");
    expect(body).toContain("ตอบโดย zeta");
    expect(body).toContain("Co-Authored-By: Claude Opus 4.6");
    expect(body).toContain("กระจกไม่แกล้งเป็นคน");
  });

  test("idempotent — second call with a DIFFERENT parent preserves the first file", () => {
    const bud = freshBudRepo();
    generateClaudeMd(bud, "mawjs", "neo");
    const first = readFileSync(join(bud, "CLAUDE.md"), "utf-8");

    // Call again with a new parent — early-return branch, no rewrite.
    generateClaudeMd(bud, "mawjs", "someone-else");
    const second = readFileSync(join(bud, "CLAUDE.md"), "utf-8");

    expect(second).toBe(first);
    expect(second).toContain("**Budded from**: neo");
    expect(second).not.toContain("someone-else");
  });

  test("header date is today's ISO date (YYYY-MM-DD slice)", () => {
    const bud = freshBudRepo();
    generateClaudeMd(bud, "date-check", null);
    const body = readFileSync(join(bud, "CLAUDE.md"), "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    expect(body).toContain(`born ${today}`);
  });
});

// ─── configureFleet ─────────────────────────────────────────────────────────

describe("configureFleet — new config (no existing entry)", () => {
  beforeEach(clearFleet);

  test("root bud writes fleet file with sync_peers: [] and NO lineage fields", () => {
    const fleetFile = configureFleet("root-a", "Soul-Brews-Studio", "root-a-oracle", null);

    expect(existsSync(fleetFile)).toBe(true);
    expect(fleetFile).toBe(join(tmpFleet, "01-root-a.json"));
    const cfg = JSON.parse(readFileSync(fleetFile, "utf-8"));
    expect(cfg).toEqual({
      name: "01-root-a",
      windows: [{ name: "root-a-oracle", repo: "Soul-Brews-Studio/root-a-oracle" }],
      sync_peers: [],
    });
    expect(cfg.budded_from).toBeUndefined();
    expect(cfg.budded_at).toBeUndefined();
  });

  test("parent bud writes lineage + sync_peers: [parent] + ISO budded_at", () => {
    const fleetFile = configureFleet("parent-a", "Soul-Brews-Studio", "parent-a-oracle", "neo");
    const cfg = JSON.parse(readFileSync(fleetFile, "utf-8"));

    expect(cfg.name).toBe("01-parent-a");
    expect(cfg.sync_peers).toEqual(["neo"]);
    expect(cfg.budded_from).toBe("neo");
    // ISO-8601 shape (YYYY-MM-DDTHH:MM:SS.sssZ)
    expect(cfg.budded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(cfg.windows).toEqual([
      { name: "parent-a-oracle", repo: "Soul-Brews-Studio/parent-a-oracle" },
    ]);
  });

  test("bud number auto-increments from max existing (e.g. 09 → 10, padded)", () => {
    // Pre-populate fleet with num=9 entry under a different name.
    writeFileSync(
      join(tmpFleet, "09-existing.json"),
      JSON.stringify({ name: "09-existing", windows: [] }) + "\n",
    );
    const fleetFile = configureFleet("new-bud", "org", "new-bud-oracle", null);

    expect(fleetFile).toBe(join(tmpFleet, "10-new-bud.json"));
    const cfg = JSON.parse(readFileSync(fleetFile, "utf-8"));
    expect(cfg.name).toBe("10-new-bud");
  });

  test("org override flows into the window repo slug", () => {
    const fleetFile = configureFleet("org-test", "my-gh-org", "org-test-oracle", null);
    const cfg = JSON.parse(readFileSync(fleetFile, "utf-8"));
    expect(cfg.windows[0].repo).toBe("my-gh-org/org-test-oracle");
  });

  test("fleet file name is zero-padded to 2 digits (05- not 5-)", () => {
    // First call: fresh → should be 01-*
    const fleetFile = configureFleet("pad-a", "O", "pad-a-oracle", null);
    expect(fleetFile.endsWith("/01-pad-a.json")).toBe(true);
  });
});

describe("configureFleet — existing entry (idempotent lineage backfill)", () => {
  beforeEach(clearFleet);

  test("existing entry WITHOUT lineage + parent given → backfills budded_from + budded_at", () => {
    // Seed a legacy entry missing lineage fields.
    const seedFile = join(tmpFleet, "03-legacy.json");
    writeFileSync(seedFile, JSON.stringify({
      name: "03-legacy",
      windows: [{ name: "legacy-oracle", repo: "old-org/legacy-oracle" }],
      sync_peers: [],
    }) + "\n");

    const fleetFile = configureFleet("legacy", "new-org", "legacy-oracle", "neo");
    expect(fleetFile).toBe(seedFile); // updates in place

    const cfg = JSON.parse(readFileSync(fleetFile, "utf-8"));
    expect(cfg.budded_from).toBe("neo");
    expect(cfg.budded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The bud operation must NOT overwrite the original windows entry (legacy data preserved).
    expect(cfg.windows).toEqual([{ name: "legacy-oracle", repo: "old-org/legacy-oracle" }]);
  });

  test("existing entry WITH lineage is left untouched (no rewrite churn)", () => {
    const seedFile = join(tmpFleet, "04-already-set.json");
    const seedBody = JSON.stringify({
      name: "04-already-set",
      windows: [{ name: "already-set-oracle", repo: "O/already-set-oracle" }],
      sync_peers: ["old-parent"],
      budded_from: "old-parent",
      budded_at: "2020-01-01T00:00:00.000Z",
    }, null, 2) + "\n";
    writeFileSync(seedFile, seedBody);

    const fleetFile = configureFleet("already-set", "O", "already-set-oracle", "neo");
    const after = readFileSync(fleetFile, "utf-8");

    // Preserve the legacy budded_from + budded_at values. This is the "no rewrite" branch.
    const cfg = JSON.parse(after);
    expect(cfg.budded_from).toBe("old-parent");
    expect(cfg.budded_at).toBe("2020-01-01T00:00:00.000Z");
  });

  test("existing entry + no parentName → no lineage backfill, no write", () => {
    const seedFile = join(tmpFleet, "05-root-existing.json");
    const seedBody = JSON.stringify({
      name: "05-root-existing",
      windows: [{ name: "root-existing-oracle", repo: "O/root-existing-oracle" }],
      sync_peers: [],
    }, null, 2) + "\n";
    writeFileSync(seedFile, seedBody);

    const fleetFile = configureFleet("root-existing", "O", "root-existing-oracle", null);
    const cfg = JSON.parse(readFileSync(fleetFile, "utf-8"));

    expect(cfg.budded_from).toBeUndefined();
    expect(cfg.budded_at).toBeUndefined();
    // And the seed body is literally untouched (byte-identical).
    expect(readFileSync(fleetFile, "utf-8")).toBe(seedBody);
  });

  test("matches existing entry ignoring the NN- prefix on session.name", () => {
    // The lookup strips /^\d+-/ off session.name — so "42-foo" matches stem "foo".
    writeFileSync(
      join(tmpFleet, "42-numbered.json"),
      JSON.stringify({ name: "42-numbered", windows: [], sync_peers: [] }, null, 2) + "\n",
    );
    const fleetFile = configureFleet("numbered", "O", "numbered-oracle", "neo");
    expect(fleetFile).toBe(join(tmpFleet, "42-numbered.json"));
    const cfg = JSON.parse(readFileSync(fleetFile, "utf-8"));
    expect(cfg.budded_from).toBe("neo"); // proves the match branch ran
  });
});

// ─── writeBirthNote ─────────────────────────────────────────────────────────

describe("writeBirthNote", () => {
  test("writes dated file under ψ/memory/learnings/ with parent lineage", () => {
    const bud = freshBudRepo();
    const psi = initVault(bud);
    writeBirthNote(psi, "alpha", "neo", "spawned to split #201 tracker");

    const today = new Date().toISOString().slice(0, 10);
    const notePath = join(psi, "memory", "learnings", `${today}_birth-note.md`);
    expect(existsSync(notePath)).toBe(true);

    const body = readFileSync(notePath, "utf-8");
    // Frontmatter
    expect(body).toMatch(/^---\npattern: Birth note from neo\ndate: \d{4}-\d{2}-\d{2}\nsource: maw bud\n---/);
    // Body
    expect(body).toContain("# Why alpha was born");
    expect(body).toContain("spawned to split #201 tracker");
    expect(body).toContain("Budded from: neo");
  });

  test("root oracle birth note — 'Root oracle — no parent' + no 'from <x>' in frontmatter", () => {
    const bud = freshBudRepo();
    const psi = initVault(bud);
    writeBirthNote(psi, "white-wormhole", null, "first root-bud via --root");

    const today = new Date().toISOString().slice(0, 10);
    const body = readFileSync(
      join(psi, "memory", "learnings", `${today}_birth-note.md`),
      "utf-8",
    );
    expect(body).toContain("pattern: Birth note\n"); // no "from <parent>" suffix
    expect(body).toContain("Root oracle — no parent");
    expect(body).toContain("# Why white-wormhole was born");
    expect(body).toContain("first root-bud via --root");
    expect(body).not.toContain("Budded from:");
    expect(body).not.toContain("null");
  });

  test("preserves multi-line notes verbatim", () => {
    const bud = freshBudRepo();
    const psi = initVault(bud);
    const note = "line 1\nline 2\n\n- bullet\n- bullet";
    writeBirthNote(psi, "multi", "neo", note);

    const today = new Date().toISOString().slice(0, 10);
    const body = readFileSync(
      join(psi, "memory", "learnings", `${today}_birth-note.md`),
      "utf-8",
    );
    expect(body).toContain(note);
  });
});
