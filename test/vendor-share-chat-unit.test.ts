import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chatViewerCount,
  clearChatRegistryForTests,
  openChatStateCountForTests,
  sanitizeChatName,
  sanitizeChatText,
  serve,
  setChatDepsForTests,
} from "../src/vendor/mpr-plugins/share-chat/index";
import { clearShareRegistry, createShare } from "../src/vendor/mpr-plugins/share/impl";

function last(sent: string[]) {
  return JSON.parse(sent.at(-1) ?? "{}");
}

describe("share-chat relay", () => {
  beforeEach(() => {
    clearChatRegistryForTests();
    clearShareRegistry();
  });

  test("sanitizes viewer names and chat text with length caps", () => {
    expect(sanitizeChatName("\0 Nat\n Viewer\t ")).toBe("Nat Viewer");
    expect(sanitizeChatName("\x01\x7F")).toBe("anonymous");
    expect([...sanitizeChatName("x".repeat(80))]).toHaveLength(48);
    expect(sanitizeChatText("\0 hello\nthere \x07")).toBe("hello\nthere");
    expect([...sanitizeChatText("x".repeat(2_100))]).toHaveLength(2_000);
  });

  test("verifies share tokens, requires --chat, and broadcasts ephemeral messages", async () => {
    const created = await createShare({ target: "%1", auth: "token", ttl: 60, chat: true });
    setChatDepsForTests({ now: () => 1234 });

    let handlers: { open: (ws: any) => void; message: (ws: any, message: unknown) => void; close: (ws: any) => void } | null = null;
    await serve({
      ws: { route: (_pattern: string, _data: unknown, next: typeof handlers) => { handlers = next; } },
    } as any);
    if (!handlers) throw new Error("chat ws handlers were not registered");

    const aliceSent: string[] = [];
    const bobSent: string[] = [];
    const alice = {
      data: { params: { slug: created.slug }, shareSlug: created.slug, shareToken: created.token, viewerName: "Alice" },
      send: (payload: string) => { aliceSent.push(payload); },
      close: () => undefined,
    };
    const bob = {
      data: { params: { slug: created.slug }, shareSlug: created.slug, shareToken: created.token, viewerName: "Bob" },
      send: (payload: string) => { bobSent.push(payload); },
      close: () => undefined,
    };

    handlers.open(alice);
    handlers.open(bob);
    await Bun.sleep(0);

    expect(last(aliceSent)).toMatchObject({ type: "chat-ready", slug: created.slug, name: "Alice" });
    expect(last(bobSent)).toMatchObject({ type: "chat-ready", slug: created.slug, name: "Bob" });
    expect(chatViewerCount(created.slug)).toBe(2);

    handlers.message(alice, JSON.stringify({ type: "chat", text: " hi swarm \x07 " }));
    expect(last(aliceSent)).toMatchObject({ type: "chat", slug: created.slug, name: "Alice", text: "hi swarm", sentAt: 1234 });
    expect(last(bobSent)).toMatchObject({ type: "chat", slug: created.slug, name: "Alice", text: "hi swarm", sentAt: 1234 });
    expect(last(aliceSent).id).toMatch(/^m_/);
    expect(last(aliceSent).viewerId).toMatch(/^c_/);

    handlers.close(bob);
    expect(chatViewerCount(created.slug)).toBe(1);
    handlers.close(alice);
    expect(chatViewerCount(created.slug)).toBe(0);
  });

  test("rejects valid shares that did not opt into chat", async () => {
    const created = await createShare({ target: "%1", auth: "token", ttl: 60 });
    let handlers: { open: (ws: any) => void } | null = null;
    await serve({ ws: { route: (_pattern: string, _data: unknown, next: typeof handlers) => { handlers = next; } } } as any);
    if (!handlers) throw new Error("chat ws handlers were not registered");

    const closed: Array<{ code: number; reason: string }> = [];
    const ws = {
      data: { params: { slug: created.slug }, shareSlug: created.slug, shareToken: created.token, viewerName: "blocked" },
      send: () => undefined,
      close: (code: number, reason: string) => { closed.push({ code, reason }); },
    };

    handlers.open(ws);
    await Bun.sleep(0);
    expect(closed).toEqual([{ code: 1008, reason: "share chat not enabled" }]);
    expect(chatViewerCount(created.slug)).toBe(0);
  });

  test("closing while token validation is pending leaves no chat state or viewer", async () => {
    const created = await createShare({ target: "%1", auth: "token", ttl: 60, chat: true });
    let resolveVerify: ((ok: boolean) => void) | null = null;
    setChatDepsForTests({ verifyShare: () => new Promise<boolean>((resolve) => { resolveVerify = resolve; }) });

    let handlers: { open: (ws: any) => void; close: (ws: any) => void } | null = null;
    await serve({ ws: { route: (_pattern: string, _data: unknown, next: typeof handlers) => { handlers = next; } } } as any);
    if (!handlers) throw new Error("chat ws handlers were not registered");

    const sent: string[] = [];
    const closed: Array<{ code: number; reason: string }> = [];
    const ws = {
      data: { params: { slug: created.slug }, shareSlug: created.slug, shareToken: created.token, viewerName: "race" },
      send: (payload: string) => { sent.push(payload); },
      close: (code: number, reason: string) => { closed.push({ code, reason }); },
    };

    handlers.open(ws);
    expect(openChatStateCountForTests()).toBe(1);
    handlers.close(ws);
    expect(openChatStateCountForTests()).toBe(0);
    expect(chatViewerCount(created.slug)).toBe(0);

    resolveVerify?.(true);
    await Bun.sleep(0);

    expect(openChatStateCountForTests()).toBe(0);
    expect(chatViewerCount(created.slug)).toBe(0);
    expect(sent).toEqual([]);
    expect(closed).toEqual([]);
  });

  test("share-chat plugin remains read-only and tmux-free", () => {
    const source = readFileSync(join(import.meta.dir, "../src/vendor/mpr-plugins/share-chat/index.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain("tmux");
    expect(source).not.toContain("sendKeys");
    expect(source).not.toContain("killPane");
    expect(source).not.toContain("resizePane");
  });
});
