import { afterEach, describe, expect, test } from "bun:test";

import {
  detectActiveToken,
  fingerprintTokens,
  listEnvrcNames,
  redact,
  run,
  setRunOverride,
  type RunResult,
} from "../../src/vendor/mpr-plugins/token/lib";

const originalSpawnSync = Bun.spawnSync;

function result(ok: boolean, stdout = "", stderr = "", exitCode = ok ? 0 : 1): RunResult {
  return { ok, stdout, stderr, exitCode };
}

afterEach(() => {
  setRunOverride(null);
  (Bun as any).spawnSync = originalSpawnSync;
});

describe("token lib extra branch coverage", () => {
  test("run falls back cleanly when spawn omits exit code and streams", () => {
    const calls: string[][] = [];
    (Bun as any).spawnSync = (cmd: string[]) => {
      calls.push(cmd);
      return { exitCode: null, stdout: undefined, stderr: undefined };
    };

    expect(run(["mock", "nullish-spawn"])).toEqual({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "",
    });
    expect(calls).toEqual([["mock", "nullish-spawn"]]);
  });

  test("detectActiveToken accepts unquoted direct and legacy pass references while ignoring indented comments", () => {
    expect(detectActiveToken([
      "   # export CLAUDE_TOKEN_NAME=\"commented\"",
      "export CLAUDE_CODE_OAUTH_TOKEN=$(pass show claude/token-unquoted.direct)",
    ].join("\n"))).toBe("unquoted.direct");

    expect(detectActiveToken([
      "  # export CLAUDE_CODE_OAUTH_TOKEN=$TOKEN_OLD",
      "export CLAUDE_CODE_OAUTH_TOKEN=$TOKEN_BAR",
      "TOKEN_BAR=$(pass show claude/token-legacy.unquoted)",
    ].join("\n"))).toBe("legacy.unquoted");
  });

  test("redact handles long regex-like secrets literally and multiple replacements", () => {
    expect(redact("prefix a.*b suffix a.*b plus other-secret", "a.*b", "other-secret")).toBe(
      "prefix ***REDACTED*** suffix ***REDACTED*** plus ***REDACTED***",
    );
  });

  test("listEnvrcNames skips root markers, blanks, directories, and pass headers", () => {
    const calls: string[][] = [];
    setRunOverride((cmd) => {
      calls.push(cmd);
      return result(true, [
        "Password Store",
        "",
        "envrc",
        "envrc/",
        "\u001b[32m├── alpha.env\u001b[0m",
        "└── nested/",
        "    beta-token",
      ].join("\n"));
    });

    expect(listEnvrcNames()).toEqual(["alpha.env", "beta-token"]);
    expect(calls).toEqual([["pass", "ls", "envrc"]]);
  });

  test("fingerprintTokens keeps exact-eight-character tokens and skips failed pass show entries", () => {
    const calls: string[][] = [];
    setRunOverride((cmd) => {
      calls.push(cmd);
      if (cmd[0] === "pass" && cmd[1] === "ls" && cmd[2] === "claude") {
        return result(true, ["token-exact", "token-missing"].join("\n"));
      }
      if (cmd[0] === "pass" && cmd[1] === "show" && cmd[2] === "claude/token-exact") {
        return result(true, "12345678\n");
      }
      if (cmd[0] === "pass" && cmd[1] === "show" && cmd[2] === "claude/token-missing") {
        return result(false, "", "missing", 1);
      }
      return result(false, "", "unexpected", 1);
    });

    expect([...fingerprintTokens().entries()]).toEqual([["12345678", "exact"]]);
    expect(calls).toEqual([
      ["pass", "ls", "claude"],
      ["pass", "show", "claude/token-exact"],
      ["pass", "show", "claude/token-missing"],
    ]);
  });
});
