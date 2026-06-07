import { describe, expect, test } from "bun:test";
import { resolveTarget } from "../src/core/routing";
import type { MawConfig } from "../src/config";
import type { Session } from "../src/core/runtime/find-window";

const CONFIG: MawConfig = {
  host: "local",
  port: 3456,
  ghqRoot: "/tmp/ghq",
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
  node: "m5",
  namedPeers: [],
  agents: {},
  peers: [],
};

const win = (index: number, name: string) => ({ index, name, active: true });

describe("resolveTarget — session alias window guards (#1565/#1611)", () => {
  test("bare oracle alias prefers the '<name>-oracle' window over first helper pane", () => {
    const sessions: Session[] = [
      { name: "54-mawjs", windows: [win(1, "mawjs-issuer"), win(2, "mawjs-oracle")] },
    ];

    expect(resolveTarget("mawjs", CONFIG, sessions)).toEqual({ type: "local", target: "54-mawjs:2" });
  });

  test("bare oracle alias can strip numeric session prefix and route a single-window session", () => {
    const sessions: Session[] = [
      { name: "48-mawjs-codex", windows: [win(7, "codex-main")] },
    ];

    expect(resolveTarget("mawjs-codex", CONFIG, sessions)).toEqual({ type: "local", target: "48-mawjs-codex:7" });
  });

  test("numeric session id targets prefer the matching oracle window when window is omitted (#1812)", () => {
    const sessions: Session[] = [
      { name: "01-hojo", windows: [win(1, "shell"), win(2, "hojo-oracle")] },
    ];

    expect(resolveTarget("01-hojo", CONFIG, sessions)).toEqual({ type: "local", target: "01-hojo:2" });
  });

  test("ambiguous aliases fail loudly instead of guessing a window", () => {
    const sessions: Session[] = [
      { name: "54-mawjs", windows: [win(1, "mawjs-oracle")] },
      { name: "99-mawjs", windows: [win(1, "mawjs-oracle")] },
    ];

    expect(resolveTarget("mawjs", CONFIG, sessions)).toMatchObject({
      type: "error",
      reason: "session_alias_ambiguous",
      hint: "candidates: 54-mawjs, 99-mawjs",
    });
  });

  test("prefers the exact unnumbered session over a stripped -oracle duplicate", () => {
    const sessions: Session[] = [
      { name: "69-thclaws-thclaws", windows: [win(1, "thclaws-thclaws")] },
      { name: "70-thclaws-thclaws-oracle", windows: [win(1, "thclaws-thclaws-oracle")] },
    ];

    expect(resolveTarget("thclaws-thclaws", CONFIG, sessions)).toEqual({
      type: "local",
      target: "69-thclaws-thclaws:1",
    });
  });

  test("multi-window alias without an oracle window refuses the first-window fallback", () => {
    const sessions: Session[] = [
      { name: "54-mawjs", windows: [win(1, "mawjs-issuer"), win(2, "notes")] },
    ];

    const result = resolveTarget("mawjs", CONFIG, sessions);
    expect(result).toMatchObject({ type: "error", reason: "session_window_not_found" });
    if (result?.type === "error") {
      expect(result.hint).toContain("54-mawjs:1 (mawjs-issuer)");
      expect(result.hint).toContain("54-mawjs:2 (notes)");
    }
  });
});
