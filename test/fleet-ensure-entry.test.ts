import { describe, expect, spyOn, test } from "bun:test";
import { ensureFleetSessionEntry, _test } from "../src/commands/shared/fleet-ensure";

function deps(files = new Map<string, string>()) {
  const writes: Array<[string, string]> = [];
  const dirs = new Set<string>();
  return {
    files,
    writes,
    dirs,
    deps: {
      fleetDirForWrite: () => "/state/fleet",
      fleetDirsForRead: () => ["/state/fleet", "/legacy/fleet"],
      getGhqRoot: () => "/ghq",
      loadFleetEntries: () => [...files.entries()].map(([path, content]) => {
        const file = path.split("/").pop()!;
        const session = JSON.parse(content);
        return { file, path, num: 0, groupName: file.replace(/\.json$/, ""), session };
      }),
      existsSync: (path: string) => files.has(path),
      mkdirSync: (path: string) => { dirs.add(path); return undefined as any; },
      writeFileSync: (path: string, content: string) => { files.set(path, content); writes.push([path, content]); },
      now: () => new Date("2026-05-28T01:02:03.000Z"),
    },
  };
}

describe("ensureFleetSessionEntry", () => {
  test("derives repo from ghq root and creates a wakeable fleet file", () => {
    const h = deps();
    const result = ensureFleetSessionEntry({
      session: "77-mawjs",
      window: "mawjs-oracle",
      cwd: "/ghq/github.com/Soul-Brews-Studio/maw-js",
      createdBy: "maw wake",
    }, h.deps);

    expect(result.status).toBe("created");
    expect(h.dirs.has("/state/fleet")).toBe(true);
    expect(JSON.parse(h.files.get("/state/fleet/77-mawjs.json")!)).toEqual({
      name: "77-mawjs",
      created_at: "2026-05-28T01:02:03.000Z",
      created_by: "maw wake",
      auto_registered: true,
      windows: [{ name: "mawjs-oracle", repo: "github.com/Soul-Brews-Studio/maw-js" }],
    });
  });


  test("refuses to register archive-copy cwd as a fleet repo (#2795)", () => {
    const h = deps();
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
    try {
      const result = ensureFleetSessionEntry({
        session: "77-mawjs",
        window: "mawjs-codex-3",
        cwd: "/ghq/_archive/oracle-world/nat-2026-06-10/ghq/github.com/Soul-Brews-Studio/maw-js",
        createdBy: "maw wake",
      }, h.deps);

      expect(result).toMatchObject({
        status: "skipped",
        reason: expect.stringContaining("refusing to register archive copy"),
      });
    } finally {
      warnSpy.mockRestore();
    }

    expect(warnings).toEqual([expect.stringContaining("refusing to register archive copy")]);
    expect(h.writes).toEqual([]);
    expect(_test.repoFromCwd("/ghq/_archive/oracle-world/nat-2026-06-10/ghq/github.com/Soul-Brews-Studio/maw-js", "/ghq")).toBeNull();
  });

  test("updates an existing entry with the initial window instead of duplicating files", () => {
    const h = deps(new Map([["/legacy/fleet/77-mawjs.json", JSON.stringify({
      name: "77-mawjs",
      windows: [{ name: "lead", repo: "github.com/Soul-Brews-Studio/maw-js" }],
    })]]));

    const result = ensureFleetSessionEntry({
      session: "77-mawjs",
      window: "worker",
      cwd: "/ghq/github.com/Soul-Brews-Studio/maw-js/agents/1-worker",
      createdBy: "maw new",
    }, h.deps);

    expect(result.status).toBe("updated");
    expect(h.writes.map(([path]) => path)).toEqual(["/legacy/fleet/77-mawjs.json"]);
    expect(JSON.parse(h.files.get("/legacy/fleet/77-mawjs.json")!).windows).toEqual([
      { name: "lead", repo: "github.com/Soul-Brews-Studio/maw-js" },
      { name: "worker", repo: "github.com/Soul-Brews-Studio/maw-js" },
    ]);
  });

  test("skips unsafe names and cwd outside ghq instead of writing empty windows", () => {
    const h = deps();
    expect(ensureFleetSessionEntry({ session: "bad/name", window: "lead", cwd: "/ghq/github.com/org/repo", createdBy: "maw new" }, h.deps)).toMatchObject({ status: "skipped" });
    expect(ensureFleetSessionEntry({ session: "ok", window: "lead", cwd: "/tmp/not-ghq", createdBy: "maw new" }, h.deps)).toMatchObject({ status: "skipped" });
    expect(h.writes).toEqual([]);
  });

  test("repo derivation uses the configured ghq root and rejects too-shallow alternate roots", () => {
    expect(_test.repoFromCwd("/ghq/github.com/Soul-Brews-Studio/maw-js", "/ghq")).toBe("github.com/Soul-Brews-Studio/maw-js");
    expect(_test.repoFromCwd("/ghq/github.com/Soul-Brews-Studio/maw-js", "/ghq/github.com")).toBeNull();
  });
});
