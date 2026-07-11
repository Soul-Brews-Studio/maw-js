import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// kobo-289 — lock the seat-back.sh UserPromptSubmit matcher: it must fire
// `maw presence back` for the explicit /seat command (and /seat <args>) and
// for NOTHING else — a misfire on natural-language text or /seatbelt would
// clear away when the operator did not return. Runs the real hook script with
// a fake `maw` on PATH that records its args, exactly as the harness invokes it.
const HOOK = join(import.meta.dir, "..", "scripts", "hooks", "seat-back.sh");

function runGate(prompt: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "seat-back-"));
  const log = join(dir, "calls.log");
  const fakeMaw = join(dir, "maw");
  writeFileSync(fakeMaw, `#!/bin/bash\necho "$*" >> "${log}"\n`);
  chmodSync(fakeMaw, 0o755);
  const res = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ prompt }),
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: "utf-8",
  });
  // Inject-nothing hook: must never pollute the prompt via stdout.
  expect(res.stdout).toBe("");
  let calls: string[] = [];
  try { calls = readFileSync(log, "utf-8").split("\n").filter(Boolean); } catch {}
  return calls;
}

describe("seat-back.sh gate (kobo-289)", () => {
  test("/seat fires `maw presence back`", () => {
    expect(runGate("/seat")).toEqual(["presence back"]);
  });

  test("/seat with args still fires", () => {
    expect(runGate("/seat now please")).toEqual(["presence back"]);
  });

  test("natural-language mention does NOT fire", () => {
    expect(runGate("please /seat me back")).toEqual([]);
  });

  test("/seatbelt (prefix collision) does NOT fire", () => {
    expect(runGate("/seatbelt")).toEqual([]);
  });
});
