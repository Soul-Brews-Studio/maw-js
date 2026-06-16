import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearPresenceRegistryForTests,
  joinPresence,
  leavePresence,
  openPresenceStateCountForTests,
  presenceSnapshot,
  sanitizeViewerName,
  serve,
  setPresenceDepsForTests,
} from "../src/vendor/mpr-plugins/share-presence/index";
import { createShare, clearShareRegistry } from "../src/vendor/mpr-plugins/share/impl";

function socket() {
  const sent: string[] = [];
  return { sent, ws: { send: (payload: string) => { sent.push(payload); } } };
}

function last(sent: string[]) {
  return JSON.parse(sent.at(-1) ?? "{}");
}

describe("share-presence registry", () => {
  beforeEach(() => {
    clearPresenceRegistryForTests();
    clearShareRegistry();
  });

  test("sanitizes display names with control stripping, cap, and anonymous default", () => {
    expect(sanitizeViewerName("\0 Nat\n Viewer\t ")).toBe("Nat Viewer");
    expect(sanitizeViewerName("\x01\x7F")).toBe("anonymous");
    expect([...sanitizeViewerName("x".repeat(80))]).toHaveLength(48);
  });

  test("assigns server viewer ids and broadcasts join/leave snapshots", () => {
    const a = socket();
    const b = socket();
    const first = joinPresence("slug-a", a.ws, "nat", 1000);
    expect("error" in first).toBe(false);
    if ("error" in first) throw new Error("unexpected join error");
    expect(first).toMatchObject({ name: "nat", joinedAt: 1000 });
    expect(first.id).toMatch(/^v_/);
    expect(last(a.sent)).toMatchObject({ type: "presence", slug: "slug-a", count: 1 });

    const second = joinPresence("slug-a", b.ws, "noah", 2000);
    expect("error" in second).toBe(false);
    if ("error" in second) throw new Error("unexpected join error");
    expect(second.id).toMatch(/^v_/);
    expect(second.id).not.toBe(first.id);
    expect(last(a.sent)).toMatchObject({ count: 2 });
    expect(last(b.sent)).toMatchObject({ count: 2 });
    expect(presenceSnapshot("slug-a")?.viewers.map((viewer) => viewer.name)).toEqual(["nat", "noah"]);

    leavePresence("slug-a", second.id);
    expect(last(a.sent)).toMatchObject({ count: 1, viewers: [{ id: first.id, name: "nat", joinedAt: 1000 }] });
    leavePresence("slug-a", first.id);
    expect(presenceSnapshot("slug-a")).toBeNull();
  });

  test("share-presence plugin remains read-only and tmux-free", () => {
    const source = readFileSync(join(import.meta.dir, "../src/vendor/mpr-plugins/share-presence/index.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain("tmux");
    expect(source).not.toContain("sendKeys");
    expect(source).not.toContain("killPane");
    expect(source).not.toContain("resizePane");
  });

  test("closing while token validation is pending leaves no presence state or viewer", async () => {
    const created = await createShare({ target: "%1", auth: "token", ttl: 60, presence: true });
    let resolveVerify: ((ok: boolean) => void) | null = null;
    setPresenceDepsForTests({
      verifyShare: () => new Promise<boolean>((resolve) => { resolveVerify = resolve; }),
    });

    let handlers: { open: (ws: any) => void; close: (ws: any) => void } | null = null;
    await serve({
      ws: {
        route: (_pattern: string, _data: unknown, next: typeof handlers) => { handlers = next; },
      },
    } as any);
    if (!handlers) throw new Error("presence ws handlers were not registered");

    const sent: string[] = [];
    const closed: Array<{ code: number; reason: string }> = [];
    const ws = {
      data: {
        params: { slug: created.slug },
        shareSlug: created.slug,
        shareToken: created.token,
        viewerName: "race",
      },
      send: (payload: string) => { sent.push(payload); },
      close: (code: number, reason: string) => { closed.push({ code, reason }); },
    };

    handlers.open(ws);
    expect(openPresenceStateCountForTests()).toBe(1);
    handlers.close(ws);
    expect(openPresenceStateCountForTests()).toBe(0);
    expect(presenceSnapshot(created.slug)).toBeNull();

    resolveVerify?.(true);
    await Bun.sleep(0);

    expect(openPresenceStateCountForTests()).toBe(0);
    expect(presenceSnapshot(created.slug)).toBeNull();
    expect(sent).toEqual([]);
    expect(closed).toEqual([]);
  });
});
