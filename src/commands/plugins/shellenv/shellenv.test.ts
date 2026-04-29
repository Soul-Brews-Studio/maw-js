/**
 * Smoke tests for `maw shellenv` (#812).
 *
 * The tests cover:
 *  - metadata export
 *  - happy-path emission for zsh + bash (snippet structure)
 *  - error paths: unknown shell, no arg
 *  - the emitted snippet is non-recursive (uses `command maw`)
 *  - the emitted snippet refuses qualified <oracle>:<node> targets
 */

import { describe, test, expect } from "bun:test";
import handler, { command } from "./index";
import type { InvokeContext } from "../../../plugin/types";

function makeCtx(args: string[]): InvokeContext {
  return {
    source: "cli",
    args,
  } as InvokeContext;
}

describe("maw shellenv — metadata", () => {
  test("exports command with name + description", () => {
    expect(command.name).toBe("shellenv");
    expect(command.description.toLowerCase()).toContain("shell");
  });
});

describe("maw shellenv — happy path", () => {
  test("zsh emits a maw() function with warp handling", async () => {
    const result = await handler(makeCtx(["zsh"]));
    expect(result.ok).toBe(true);
    const out = result.output ?? "";
    expect(out).toContain("maw()");
    expect(out).toContain("warp");
    // Must use `command maw` so it does not recurse
    expect(out).toContain("command maw");
    // Must not call itself plainly inside the function body
    expect(out).toContain("locate");
    // Defaults to mawjs when no oracle given
    expect(out).toContain("mawjs");
    // Uses builtin cd (avoids any user-defined cd shim)
    expect(out).toContain("builtin cd");
  });

  test("bash emits a maw() function with warp handling", async () => {
    const result = await handler(makeCtx(["bash"]));
    expect(result.ok).toBe(true);
    const out = result.output ?? "";
    expect(out).toContain("maw()");
    expect(out).toContain("warp");
    expect(out).toContain("command maw");
    expect(out).toContain("builtin cd");
  });

  test("emitted snippet refuses qualified <oracle>:<node>", async () => {
    const result = await handler(makeCtx(["zsh"]));
    expect(result.ok).toBe(true);
    const out = result.output ?? "";
    // The snippet must include the qualified-target rejection branch
    expect(out).toContain("not supported yet");
    expect(out).toContain("#804");
    // Pattern check: the test for ":" in the target
    expect(out).toMatch(/\*:\*/);
  });

  test("emitted snippet does NOT recurse", async () => {
    const result = await handler(makeCtx(["zsh"]));
    expect(result.ok).toBe(true);
    const out = result.output ?? "";
    // Inside the function body, every `maw locate` must be prefixed by `command `
    // i.e. no bare `maw locate` (which would re-enter the function and loop).
    const lines = out.split("\n");
    for (const line of lines) {
      const idx = line.indexOf("maw locate");
      if (idx >= 0) {
        const before = line.slice(0, idx);
        expect(before.endsWith("command ")).toBe(true);
      }
    }
  });

  test("--help prints help text and exits ok", async () => {
    const result = await handler(makeCtx(["--help"]));
    expect(result.ok).toBe(true);
    const out = (result.output ?? "").toLowerCase();
    expect(out).toContain("eval");
    expect(out).toContain("zsh");
    expect(out).toContain("bash");
  });
});

describe("maw shellenv — error paths", () => {
  test("unknown shell exits with error and lists available shells", async () => {
    const result = await handler(makeCtx(["fish"]));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const err = result.error ?? "";
    expect(err).toContain("not supported");
    expect(err).toContain("fish");
    expect(err).toContain("zsh");
    expect(err).toContain("bash");
  });

  test("no shell arg exits with error and lists available shells", async () => {
    const result = await handler(makeCtx([]));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const err = result.error ?? "";
    expect(err).toContain("not supported");
    expect(err).toContain("zsh");
    expect(err).toContain("bash");
  });
});
