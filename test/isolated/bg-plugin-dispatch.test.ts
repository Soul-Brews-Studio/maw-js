import { describe, expect, test } from "bun:test";
import handler from "../../src/vendor/mpr-plugins/bg/src/index";

describe("#1531 bg plugin dispatch shape", () => {
  test("accepts InvokeContext from the plugin registry", async () => {
    const result = await handler({ source: "cli", args: ["--help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw bg");
    expect(result.output).toContain("detached tmux");
  });

  test("keeps raw argv compatibility", async () => {
    const result = await handler(["--help"]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw bg");
  });
});
