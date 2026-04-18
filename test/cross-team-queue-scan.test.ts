/**
 * #515 PR-B — cross-team-queue scan + frontmatter parser.
 *
 * Tests the pure scanInboxes() module against real fs fixtures under tmpdir.
 * Adversarial: missing-field-as-error, malformed-frontmatter-as-error
 * (no silent-drop).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanInboxes, parseFrontmatter } from "../src/commands/plugins/cross-team-queue/scan";

let vaultRoot: string;

function writeMd(oracle: string, name: string, content: string): string {
  const dir = join(vaultRoot, oracle, "inbox");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

beforeAll(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), "ctq-scan-"));
});

afterAll(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  test("string values", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\nrecipient: alice\nsender: bob\n---\nhello\n",
    );
    expect(frontmatter.recipient).toBe("alice");
    expect(frontmatter.sender).toBe("bob");
    expect(body).toBe("hello\n");
  });

  test("list values", () => {
    const { frontmatter } = parseFrontmatter(
      "---\ntags: [a, b, c]\n---\n\n",
    );
    expect(frontmatter.tags).toEqual(["a", "b", "c"]);
  });

  test("number values (no quotes)", () => {
    const { frontmatter } = parseFrontmatter(
      "---\nattempt: 42\nage: 3.5\n---\n\n",
    );
    expect(frontmatter.attempt).toBe(42);
    expect(frontmatter.age).toBe(3.5);
  });

  test("unclosed fence throws", () => {
    expect(() =>
      parseFrontmatter("---\nrecipient: alice\nno close fence\n"),
    ).toThrow(/unclosed/);
  });

  test("no frontmatter returns empty fm + full body", () => {
    const { frontmatter, body } = parseFrontmatter("just a body\n");
    expect(frontmatter).toEqual({});
    expect(body).toBe("just a body\n");
  });

  test("quoted string strips quotes", () => {
    const { frontmatter } = parseFrontmatter(
      `---\nsubject: "hello world"\n---\n`,
    );
    expect(frontmatter.subject).toBe("hello world");
  });
});

describe("scanInboxes", () => {
  test("happy path: 3 files in 2 oracle dirs → 3 items", async () => {
    const sub = mkdtempSync(join(tmpdir(), "ctq-happy-"));
    const prev = vaultRoot;
    vaultRoot = sub;
    try {
      writeMd(
        "alpha-oracle",
        "m1.md",
        "---\nrecipient: alice\nsender: bob\ntype: handoff\nsubject: first\n---\nbody1\n",
      );
      writeMd(
        "alpha-oracle",
        "m2.md",
        "---\nrecipient: alice\nsender: carol\ntype: fyi\nsubject: second\n---\nbody2\n",
      );
      writeMd(
        "beta-oracle",
        "m3.md",
        "---\nrecipient: dave\nsender: eve\ntype: task\nsubject: third\n---\nbody3\n",
      );
      const { items, errors } = await scanInboxes(vaultRoot);
      expect(items).toHaveLength(3);
      expect(errors).toHaveLength(0);
      const subjects = items.map((i) => i.subject).sort();
      expect(subjects).toEqual(["first", "second", "third"]);
    } finally {
      rmSync(sub, { recursive: true, force: true });
      vaultRoot = prev;
    }
  });

  test("missing recipient → error, not item", async () => {
    const sub = mkdtempSync(join(tmpdir(), "ctq-miss-"));
    const prev = vaultRoot;
    vaultRoot = sub;
    try {
      writeMd(
        "alpha-oracle",
        "bad.md",
        "---\nsender: bob\ntype: handoff\nsubject: x\n---\nbody\n",
      );
      const { items, errors } = await scanInboxes(vaultRoot);
      expect(items).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].reason).toMatch(/recipient/);
      expect(errors[0].path).toMatch(/bad\.md$/);
    } finally {
      rmSync(sub, { recursive: true, force: true });
      vaultRoot = prev;
    }
  });

  test("malformed frontmatter (unclosed fence) → error", async () => {
    const sub = mkdtempSync(join(tmpdir(), "ctq-mal-"));
    const prev = vaultRoot;
    vaultRoot = sub;
    try {
      writeMd(
        "alpha-oracle",
        "broken.md",
        "---\nrecipient: alice\nsender: bob\nno-close-fence\nsomething: else\n",
      );
      const { items, errors } = await scanInboxes(vaultRoot);
      expect(items).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].reason).toMatch(/unclosed/i);
    } finally {
      rmSync(sub, { recursive: true, force: true });
      vaultRoot = prev;
    }
  });

  test("empty / missing inbox dir → no items, no errors", async () => {
    const sub = mkdtempSync(join(tmpdir(), "ctq-empty-"));
    try {
      mkdirSync(join(sub, "alpha-oracle", "inbox"), { recursive: true });
      mkdirSync(join(sub, "beta-oracle"), { recursive: true });
      const { items, errors } = await scanInboxes(sub);
      expect(items).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  test("list-style frontmatter parses correctly", async () => {
    const sub = mkdtempSync(join(tmpdir(), "ctq-list-"));
    try {
      mkdirSync(join(sub, "alpha-oracle", "inbox"), { recursive: true });
      writeFileSync(
        join(sub, "alpha-oracle", "inbox", "m.md"),
        "---\nrecipient: alice\nsender: bob\ntype: handoff\nsubject: list-test\ntags: [foo, bar]\n---\nbody\n",
      );
      const { items, errors } = await scanInboxes(sub);
      expect(errors).toHaveLength(0);
      expect(items).toHaveLength(1);
      expect(items[0].subject).toBe("list-test");
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  test("number-style frontmatter (no quotes)", async () => {
    const sub = mkdtempSync(join(tmpdir(), "ctq-num-"));
    try {
      mkdirSync(join(sub, "alpha-oracle", "inbox"), { recursive: true });
      writeFileSync(
        join(sub, "alpha-oracle", "inbox", "m.md"),
        "---\nrecipient: alice\nsender: bob\ntype: handoff\nsubject: num\nattempt: 7\n---\nbody\n",
      );
      const { items, errors } = await scanInboxes(sub);
      expect(errors).toHaveLength(0);
      expect(items).toHaveLength(1);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  test("mtime + ageHours populated, ageHours >= 0", async () => {
    const sub = mkdtempSync(join(tmpdir(), "ctq-time-"));
    try {
      mkdirSync(join(sub, "alpha-oracle", "inbox"), { recursive: true });
      const p = join(sub, "alpha-oracle", "inbox", "m.md");
      writeFileSync(
        p,
        "---\nrecipient: alice\nsender: bob\ntype: handoff\nsubject: t\n---\nbody\n",
      );
      // Backdate to 2h ago so ageHours is clearly positive.
      const past = new Date(Date.now() - 2 * 3600_000);
      utimesSync(p, past, past);
      const { items } = await scanInboxes(sub);
      expect(items).toHaveLength(1);
      expect(items[0].mtime).toBeGreaterThan(0);
      expect(items[0].ageHours).toBeGreaterThanOrEqual(0);
      expect(items[0].ageHours).toBeGreaterThan(1.5);
      expect(items[0].schemaVersion).toBe(1);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  test("subject falls back to first non-empty body line", async () => {
    const sub = mkdtempSync(join(tmpdir(), "ctq-fallback-"));
    try {
      mkdirSync(join(sub, "alpha-oracle", "inbox"), { recursive: true });
      writeFileSync(
        join(sub, "alpha-oracle", "inbox", "m.md"),
        "---\nrecipient: alice\nsender: bob\ntype: handoff\n---\n\n# Derived Subject\nmore body\n",
      );
      const { items } = await scanInboxes(sub);
      expect(items).toHaveLength(1);
      expect(items[0].subject).toBe("Derived Subject");
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });
});
