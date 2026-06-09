import { describe, expect, test } from "bun:test";
const { validateBasicFields, validateConfigShape } = await import(`${process.cwd()}/src/config/validate.ts?config-validate-${Date.now()}`);

function collectBasic(raw: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  const warnings: string[] = [];
  validateBasicFields(raw, result, (field, msg) => warnings.push(`${field}: ${msg}`));
  return { result, warnings };
}

describe("validateBasicFields", () => {
  test("accepts every valid scalar/map field and trims host/bind", () => {
    const { result, warnings } = collectBasic({
      host: "  m5  ",
      bind: "  0.0.0.0  ",
      port: "3456",
      ghqRoot: "/opt/Code",
      oracleUrl: "http://localhost:47779",
      env: { A: "B" },
      commands: { default: "claude", codex: "codex" },
      engines: { codex: { cmd: "codex", label: "Codex CLI" } },
      sessions: { mawjs: "54-mawjs" },
      tmuxSocket: "maw",
    });

    expect(warnings).toEqual([]);
    expect(result).toEqual({
      host: "m5",
      bind: "0.0.0.0",
      port: 3456,
      ghqRoot: "/opt/Code",
      oracleUrl: "http://localhost:47779",
      env: { A: "B" },
      commands: { default: "claude", codex: "codex" },
      engines: { codex: { name: "codex", cmd: "codex", label: "Codex CLI" } },
      sessions: { mawjs: "54-mawjs" },
      tmuxSocket: "maw",
    });
  });

  test("warns for invalid scalar fields and leaves result untouched", () => {
    const { result, warnings } = collectBasic({
      host: "   ",
      bind: 123,
      port: 0,
      ghqRoot: "",
      oracleUrl: "",
      tmuxSocket: 42,
    });

    expect(result).toEqual({});
    expect(warnings).toEqual([
      "host: must be a non-empty string",
      "bind: must be a non-empty string",
      "port: must be an integer 1-65535",
      "ghqRoot: must be a non-empty string",
      "oracleUrl: must be a non-empty string",
      "tmuxSocket: must be a string",
    ]);
  });


  test("coerces deprecated gateway auto to bun with a warning", () => {
    const { result, warnings } = collectBasic({ gateway: "auto" });

    expect(result).toEqual({ gateway: "bun" });
    expect(warnings).toEqual(['gateway: "auto" is deprecated, using "bun"']);
  });

  test("warns for invalid maps and commands without default string", () => {
    const cases = [
      [{ env: [] }, "env: must be an object"],
      [{ commands: [] }, "commands: must be an object"],
      [{ commands: { codex: "codex" } }, "commands: must include a 'default' string entry"],
      [{ commands: { default: 123 } }, "commands: must include a 'default' string entry"],
      [{ engines: [] }, "engines: must be an object"],
      [{ engines: { codex: false } }, "engines.codex: must be an object"],
      [{ engines: { codex: { cmd: "" } } }, "engines.codex.cmd: must be a non-empty string"],
      [{ sessions: [] }, "sessions: must be an object"],
    ] as const;

    for (const [raw, warning] of cases) {
      const { result, warnings } = collectBasic(raw as Record<string, unknown>);
      expect(result).toEqual({});
      expect(warnings).toEqual([warning]);
    }
  });
});

describe("validateConfigShape", () => {
  test("rejects non-object configs", () => {
    expect(validateConfigShape(null)).toEqual(["Config must be an object"]);
    expect(validateConfigShape("bad")).toEqual(["Config must be an object"]);
  });

  test("accepts a valid config shape", () => {
    expect(validateConfigShape({
      host: "local",
      bind: "0.0.0.0",
      port: 3456,
      ghqRoot: "/opt/Code",
      oracleUrl: "http://localhost:47779",
      tmuxSocket: "maw",
      federationToken: "x".repeat(16),
      env: { A: "B" },
      commands: { default: "claude" },
      engines: { codex: { cmd: "codex" } },
      sessions: { mawjs: "54-mawjs" },
      peers: ["http://peer:3456"],
      errorForward: { target: "doctor" },
      gateway: "auto",
    })).toEqual([]);
  });

  test("reports invalid scalar fields", () => {
    expect(validateConfigShape({
      host: 1,
      bind: 2,
      port: 70000,
      ghqRoot: 3,
      oracleUrl: 4,
      tmuxSocket: 5,
      federationToken: 6,
      errorForward: [],
    })).toEqual([
      "host must be a string",
      "bind must be a string",
      "port must be an integer 1-65535",
      "ghqRoot must be a string",
      "oracleUrl must be a string",
      "tmuxSocket must be a string",
      "federationToken must be a string",
      "errorForward must be an object",
    ]);
  });

  test("reports invalid object maps and nested values", () => {
    expect(validateConfigShape({
      env: { GOOD: "ok", BAD: 1 },
      commands: { default: "claude", bad: false },
      engines: { nope: false, broken: { cmd: "" }, badName: { name: 7, cmd: "tool" } },
      sessions: { ok: "54-mawjs", bad: 2 },
      errorForward: { target: 8 },
    })).toEqual([
      "errorForward.target must be a string",
      "env.BAD must be a string",
      "commands.bad must be a string",
      "engines.nope must be an object",
      "engines.broken.cmd must be a non-empty string",
      "engines.badName.name must be a string",
      "sessions.bad must be a string",
    ]);

    expect(validateConfigShape({ env: [], commands: null, sessions: [] })).toEqual([
      "env must be a Record<string, string>",
      "commands must be a Record<string, string>",
      "sessions must be a Record<string, string>",
    ]);
  });

  test("reports invalid peers containers and elements", () => {
    expect(validateConfigShape({ peers: "http://peer" })).toEqual(["peers must be a string[]"]);
    expect(validateConfigShape({ peers: ["http://peer", 123, null] })).toEqual([
      "peers[1] must be a string",
      "peers[2] must be a string",
    ]);
  });
});
