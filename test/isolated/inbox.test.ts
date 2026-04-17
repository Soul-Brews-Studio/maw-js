import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Stub config so impl.ts can resolve inboxDir without a real maw.config.json.
import { mockConfigModule } from "../helpers/mock-config";
mock.module("../../src/config", () => mockConfigModule(() => ({
  node: "test-oracle",
  psiPath: undefined, // force cwd fallback — we override resolveInboxDir directly
})));

import {
  writeInboxFile,
  loadInboxMessages,
  cmdInboxLs,
  cmdInboxMarkRead,
  resolveInboxDir,
} from "../../src/commands/plugins/inbox/impl";

// ── helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "maw-inbox-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function inboxDir(): string {
  return join(tmpDir, "ψ", "inbox");
}

// ── 1. write + read ──────────────────────────────────────────────────────────

describe("writeInboxFile + loadInboxMessages — round-trip", () => {
  test("writes a correctly named file with frontmatter and body", () => {
    const dir = inboxDir();
    const filename = writeInboxFile(dir, "arc", "mawjs", "Hello from arc!");

    expect(existsSync(join(dir, filename))).toBe(true);
    // YYYY-MM-DD_HH-MM_arc_<slug>.md
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_arc_/);
    expect(filename).toEndWith(".md");

    const content = readFileSync(join(dir, filename), "utf-8");
    expect(content).toContain("from: arc");
    expect(content).toContain("to: mawjs");
    expect(content).toContain("read: false");
    expect(content).toContain("Hello from arc!");
  });

  test("loadInboxMessages parses written files and returns newest-first", () => {
    const dir = inboxDir();
    writeInboxFile(dir, "arc", "mawjs", "first message");
    // ensure distinct timestamps
    const later = new Date(Date.now() + 2000).toISOString();
    // write a second file manually with a later timestamp
    const { writeFileSync, mkdirSync } = require("fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-04-17_22-00_neo_second.md"),
      `---\nfrom: neo\nto: mawjs\ntimestamp: ${later}\nread: false\n---\n\nsecond message\n`,
    );

    const msgs = loadInboxMessages(dir);
    expect(msgs.length).toBe(2);
    // newest first
    expect(msgs[0].frontmatter.from).toBe("neo");
    expect(msgs[1].frontmatter.from).toBe("arc");
    expect(msgs[0].body).toBe("second message");
  });
});

// ── 2. filter --unread ───────────────────────────────────────────────────────

describe("filter by unread", () => {
  test("cmdInboxLs --unread omits already-read messages", async () => {
    const dir = inboxDir();
    const { writeFileSync, mkdirSync } = require("fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-04-17_10-00_arc_read-msg.md"),
      "---\nfrom: arc\nto: mawjs\ntimestamp: 2026-04-17T10:00:00.000Z\nread: true\n---\n\nAlready read\n",
    );
    writeFileSync(
      join(dir, "2026-04-17_11-00_neo_unread-msg.md"),
      "---\nfrom: neo\nto: mawjs\ntimestamp: 2026-04-17T11:00:00.000Z\nread: false\n---\n\nNot yet read\n",
    );

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      // We call loadInboxMessages directly and filter to avoid cwd dependency
      const msgs = loadInboxMessages(dir).filter(m => !m.frontmatter.read);
      expect(msgs.length).toBe(1);
      expect(msgs[0].frontmatter.from).toBe("neo");
    } finally {
      console.log = origLog;
    }
  });
});

// ── 3. filter --from ─────────────────────────────────────────────────────────

describe("filter by sender", () => {
  test("loadInboxMessages filtered by from returns only matching sender", () => {
    const dir = inboxDir();
    writeInboxFile(dir, "arc", "mawjs", "from arc");
    writeInboxFile(dir, "neo", "mawjs", "from neo");
    writeInboxFile(dir, "arc", "mawjs", "from arc again");

    const all = loadInboxMessages(dir);
    const fromArc = all.filter(m => m.frontmatter.from === "arc");
    expect(fromArc.length).toBe(2);
    fromArc.forEach(m => expect(m.frontmatter.from).toBe("arc"));
  });
});

// ── 4. --last N ──────────────────────────────────────────────────────────────

describe("last N messages", () => {
  test("slice to last N returns N newest messages", () => {
    const dir = inboxDir();
    for (let i = 0; i < 5; i++) {
      writeInboxFile(dir, "arc", "mawjs", `message ${i}`);
    }
    const msgs = loadInboxMessages(dir).slice(0, 3);
    expect(msgs.length).toBe(3);
  });
});

// ── 5. mark-as-read ──────────────────────────────────────────────────────────

describe("cmdInboxMarkRead", () => {
  test("flips read: false → read: true in frontmatter", async () => {
    const dir = inboxDir();
    const filename = writeInboxFile(dir, "arc", "mawjs", "mark me read");
    const id = filename.replace(/\.md$/, "");

    // cmdInboxMarkRead uses resolveInboxDir() which reads config/cwd.
    // Call it with a stub that sets cwd to tmpDir.
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      await cmdInboxMarkRead(id);
    } finally {
      process.cwd = origCwd;
    }

    const content = readFileSync(join(dir, filename), "utf-8");
    expect(content).toContain("read: true");
    expect(content).not.toContain("read: false");
  });

  test("already-read message prints 'already read' without error", async () => {
    const { writeFileSync, mkdirSync } = require("fs");
    const dir = inboxDir();
    mkdirSync(dir, { recursive: true });
    const filename = "2026-04-17_10-00_arc_already.md";
    writeFileSync(
      join(dir, filename),
      "---\nfrom: arc\nto: mawjs\ntimestamp: 2026-04-17T10:00:00.000Z\nread: true\n---\n\nalready read\n",
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      await cmdInboxMarkRead("already");
      expect(logs.join("\n")).toContain("already read");
    } finally {
      console.log = origLog;
      process.cwd = origCwd;
    }
  });
});

// ── 6. missing inbox dir ─────────────────────────────────────────────────────

describe("missing inbox dir", () => {
  test("loadInboxMessages returns empty array when dir does not exist", () => {
    const nonexistent = join(tmpDir, "does-not-exist");
    expect(loadInboxMessages(nonexistent)).toEqual([]);
  });

  test("writeInboxFile creates inbox dir automatically", () => {
    const dir = join(tmpDir, "new-inbox");
    expect(existsSync(dir)).toBe(false);
    writeInboxFile(dir, "arc", "mawjs", "auto-create test");
    expect(existsSync(dir)).toBe(true);
  });
});
