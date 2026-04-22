import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  listClaudeSessions,
  listClaudePids,
  classifyTrigger,
  normalizeRemote,
  encodeCwd,
  extractRole,
  invalidateCache,
} from "../src/core/fleet/claude-sessions";

const TMP = join(tmpdir(), `claude-sessions-test-${process.pid}`);
const FAKE_CWD = "/Users/t/Code/github.com/acme/widget";
const ENCODED = encodeCwd(FAKE_CWD);

const PS_OUT = `
  4321  100 /Users/t/Library/Application Support/Claude/claude-code/2.1.0/claude.app/Contents/MacOS/claude --flag
  4320  99  /Applications/Claude.app/Contents/Helpers/disclaimer /Users/t/Library/Application Support/Claude/claude-code/2.1.0/claude.app/Contents/MacOS/claude --flag
  9999  1   /usr/bin/zsh
  5555  42  /opt/homebrew/bin/claude --input-format stream-json
  6666  42  /bin/zsh -c grep claude
`;

const LSOF_OUT_4321 = `p4321\nfcwd\nn${FAKE_CWD}`;

async function fakeExec(cmd: string): Promise<string> {
  if (cmd.startsWith("ps -eo pid,ppid,command")) return PS_OUT;
  if (cmd.includes("lsof -a -d cwd -p 4321")) return LSOF_OUT_4321;
  if (cmd.startsWith("ps -o ppid=,comm=")) {
    if (cmd.includes("-p 100")) return "1 tmux\n";
    if (cmd.includes("-p 1")) return "0 launchd\n";
    return "";
  }
  if (cmd.startsWith("git -C")) {
    if (cmd.includes("remote get-url")) return "git@github.com:acme/widget.git\n";
    if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "feat/test\n";
    if (cmd.includes("rev-parse --show-toplevel")) return `${FAKE_CWD}\n`;
  }
  return "";
}

beforeAll(async () => {
  invalidateCache();
  await mkdir(join(TMP, ENCODED), { recursive: true });
  const now = Date.now();
  const sessionFile = join(TMP, ENCODED, "sess-1111-2222-3333.jsonl");
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "ในฐานะ tester ช่วย audit หน่อย" }, timestamp: new Date(now - 10000).toISOString() }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "on it" }] }, timestamp: new Date(now - 5000).toISOString() }),
    JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(now - 1000).toISOString() }),
  ].join("\n") + "\n";
  await writeFile(sessionFile, lines);
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("encodeCwd", () => {
  test("replaces / and . with -", () => {
    expect(encodeCwd("/Users/t/Code/github.com/acme/widget"))
      .toBe("-Users-t-Code-github-com-acme-widget");
  });
});

describe("normalizeRemote", () => {
  test("ssh form", () => {
    expect(normalizeRemote("git@github.com:acme/widget.git")).toBe("github.com/acme/widget");
  });
  test("https form", () => {
    expect(normalizeRemote("https://github.com/acme/widget.git")).toBe("github.com/acme/widget");
  });
  test("empty", () => {
    expect(normalizeRemote("")).toBeNull();
  });
});

describe("extractRole", () => {
  test("ในฐานะ X", () => {
    expect(extractRole("ในฐานะ tester ช่วย audit หน่อย")).toBe("tester");
  });
  test("ในฐานะ quoted", () => {
    expect(extractRole('ในฐานะ "pg-writer" อัปเดต docs')).toBe("pg-writer");
  });
  test("#role tag", () => {
    expect(extractRole("#role: architect\nออกแบบระบบหน่อย")).toBe("architect");
  });
  test("no marker → null", () => {
    expect(extractRole("ช่วย fix bug หน่อย")).toBeNull();
  });
  test("null input → null", () => {
    expect(extractRole(null)).toBeNull();
  });
});

describe("classifyTrigger", () => {
  test("tmux chain", () => {
    expect(classifyTrigger(["tmux", "zsh"])).toBe("tmux");
  });
  test("maw chain wins over shell", () => {
    expect(classifyTrigger(["zsh", "maw", "tmux"])).toBe("maw-wake");
  });
  test("launchd desktop", () => {
    expect(classifyTrigger(["launchd"])).toBe("desktop");
  });
  test("bare shell", () => {
    expect(classifyTrigger(["zsh"])).toBe("shell");
  });
  test("empty → unknown", () => {
    expect(classifyTrigger([])).toBe("unknown");
  });
});

describe("listClaudePids", () => {
  test("catches Claude.app + CLI claude, rejects disclaimer wrapper + shells", async () => {
    const pids = await listClaudePids(fakeExec);
    const sorted = pids.map(p => p.pid).sort((a, b) => a - b);
    expect(sorted).toEqual([4321, 5555]);  // desktop + CLI; disclaimer + zsh dropped
  });
});

describe("listClaudeSessions (integration)", () => {
  test("correlates pid → cwd → project dir → session → transcript", async () => {
    const sessions = await listClaudeSessions({
      exec: fakeExec,
      projectsDir: TMP,
      now: () => Date.now(),
      noCache: true,
    });
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const s = sessions.find(x => x.cwd === FAKE_CWD);
    expect(s).toBeDefined();
    expect(s!.status).toBe("active");
    expect(s!.pid).toBe(4321);
    expect(s!.repo).toBe("github.com/acme/widget");
    expect(s!.worktree).toEqual({ name: "widget", branch: "feat/test" });
    expect(s!.triggeredFrom).toBe("tmux");
    expect(s!.lastUserMessage).toContain("ในฐานะ tester");
    expect(s!.lastAssistantMessage).toBe("on it");
    expect(s!.role).toBe("tester");
    expect(s!.sessionId).toBe("sess-1111-2222-3333");
  });

  test("skips project dir with no jsonl", async () => {
    const emptyDir = join(TMP, "-empty-dir");
    await mkdir(emptyDir, { recursive: true });
    const sessions = await listClaudeSessions({
      exec: fakeExec,
      projectsDir: TMP,
      noCache: true,
    });
    expect(sessions.some(s => s.projectDir === "-empty-dir")).toBe(false);
  });

  test("marks session ended when no live pid and old mtime", async () => {
    const oldDir = join(TMP, "-old-cwd");
    await mkdir(oldDir, { recursive: true });
    const old = join(oldDir, "old.jsonl");
    await writeFile(old, JSON.stringify({ type: "user", message: { role: "user", content: "x" } }) + "\n");
    // mtime = now - 2h; outside default recent window
    const past = Date.now() - 2 * 60 * 60 * 1000;
    await (await import("fs/promises")).utimes(old, past / 1000, past / 1000);
    const sessions = await listClaudeSessions({
      exec: fakeExec,
      projectsDir: TMP,
      noCache: true,
    });
    // -old-cwd has no matching pid and is older than recent window → dropped
    expect(sessions.some(s => s.projectDir === "-old-cwd")).toBe(false);
  });
});
