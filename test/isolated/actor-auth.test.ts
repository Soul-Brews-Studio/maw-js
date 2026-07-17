import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { authenticateActor, resolveAgentSelf } from "../../src/commands/shared/comm-send";
import { runTask } from "../../src/vendor/mpr-plugins/task/index";
import { readTask } from "../../src/core/tasks/store";

// kobo-335: actor-auth — a task-write actor is bound to the local agent self
// (CLAUDE_AGENT_NAME or tmux); a --from/MAW_SENDER claim naming a DIFFERENT oracle is
// refused. env is injected so these are deterministic (no real tmux / process env).

describe("kobo-335 resolveAgentSelf", () => {
  test("CLAUDE_AGENT_NAME wins", () => {
    expect(resolveAgentSelf({ CLAUDE_AGENT_NAME: "eq3" } as any)).toBe("eq3");
  });
  test("no CLAUDE_AGENT_NAME, no TMUX → null (a bare CLI / person, not an oracle)", () => {
    expect(resolveAgentSelf({} as any)).toBeNull();
  });
});

describe("kobo-335 authenticateActor", () => {
  const eq3 = { CLAUDE_AGENT_NAME: "eq3" } as any;
  const none = {} as any;

  test("no claim + agent self → self", () => {
    expect(authenticateActor(undefined, eq3)).toBe("eq3");
  });
  test("no claim + no self → human (bare CLI person)", () => {
    expect(authenticateActor(undefined, none)).toBe("human");
  });
  test("--from matches self → ALLOW", () => {
    expect(authenticateActor("local:eq3", eq3)).toBe("eq3");
  });
  test("--from names a DIFFERENT oracle → REFUSE", () => {
    expect(() => authenticateActor("mba:tony", eq3)).toThrow(/authenticated identity is "eq3", can't act as "tony"/);
  });
  test("--from + no authenticated self → REFUSE (bare CLI can't assert an oracle)", () => {
    expect(() => authenticateActor("local:eq3", none)).toThrow(/no authenticated identity/);
  });
  test("MAW_SENDER is treated as a claim, bound to self", () => {
    expect(() => authenticateActor(undefined, { CLAUDE_AGENT_NAME: "eq3", MAW_SENDER: "mba:tony" } as any))
      .toThrow(/can't act as "tony"/);
    // matching MAW_SENDER is allowed
    expect(authenticateActor(undefined, { CLAUDE_AGENT_NAME: "eq3", MAW_SENDER: "local:eq3" } as any)).toBe("eq3");
  });
  test("--from wins over MAW_SENDER as the claim", () => {
    // explicit --from matches self → allow, even with a mismatched MAW_SENDER present
    expect(authenticateActor("local:eq3", { CLAUDE_AGENT_NAME: "eq3", MAW_SENDER: "mba:tony" } as any)).toBe("eq3");
  });
  test("malformed claim → invalid error (not a silent pass)", () => {
    expect(() => authenticateActor("eq3", eq3)).toThrow(/invalid actor/); // bare, not <node>:<oracle>
  });
});

// Integration: the auth is enforced END-TO-END through a real task WRITE verb — a
// forged --from is refused by the verb (runTask top-level catch → {ok:false}), and a
// self-matching --from stamps the actor. Covers the card AC at the verb level.
describe("kobo-335 actor-auth via runTask (real verb)", () => {
  const dir = mkdtempSync(join(tmpdir(), "maw-actorauth-"));
  const prevDir = process.env.MAW_DATA_DIR;
  const prevAgent = process.env.CLAUDE_AGENT_NAME;
  beforeAll(() => {
    process.env.MAW_DATA_DIR = dir;
    mkdirSync(join(dir, "companies"), { recursive: true });
    writeFileSync(join(dir, "companies", "kobo.json"),
      JSON.stringify({ name: "kobo", departments: { core: { members: [{ oracle: "eq3" }], lead: "eq3" } } }));
  });
  afterAll(() => {
    if (prevDir === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prevDir;
    if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = prevAgent;
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => rmSync(join(dir, "companies", "kobo", "tasks"), { recursive: true, force: true }));
  const run = (args: string[]) => runTask([...args, "--company", "kobo"], () => {});

  test("--from names a DIFFERENT oracle than the agent self → verb REFUSES", async () => {
    process.env.CLAUDE_AGENT_NAME = "eq3";
    const r = await run(["add", "forge", "--from", "mba:tony"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("can't act as \"tony\"");
  });

  test("--from matches the agent self → verb stamps that actor as by", async () => {
    process.env.CLAUDE_AGENT_NAME = "eq3";
    const r = await run(["add", "legit", "--from", "local:eq3"]);
    expect(r.ok).toBe(true);
    expect(readTask("kobo", "kobo-1")!.by).toBe("eq3");
  });

  test("no --from → auto-resolves to the agent self (unchanged path)", async () => {
    process.env.CLAUDE_AGENT_NAME = "eq3";
    const r = await run(["add", "auto"]);
    expect(r.ok).toBe(true);
    expect(readTask("kobo", "kobo-1")!.by).toBe("eq3");
  });

  test("forged sign can't stamp a merge-gate signer as another oracle", async () => {
    process.env.CLAUDE_AGENT_NAME = "eq3";
    await run(["add", "c", "--from", "local:eq3"]);
    const r = await run(["sign", "kobo-1", "--role", "head", "--from", "mba:tony"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("can't act as \"tony\"");
    expect(readTask("kobo", "kobo-1")!.headSignedBy).toBeUndefined(); // no forged signer persisted
  });
});
