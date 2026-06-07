import { describe, it, expect } from "bun:test";
import { extractAttachPath, dropImageNotifyStub } from "./image-notify-stub";

describe("extractAttachPath", () => {
  it("parses the dashboard image marker", () => {
    const text = "[ภาพแนบ — โปรดดู: /root/imports/maw-attach/1780534701_21814.jpg]\n";
    expect(extractAttachPath(text)).toBe("/root/imports/maw-attach/1780534701_21814.jpg");
  });

  it("returns null for ordinary (non-image) send text", () => {
    expect(extractAttachPath("สวัสดี ช่วยดู PR หน่อย")).toBeNull();
    expect(extractAttachPath("")).toBeNull();
  });
});

describe("dropImageNotifyStub", () => {
  const imageText = "[ภาพแนบ — โปรดดู: /root/imports/maw-attach/1780534701_21814.jpg]\n";

  function recorder() {
    const writes: { path: string; data: string }[] = [];
    const mkdirs: string[] = [];
    return {
      writes,
      mkdirs,
      deps: {
        now: () => 1_780_534_800_000, // fixed → ts 1780534800
        write: async (path: string, data: string) => {
          writes.push({ path, data });
        },
        mkdirp: async (dir: string) => {
          mkdirs.push(dir);
        },
      },
    };
  }

  it("writes a sweep-visible stub into <cwd>/ψ/inbox for a fleet target", async () => {
    const r = recorder();
    const out = await dropImageNotifyStub("04-echo:0", imageText, {
      ...r.deps,
      resolveCwd: () => "/root/projects/echo-oracle",
    });
    expect(out).toBe(
      "/root/projects/echo-oracle/ψ/inbox/1780534800_from-boss_image-1780534701_21814.jpg.md",
    );
    expect(r.mkdirs).toContain("/root/projects/echo-oracle/ψ/inbox");
    expect(r.writes).toHaveLength(1);
    // Sweep contract: top-level *.md, not "." / "__CANARY-" prefixed.
    const name = out!.split("/").pop()!;
    expect(name.endsWith(".md")).toBe(true);
    expect(name.startsWith(".")).toBe(false);
    expect(name.startsWith("__CANARY-")).toBe(false);
    expect(r.writes[0].data).toContain("type: image-notify");
    expect(r.writes[0].data).toContain("/root/imports/maw-attach/1780534701_21814.jpg");
  });

  it("routes Nari to her canonical repo via the fleet resolver (not nari-oracle)", async () => {
    const r = recorder();
    // resolveTargetCwd reads fleet 05-nari.json → repo "tconhr".
    const out = await dropImageNotifyStub("05-nari:0", imageText, {
      ...r.deps,
      resolveCwd: () => "/root/projects/tconhr",
    });
    expect(out).toBe(
      "/root/projects/tconhr/ψ/inbox/1780534800_from-boss_image-1780534701_21814.jpg.md",
    );
  });

  it("skips (returns null) for a non-image send", async () => {
    const r = recorder();
    const out = await dropImageNotifyStub("04-echo:0", "just a normal message", {
      ...r.deps,
      resolveCwd: () => "/root/projects/echo-oracle",
    });
    expect(out).toBeNull();
    expect(r.writes).toHaveLength(0);
  });

  it("skips (returns null) for a non-fleet target with no resolvable cwd", async () => {
    const r = recorder();
    const out = await dropImageNotifyStub("ghost:0", imageText, {
      ...r.deps,
      resolveCwd: () => null,
    });
    expect(out).toBeNull();
    expect(r.writes).toHaveLength(0);
  });

  it("is fail-safe: a write error never throws, returns null", async () => {
    const out = await dropImageNotifyStub("04-echo:0", imageText, {
      now: () => 1_780_534_800_000,
      resolveCwd: () => "/root/projects/echo-oracle",
      mkdirp: async () => {},
      write: async () => {
        throw new Error("disk full");
      },
    });
    expect(out).toBeNull();
  });
});
