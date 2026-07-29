import { describe, expect, test } from "bun:test";
import {
  heyArgs,
  replyArgs,
  inboxArgs,
  lsArgs,
  companyArgs,
  deptArgs,
  taskArgs,
  runMaw,
  toMcpResult,
  type SpawnFn,
  type SpawnedProc,
} from "../src/vendor/mpr-plugins/mcp/tools";

// ── pure argv mappers ───────────────────────────────────────────────────────

describe("argv mappers", () => {
  test("heyArgs", () => {
    expect(heyArgs("monkut", "hello there")).toEqual(["hey", "monkut", "hello there"]);
  });

  test("replyArgs", () => {
    expect(replyArgs("req-1-abc", "done")).toEqual(["reply", "req-1-abc", "done"]);
  });

  test("inboxArgs status", () => {
    expect(inboxArgs("status")).toEqual(["inbox", "status"]);
  });

  test("inboxArgs list", () => {
    expect(inboxArgs("list")).toEqual(["inbox", "list"]);
  });

  test("inboxArgs read + id", () => {
    expect(inboxArgs("read", "42")).toEqual(["inbox", "read", "42"]);
  });

  test("inboxArgs read without id throws", () => {
    expect(() => inboxArgs("read")).toThrow();
  });

  test("lsArgs verbose false", () => {
    expect(lsArgs(false)).toEqual(["ls"]);
    expect(lsArgs()).toEqual(["ls"]);
  });

  test("lsArgs verbose true", () => {
    expect(lsArgs(true)).toEqual(["ls", "-v"]);
  });

  test("companyArgs ls", () => {
    expect(companyArgs({ action: "ls" })).toEqual(["company", "ls"]);
  });

  test("companyArgs tree (no company)", () => {
    expect(companyArgs({ action: "tree" })).toEqual(["company", "tree"]);
  });

  test("companyArgs tree + company", () => {
    expect(companyArgs({ action: "tree", company: "acme" })).toEqual(["company", "tree", "acme"]);
  });

  test("companyArgs attach", () => {
    expect(companyArgs({ action: "attach", company: "acme", dept: "eng" })).toEqual([
      "company",
      "attach",
      "acme",
      "eng",
    ]);
  });

  test("companyArgs attach missing args throws", () => {
    expect(() => companyArgs({ action: "attach", company: "acme" })).toThrow();
  });

  test("deptArgs assign + role", () => {
    expect(
      deptArgs({ action: "assign", company: "acme", dept: "eng", oracle: "patchwork", role: "lead" }),
    ).toEqual(["dept", "assign", "acme", "eng", "patchwork", "--role", "lead"]);
  });

  test("deptArgs assign no role", () => {
    expect(deptArgs({ action: "assign", company: "acme", dept: "eng", oracle: "patchwork" })).toEqual([
      "dept",
      "assign",
      "acme",
      "eng",
      "patchwork",
    ]);
  });

  test("deptArgs members", () => {
    expect(deptArgs({ action: "members", company: "acme", dept: "eng" })).toEqual([
      "dept",
      "members",
      "acme",
      "eng",
    ]);
  });

  test("deptArgs learn", () => {
    expect(deptArgs({ action: "learn", company: "acme", dept: "eng", text: "redis is at :6379" })).toEqual([
      "dept",
      "learn",
      "acme",
      "eng",
      "redis is at :6379",
    ]);
  });

  test("deptArgs knowledge + query", () => {
    expect(deptArgs({ action: "knowledge", company: "acme", dept: "eng", text: "redis" })).toEqual([
      "dept",
      "knowledge",
      "acme",
      "eng",
      "redis",
    ]);
  });

  test("deptArgs knowledge no query", () => {
    expect(deptArgs({ action: "knowledge", company: "acme", dept: "eng" })).toEqual([
      "dept",
      "knowledge",
      "acme",
      "eng",
    ]);
  });
});

// ── task board argv mappers (kobo-21) — 1:1 with the CLI ─────────────────────

describe("taskArgs", () => {
  test("add: title only", () => {
    expect(taskArgs({ action: "add", title: "fix login" })).toEqual(["company", "task", "add", "fix login"]);
  });

  test("add: all flags in CLI order + common company/from", () => {
    expect(
      taskArgs({
        action: "add",
        title: "big work",
        repo: "acme/app",
        dept: "eng",
        epic: "auth",
        assignee: "patchwork",
        parent: ["kobo-1", "kobo-2"],
        body: "- [ ] step",
        company: "kobo",
        from: "eq3",
      }),
    ).toEqual([
      "company", "task", "add", "big work",
      "--repo", "acme/app",
      "--dept", "eng",
      "--epic", "auth",
      "--assignee", "patchwork",
      "--parent", "kobo-1",
      "--parent", "kobo-2",
      "--body", "- [ ] step",
      "--company", "kobo",
      "--from", "eq3",
    ]);
  });

  test("add: missing title throws", () => {
    expect(() => taskArgs({ action: "add" })).toThrow(/title/);
  });

  // kobo-640 — `needs` is the preferred dependency field; `parent` stays a
  // working deprecated alias. Both may be given at once (union at the CLI, not
  // a silent drop) — the mapper just emits both flag sets, in that order.
  test("add: needs emits --needs (preferred alias for the old --parent)", () => {
    expect(taskArgs({ action: "add", title: "t", needs: ["kobo-1", "kobo-2"] })).toEqual([
      "company", "task", "add", "t",
      "--needs", "kobo-1",
      "--needs", "kobo-2",
    ]);
  });

  test("add: needs + parent together emit both flag sets (needs first)", () => {
    expect(taskArgs({ action: "add", title: "t", needs: ["kobo-1"], parent: ["kobo-2"] })).toEqual([
      "company", "task", "add", "t",
      "--needs", "kobo-1",
      "--parent", "kobo-2",
    ]);
  });

  test("add: --state backlog (kobo-70) is passed through", () => {
    expect(taskArgs({ action: "add", title: "later", state: "backlog" }))
      .toEqual(["company", "task", "add", "later", "--state", "backlog"]);
  });

  test("add: --state approve forwards --reason for a born-in-approve deploy card (kobo-218)", () => {
    expect(taskArgs({ action: "add", title: "deploy m5", state: "approve", reason: "restart maw-server" }))
      .toEqual(["company", "task", "add", "deploy m5", "--state", "approve", "--reason", "restart maw-server"]);
  });

  test("move: id + state → company task move argv (kobo-70)", () => {
    expect(taskArgs({ action: "move", id: "kobo-5", state: "backlog", company: "kobo" }))
      .toEqual(["company", "task", "move", "kobo-5", "backlog", "--company", "kobo"]);
    expect(() => taskArgs({ action: "move", state: "todo" })).toThrow(/id/);
    expect(() => taskArgs({ action: "move", id: "kobo-5" })).toThrow(/state/);
  });

  test("move to approve forwards --reason; missing reason throws (kobo-191)", () => {
    expect(taskArgs({ action: "move", id: "kobo-5", state: "approve", reason: "live deploy" }))
      .toEqual(["company", "task", "move", "kobo-5", "approve", "--reason", "live deploy"]);
    expect(() => taskArgs({ action: "move", id: "kobo-5", state: "approve" })).toThrow(/reason/);
  });

  test("move to need-answer forwards --reason; missing reason throws (kobo-218)", () => {
    expect(taskArgs({ action: "move", id: "kobo-5", state: "need-answer", reason: "A or B?" }))
      .toEqual(["company", "task", "move", "kobo-5", "need-answer", "--reason", "A or B?"]);
    expect(() => taskArgs({ action: "move", id: "kobo-5", state: "need-answer" })).toThrow(/reason/);
  });

  test("approve: id + reason → company task approve argv; missing reason/id throws (kobo-191)", () => {
    expect(taskArgs({ action: "approve", id: "kobo-5", reason: "schema change", company: "kobo" }))
      .toEqual(["company", "task", "approve", "kobo-5", "--reason", "schema change", "--company", "kobo"]);
    expect(() => taskArgs({ action: "approve", reason: "x" })).toThrow(/id/);
    expect(() => taskArgs({ action: "approve", id: "kobo-5" })).toThrow(/reason/);
  });

  test("need-answer: id + reason → company task need-answer argv; missing reason/id throws (kobo-235)", () => {
    expect(taskArgs({ action: "need-answer", id: "kobo-5", reason: "A or B?", company: "kobo" }))
      .toEqual(["company", "task", "need-answer", "kobo-5", "--reason", "A or B?", "--company", "kobo"]);
    expect(() => taskArgs({ action: "need-answer", reason: "x" })).toThrow(/id/);
    expect(() => taskArgs({ action: "need-answer", id: "kobo-5" })).toThrow(/reason/);
  });

  test("edit: id + title/body → company task edit argv; needs id + at least one field (kobo-213)", () => {
    expect(taskArgs({ action: "edit", id: "kobo-5", title: "new title", company: "kobo" }))
      .toEqual(["company", "task", "edit", "kobo-5", "--title", "new title", "--company", "kobo"]);
    expect(taskArgs({ action: "edit", id: "kobo-5", body: "new body" }))
      .toEqual(["company", "task", "edit", "kobo-5", "--body", "new body"]);
    expect(taskArgs({ action: "edit", id: "kobo-5", title: "t", body: "b" }))
      .toEqual(["company", "task", "edit", "kobo-5", "--title", "t", "--body", "b"]);
    // kobo-214 — reviewer is editable too, combinable with title/body
    expect(taskArgs({ action: "edit", id: "kobo-5", reviewer: "worker" }))
      .toEqual(["company", "task", "edit", "kobo-5", "--reviewer", "worker"]);
    expect(() => taskArgs({ action: "edit", title: "t" })).toThrow(/id/);
    expect(() => taskArgs({ action: "edit", id: "kobo-5" })).toThrow(/title, body, reviewer, and\/or deployRequired/);
    // kobo-274: deployRequired counts as a valid edit field + forwards the override flag.
    expect(taskArgs({ action: "edit", id: "kobo-5", deployRequired: false }))
      .toEqual(["company", "task", "edit", "kobo-5", "--no-deploy-required"]);
    expect(taskArgs({ action: "edit", id: "kobo-5", deployRequired: true }))
      .toEqual(["company", "task", "edit", "kobo-5", "--deploy-required"]);
  });

  test("ls: bare", () => {
    expect(taskArgs({ action: "ls" })).toEqual(["company", "task", "ls"]);
  });

  test("ls: --mine + --for + --company (mine is a bare flag)", () => {
    expect(taskArgs({ action: "ls", company: "kobo", mine: true, for: "tony" })).toEqual([
      "company", "task", "ls", "--company", "kobo", "--mine", "--for", "tony",
    ]);
  });

  // kobo-368 — compact-ack sweep: `full` opts an MCP caller into the pre-368
  // full per-card board render (default is now the compact lane-count summary).
  test("ls: full=true appends --full", () => {
    expect(taskArgs({ action: "ls", full: true })).toEqual(["company", "task", "ls", "--full"]);
  });

  test("ls: full omitted/false → no --full flag (compact is the unmarked default)", () => {
    expect(taskArgs({ action: "ls" })).toEqual(["company", "task", "ls"]);
    expect(taskArgs({ action: "ls", full: false })).toEqual(["company", "task", "ls"]);
  });

  test("start / claim / done / unblock take an id + common flags", () => {
    expect(taskArgs({ action: "start", id: "kobo-3" })).toEqual(["company", "task", "start", "kobo-3"]);
    expect(taskArgs({ action: "claim", id: "kobo-3", from: "eq3" })).toEqual(["company", "task", "claim", "kobo-3", "--from", "eq3"]);
    expect(taskArgs({ action: "done", id: "kobo-3" })).toEqual(["company", "task", "done", "kobo-3"]);
    expect(taskArgs({ action: "unblock", id: "kobo-3" })).toEqual(["company", "task", "unblock", "kobo-3"]);
    // kobo-275 — MCP deployed maps 1:1 to the CLI verb (parity by construction: MCP shells to CLI)
    expect(taskArgs({ action: "deployed", id: "kobo-3" })).toEqual(["company", "task", "deployed", "kobo-3"]);
    expect(taskArgs({ action: "deployed", id: "kobo-3", company: "kobo", from: "eq3" }))
      .toEqual(["company", "task", "deployed", "kobo-3", "--company", "kobo", "--from", "eq3"]);
  });

  test("id-required verbs throw without an id", () => {
    for (const action of ["start", "claim", "done", "deployed", "unblock", "review", "pr", "block"] as const) {
      expect(() => taskArgs({ action })).toThrow(/requires an id/);
    }
  });

  test("review: id + optional --to/--reason", () => {
    expect(taskArgs({ action: "review", id: "kobo-3", to: "eq3", reason: "check auth" })).toEqual([
      "company", "task", "review", "kobo-3", "--to", "eq3", "--reason", "check auth",
    ]);
    expect(taskArgs({ action: "review", id: "kobo-3" })).toEqual(["company", "task", "review", "kobo-3"]);
  });

  test("pr: id + pr number (stringified)", () => {
    expect(taskArgs({ action: "pr", id: "kobo-3", pr: 66 })).toEqual(["company", "task", "pr", "kobo-3", "66"]);
  });

  test("pr: forwards --repo (kobo-147 — no CWD remote in MCP)", () => {
    expect(taskArgs({ action: "pr", id: "kobo-3", pr: 66, repo: "meganechan/maw-js" }))
      .toEqual(["company", "task", "pr", "kobo-3", "66", "--repo", "meganechan/maw-js"]);
  });

  test("pr: missing pr number throws", () => {
    expect(() => taskArgs({ action: "pr", id: "kobo-3" })).toThrow(/pr number/);
  });

  // kobo-327: merge-gate sign/merge verbs + add --crew-gate.
  test("sign: id + role → sign <id> --role <tier>", () => {
    expect(taskArgs({ action: "sign", id: "kobo-3", role: "crew" }))
      .toEqual(["company", "task", "sign", "kobo-3", "--role", "crew"]);
  });

  test("sign: missing role throws", () => {
    expect(() => taskArgs({ action: "sign", id: "kobo-3" })).toThrow(/role/);
  });

  // kobo-565: MCP had no way to forward evidence scope — every sign placed through
  // it silently read back as "undeclared" regardless of what the signer actually
  // did. These compare the ACTUAL argv array (not just that it doesn't throw), per
  // the card's own instruction — a pure argv mapper needs its argv checked directly.
  test("sign: evidence is forwarded as --evidence (kobo-565)", () => {
    expect(taskArgs({ action: "sign", id: "kobo-3", role: "head", evidence: "test-run" }))
      .toEqual(["company", "task", "sign", "kobo-3", "--role", "head", "--evidence", "test-run"]);
  });

  test("sign: evidence + evidenceLocus are BOTH forwarded, in order (kobo-565)", () => {
    expect(taskArgs({ action: "sign", id: "kobo-3", role: "head", evidence: "test-run+mutation", evidenceLocus: "~/maw-js-kobo565" }))
      .toEqual(["company", "task", "sign", "kobo-3", "--role", "head", "--evidence", "test-run+mutation", "--evidence-locus", "~/maw-js-kobo565"]);
  });

  test("sign: omitting evidence still produces the plain argv — no flag guessed on the caller's behalf (kobo-565)", () => {
    expect(taskArgs({ action: "sign", id: "kobo-3", role: "crew" }))
      .toEqual(["company", "task", "sign", "kobo-3", "--role", "crew"]); // no --evidence anywhere — posture unchanged, not made mandatory
  });

  test("merge: id only (default method)", () => {
    expect(taskArgs({ action: "merge", id: "kobo-3" })).toEqual(["company", "task", "merge", "kobo-3"]);
  });

  test("merge: forwards --method", () => {
    expect(taskArgs({ action: "merge", id: "kobo-3", method: "squash" }))
      .toEqual(["company", "task", "merge", "kobo-3", "--method", "squash"]);
  });

  test("merge: --single-tier forwarded (kobo-331 no-crew escape)", () => {
    expect(taskArgs({ action: "merge", id: "kobo-3", singleTier: true }))
      .toEqual(["company", "task", "merge", "kobo-3", "--single-tier"]);
  });

  test("add: --crew-gate forwarded (kobo-327 crew-cell card)", () => {
    expect(taskArgs({ action: "add", title: "crew work", crewGate: true }))
      .toEqual(["company", "task", "add", "crew work", "--crew-gate"]);
  });

  test("block: id + required --kind + optional --reason/--for", () => {
    expect(taskArgs({ action: "block", id: "kobo-3", kind: "dependency", reason: "waits #66", for: "tony" })).toEqual([
      "company", "task", "block", "kobo-3", "--kind", "dependency", "--reason", "waits #66", "--for", "tony",
    ]);
  });

  test("block: missing kind throws", () => {
    expect(() => taskArgs({ action: "block", id: "kobo-3" })).toThrow(/kind/);
  });

  // kobo-256 (slice E): cli/mcp PARITY — the MCP block/unblock actions forward to the
  // SAME `company task block/unblock` verbs the CLI dispatches, which drive the SAME store
  // fns (blockTask/unblockTask → writeTaskRecord → slice-A invariant). MCP never has its
  // own block code path, so both surfaces resolve to the one exclusive blocked lane.
  test("cli/mcp parity: block/unblock map to the same `company task` verbs, no MCP-only path", () => {
    expect(taskArgs({ action: "block", id: "kobo-3", kind: "dependency" }).slice(0, 4)).toEqual(["company", "task", "block", "kobo-3"]);
    expect(taskArgs({ action: "unblock", id: "kobo-3" })).toEqual(["company", "task", "unblock", "kobo-3"]);
    // all block flags the CLI reads are forwarded verbatim — no divergence in behavior
    expect(taskArgs({ action: "block", id: "kobo-3", kind: "capability", reason: "no runner", for: "tony" })).toEqual([
      "company", "task", "block", "kobo-3", "--kind", "capability", "--reason", "no runner", "--for", "tony",
    ]);
  });

  test("dep: op add/rm + id + exactly one parent (kobo-134)", () => {
    expect(taskArgs({ action: "dep", id: "kobo-3", op: "add", parent: ["kobo-1"] })).toEqual([
      "company", "task", "dep", "add", "kobo-3", "kobo-1",
    ]);
    expect(taskArgs({ action: "dep", id: "kobo-3", op: "rm", parent: ["kobo-1"], company: "kobo" })).toEqual([
      "company", "task", "dep", "rm", "kobo-3", "kobo-1", "--company", "kobo",
    ]);
  });

  test("dep: missing/invalid op, missing id, and not-exactly-one parent all throw", () => {
    expect(() => taskArgs({ action: "dep", op: "add", parent: ["kobo-1"] })).toThrow(/requires an id/);
    expect(() => taskArgs({ action: "dep", id: "kobo-3", parent: ["kobo-1"] })).toThrow(/op/);
    expect(() => taskArgs({ action: "dep", id: "kobo-3", op: "bogus", parent: ["kobo-1"] })).toThrow(/op/);
    expect(() => taskArgs({ action: "dep", id: "kobo-3", op: "add" })).toThrow(/exactly one parent/);
    expect(() => taskArgs({ action: "dep", id: "kobo-3", op: "add", parent: ["a", "b"] })).toThrow(/exactly one parent/);
  });

  test("comment: id + text + optional --reply-to (kobo-140)", () => {
    expect(taskArgs({ action: "comment", id: "kobo-3", text: "@tony ok?" })).toEqual([
      "company", "task", "comment", "kobo-3", "@tony ok?",
    ]);
    expect(taskArgs({ action: "comment", id: "kobo-3", text: "on it", replyTo: "c1", company: "kobo" })).toEqual([
      "company", "task", "comment", "kobo-3", "on it", "--reply-to", "c1", "--company", "kobo",
    ]);
  });

  test("comment: structured tldr/ask/detail ride to the CLI gate — parity (kobo-263)", () => {
    expect(taskArgs({ action: "comment", id: "kobo-3", text: "@tony", tldr: "deploy green", ask: "approve prod?", detail: "logs ok" })).toEqual([
      "company", "task", "comment", "kobo-3", "@tony", "--tldr", "deploy green", "--ask", "approve prod?", "--detail", "logs ok",
    ]);
  });

  test("comments: id only (kobo-140)", () => {
    expect(taskArgs({ action: "comments", id: "kobo-3" })).toEqual(["company", "task", "comments", "kobo-3"]);
  });

  // kobo-237: the `resolve` action is removed — taskArgs no longer maps it (falls
  // through the switch → undefined). The standalone boundary test pins its absence.
  test("comment/comments: missing required parts throw (kobo-140)", () => {
    expect(() => taskArgs({ action: "comment", id: "kobo-3" })).toThrow(/text/);
    expect(() => taskArgs({ action: "comment", text: "x" })).toThrow(/requires an id/);
    expect(() => taskArgs({ action: "comments" })).toThrow(/requires an id/);
  });

  test("archive: bare + --days + --company", () => {
    expect(taskArgs({ action: "archive" })).toEqual(["company", "task", "archive"]);
    expect(taskArgs({ action: "archive", days: 7, company: "kobo" })).toEqual([
      "company", "task", "archive", "--company", "kobo", "--days", "7",
    ]);
  });

  test("archive: per-card by id (kobo-35) — id is positional, precedes --days", () => {
    expect(taskArgs({ action: "archive", id: "kobo-35" })).toEqual([
      "company", "task", "archive", "kobo-35",
    ]);
    expect(taskArgs({ action: "archive", id: "kobo-35", company: "kobo", from: "tony" })).toEqual([
      "company", "task", "archive", "kobo-35", "--company", "kobo", "--from", "tony",
    ]);
    // id wins over --days: per-card archive is unambiguous, the sweep flag is ignored
    expect(taskArgs({ action: "archive", id: "kobo-35", days: 7 })).toEqual([
      "company", "task", "archive", "kobo-35",
    ]);
  });
});

// ── runMaw result mapping (injected fake spawn) ──────────────────────────────

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

function fakeSpawn(opts: { code: number; stdout?: string; stderr?: string }): {
  fn: SpawnFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn: SpawnFn = (cmd) => {
    calls.push(cmd);
    return {
      stdout: streamOf(opts.stdout ?? ""),
      stderr: streamOf(opts.stderr ?? ""),
      exited: Promise.resolve(opts.code),
    } satisfies SpawnedProc;
  };
  return { fn, calls };
}

describe("runMaw", () => {
  test("exit 0 → ok result with stdout, and prepends 'maw' to argv", async () => {
    const { fn, calls } = fakeSpawn({ code: 0, stdout: "hello\n" });
    const r = await runMaw(["ls"], fn);
    expect(r).toEqual({ ok: true, stdout: "hello\n", stderr: "" });
    expect(calls[0]).toEqual(["maw", "ls"]);

    const mcp = toMcpResult(r);
    expect(mcp.isError).toBeUndefined();
    expect(mcp.content[0].text).toBe("hello\n");
  });

  test("ok with empty stdout → '(ok)'", async () => {
    const { fn } = fakeSpawn({ code: 0, stdout: "" });
    const mcp = toMcpResult(await runMaw(["ls"], fn));
    expect(mcp.content[0].text).toBe("(ok)");
    expect(mcp.isError).toBeUndefined();
  });

  test("non-zero exit → isError with stderr", async () => {
    const { fn } = fakeSpawn({ code: 1, stdout: "", stderr: "boom\n" });
    const r = await runMaw(["reply", "x", "y"], fn);
    expect(r.ok).toBe(false);
    const mcp = toMcpResult(r);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toBe("boom\n");
  });

  test("injected spawn throwing → isError, no crash", async () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error("maw: command not found");
    };
    const r = await runMaw(["ls"], throwingSpawn);
    expect(r.ok).toBe(false);
    const mcp = toMcpResult(r);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toContain("maw: command not found");
  });
});
