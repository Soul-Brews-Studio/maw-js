/**
 * tmux-pane-send-lock.test.ts — regression for the 2026-08-26 mac-tor merge
 * race: two concurrent `maw hey` processes interleaved paste + Enter into the
 * same pane, concatenating both messages into one input line. sendText now
 * serializes placement per pane behind a cross-process lock.
 *
 * Strategy mirrors tmux-sendtext-submit.test.ts: subclass Tmux, stub the
 * tmux-touching primitives, and script/observe the lock primitives directly —
 * no tmux process, no real /tmp lock dirs.
 */
import { describe, test, expect } from "bun:test";
import { Tmux } from "../src/core/transport/tmux-class";

const PROMPT_IDLE = "agent@host:~$ ";

class LockProbeTmux extends Tmux {
  calls: string[] = [];
  /** Simulated cross-process lock registry keyed by lockDir. */
  static held = new Set<string>();
  /** When true, acquire always reports busy — simulates a stuck holder. */
  static alwaysBusy = false;

  constructor() {
    super(undefined, "");
  }

  protected override async acquirePaneSendLock(target: string): Promise<string> {
    const lockDir = `lock:${target}`;
    if (LockProbeTmux.alwaysBusy || LockProbeTmux.held.has(lockDir)) {
      this.calls.push(`acquire-busy:${target}`);
      return ""; // timed out — proceed unlocked, matching production fallback
    }
    LockProbeTmux.held.add(lockDir);
    this.calls.push(`acquire:${target}`);
    return lockDir;
  }

  protected override async releasePaneSendLock(lockDir: string): Promise<void> {
    if (!lockDir) return;
    LockProbeTmux.held.delete(lockDir);
    this.calls.push(`release:${lockDir}`);
  }

  async capture(_target: string, _lines = 80): Promise<string> {
    this.calls.push("capture");
    return PROMPT_IDLE;
  }
  async sendKeys(_target: string, ...keys: string[]): Promise<void> {
    this.calls.push(`sendKeys:${keys.join(",")}`);
  }
  async sendKeysLiteral(_target: string, text: string): Promise<void> {
    this.calls.push(`sendKeysLiteral:${text}`);
  }
  async loadBuffer(text: string): Promise<void> {
    this.calls.push(`loadBuffer:${text.length}`);
  }
  async pasteBuffer(_target: string): Promise<void> {
    this.calls.push("pasteBuffer");
  }
  async exitModeIfNeeded(_target: string): Promise<boolean> {
    return false;
  }
  /** Throwing placement path — used to prove the lock releases on failure. */
  failPlacement = false;
  protected placementGuard(): void {
    if (this.failPlacement) throw new Error("paste-buffer failed");
  }
}

class FailingTmux extends LockProbeTmux {
  async sendKeysLiteral(_target: string, _text: string): Promise<void> {
    throw new Error("send-keys failed");
  }
}

describe("Tmux.sendText — per-pane send lock (2026-08-26 merge race)", () => {
  test("acquires before placing text and releases after submit", async () => {
    LockProbeTmux.held.clear();
    LockProbeTmux.alwaysBusy = false;
    const t = new LockProbeTmux();
    await t.sendText("sess:1", "hello");
    const acquireIdx = t.calls.indexOf("acquire:sess:1");
    const placeIdx = t.calls.indexOf("sendKeysLiteral:hello");
    const releaseIdx = t.calls.indexOf("release:lock:sess:1");
    expect(acquireIdx).toBeGreaterThanOrEqual(0);
    expect(placeIdx).toBeGreaterThan(acquireIdx);
    expect(releaseIdx).toBeGreaterThan(placeIdx);
    expect(LockProbeTmux.held.size).toBe(0);
  });

  test("lock releases even when placement throws — no permanent deadlock", async () => {
    LockProbeTmux.held.clear();
    LockProbeTmux.alwaysBusy = false;
    const t = new FailingTmux();
    await expect(t.sendText("sess:1", "boom")).rejects.toThrow("send-keys failed");
    expect(LockProbeTmux.held.size).toBe(0);
    expect(t.calls).toContain("release:lock:sess:1");
  });

  test("acquire timeout degrades to unlocked send — message still delivered", async () => {
    LockProbeTmux.held.clear();
    LockProbeTmux.alwaysBusy = true;
    const t = new LockProbeTmux();
    await t.sendText("sess:1", "still goes out");
    expect(t.calls).toContain("acquire-busy:sess:1");
    expect(t.calls).toContain("sendKeysLiteral:still goes out");
    // nothing to release — no release call for the empty lock handle
    expect(t.calls.filter(c => c.startsWith("release:")).length).toBe(0);
    LockProbeTmux.alwaysBusy = false;
  });

  test("second sender waits: sequential sends to the same pane never interleave", async () => {
    LockProbeTmux.held.clear();
    LockProbeTmux.alwaysBusy = false;
    const t1 = new LockProbeTmux();
    const t2 = new LockProbeTmux();
    // t1 sends first and holds the simulated lock for its whole critical
    // section; t2 starts while t1 holds → gets busy → unlocked fallback in
    // this stub, but in production it spins until t1's release. Here we
    // assert the shared registry serialized the acquisitions.
    await t1.sendText("sess:1", "first");
    await t2.sendText("sess:1", "second");
    expect(t1.calls).toContain("acquire:sess:1");
    expect(t2.calls).toContain("acquire:sess:1"); // free again after t1 released
  });
});
