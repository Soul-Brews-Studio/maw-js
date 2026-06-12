/**
 * resolveMyName — TMUX-guard regression (sender mis-tag outside tmux).
 *
 * Bug: when `maw hey` runs from a claude that is NOT inside tmux ($TMUX unset),
 * `tmux display-message` attaches to the most-recent/lowest session and returns
 * a name instead of throwing. resolveMyName then mis-tagged the sender as that
 * stray session (e.g. "05-eq3") so the recipient saw the wrong "from".
 *
 * The guard: only shell out to tmux when $TMUX is set; otherwise fall back to
 * config.node (real identity) or "cli". Inside tmux the behavior is unchanged.
 *
 * We spy on the SHARED child_process module object (comm-send.ts does
 * require("child_process") at call time, which returns the same cached builtin),
 * so execSync is stubbed deterministically to simulate tmux always resolving a
 * (bogus) session name — exactly the buggy condition.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createRequire } from "module";
import { resolveMyName } from "../src/commands/shared/comm-send";

const nodeRequire = createRequire(import.meta.url);
const childProcess = nodeRequire("child_process");

describe("resolveMyName — TMUX guard (sender attribution)", () => {
  const origName = process.env.CLAUDE_AGENT_NAME;
  const origTmux = process.env.TMUX;
  let spy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
    if (origName === undefined) delete process.env.CLAUDE_AGENT_NAME;
    else process.env.CLAUDE_AGENT_NAME = origName;
    if (origTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = origTmux;
  });

  test("outside tmux ($TMUX unset) falls back to config.node — never shells out to tmux", () => {
    delete process.env.CLAUDE_AGENT_NAME;
    delete process.env.TMUX;
    spy = spyOn(childProcess, "execSync").mockReturnValue("05-eq3\n" as never);
    expect(resolveMyName({ node: "m5" } as never)).toBe("m5");
    expect(spy).not.toHaveBeenCalled(); // the stray "05-eq3" must not even be consulted
  });

  test("outside tmux with no config.node falls back to 'cli'", () => {
    delete process.env.CLAUDE_AGENT_NAME;
    delete process.env.TMUX;
    spy = spyOn(childProcess, "execSync").mockReturnValue("05-eq3\n" as never);
    expect(resolveMyName({} as never)).toBe("cli");
    expect(spy).not.toHaveBeenCalled();
  });

  test("inside tmux ($TMUX set) uses the session name, stripping the numeric prefix", () => {
    delete process.env.CLAUDE_AGENT_NAME;
    process.env.TMUX = "/tmp/tmux-1000/default,4242,0";
    spy = spyOn(childProcess, "execSync").mockReturnValue("05-eq3\n" as never);
    expect(resolveMyName({ node: "m5" } as never)).toBe("eq3"); // "05-eq3" → "eq3"
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("CLAUDE_AGENT_NAME wins over both tmux and config.node", () => {
    process.env.CLAUDE_AGENT_NAME = "patchwork";
    process.env.TMUX = "/tmp/tmux-1000/default,4242,0";
    spy = spyOn(childProcess, "execSync").mockReturnValue("05-eq3\n" as never);
    expect(resolveMyName({ node: "m5" } as never)).toBe("patchwork");
    expect(spy).not.toHaveBeenCalled();
  });
});
