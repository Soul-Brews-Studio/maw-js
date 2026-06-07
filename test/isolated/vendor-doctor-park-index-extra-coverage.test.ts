/** Extra isolated coverage for thin vendor doctor/park plugin index wrappers. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type InvokeCtx = { source: "cli" | "api"; args: unknown; writer?: (...args: unknown[]) => void };

let doctorCalls: string[][] = [];
let doctorMode: "ok" | "fail" | "throw" = "ok";
let parkCalls: Array<{ fn: "park" | "ls"; args: string[] }> = [];
let parkMode: "ok" | "throw" = "ok";

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/doctor/impl.ts"), () => ({
  cmdDoctor: async (args: string[]) => {
    doctorCalls.push(args);
    if (doctorMode === "throw") throw new Error("doctor exploded");
    console.log(`doctor:${args.join(",") || "all"}`);
    return doctorMode === "ok"
      ? { ok: true, checks: [{ name: "health", ok: true, message: "good" }] }
      : { ok: false, checks: [{ name: "health", ok: false, message: "bad" }] };
  },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/park/src/impl.ts"), () => ({
  cmdPark: async (...args: string[]) => {
    parkCalls.push({ fn: "park", args });
    if (parkMode === "throw") throw new Error("park exploded");
    console.log(`park:${args.join(",") || "current"}`);
  },
  cmdParkLs: async () => {
    parkCalls.push({ fn: "ls", args: [] });
    if (parkMode === "throw") throw new Error("park list exploded");
    console.error("park:list");
  },
}));

const doctor = await import("../../src/vendor/mpr-plugins/doctor/index.ts?vendor-doctor-park-index-extra");
const park = await import("../../src/vendor/mpr-plugins/park/src/index.ts?vendor-doctor-park-index-extra");

beforeEach(() => {
  doctorCalls = [];
  doctorMode = "ok";
  parkCalls = [];
  parkMode = "ok";
});

function writer() {
  const lines: string[] = [];
  return {
    lines,
    fn: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
  };
}

describe("vendor doctor index extra coverage", () => {
  test("exports command metadata, captures CLI logs, maps API check arg, and preserves writer output path", async () => {
    expect(doctor.command).toMatchObject({ name: "doctor" });

    await expect(doctor.default({ source: "cli", args: ["version"] } as InvokeCtx)).resolves.toEqual({
      ok: true,
      output: "doctor:version",
      error: undefined,
    });
    expect(doctorCalls).toEqual([["version"]]);

    const out = writer();
    await expect(doctor.default({ source: "api", args: { check: "install" }, writer: out.fn } as InvokeCtx)).resolves.toEqual({
      ok: true,
      output: undefined,
      error: undefined,
    });
    expect(doctorCalls.at(-1)).toEqual(["install"]);
    expect(out.lines).toEqual(["doctor:install"]);
  });

  test("returns check-failure error and thrown error/log fallbacks", async () => {
    doctorMode = "fail";
    await expect(doctor.default({ source: "api", args: {} } as InvokeCtx)).resolves.toEqual({
      ok: false,
      output: "doctor:all",
      error: "one or more checks failed",
    });

    doctorMode = "throw";
    await expect(doctor.default({ source: "cli", args: ["peers"] } as InvokeCtx)).resolves.toEqual({
      ok: false,
      error: "doctor exploded",
      output: undefined,
    });
  });
});

describe("vendor park index extra coverage", () => {
  test("exports command metadata, dispatches park/list aliases, and captures stdout/stderr", async () => {
    expect(park.command).toMatchObject({ name: "park" });

    await expect(park.default({ source: "cli", args: ["review"] } as InvokeCtx)).resolves.toEqual({
      ok: true,
      output: "park:review",
    });
    await expect(park.default({ source: "cli", args: ["list"] } as InvokeCtx)).resolves.toEqual({
      ok: true,
      output: "park:list",
    });
    await expect(park.default({ source: "cli", args: ["ls"] } as InvokeCtx)).resolves.toEqual({
      ok: true,
      output: "park:list",
    });
    await expect(park.default({ source: "api", args: { ignored: true } } as InvokeCtx)).resolves.toEqual({
      ok: true,
      output: "park:current",
    });
    expect(parkCalls).toEqual([
      { fn: "park", args: ["review"] },
      { fn: "ls", args: [] },
      { fn: "ls", args: [] },
      { fn: "park", args: [] },
    ]);
  });

  test("writer path avoids buffered output and errors prefer captured logs before message", async () => {
    const out = writer();
    await expect(park.default({ source: "cli", args: ["mine"], writer: out.fn } as InvokeCtx)).resolves.toEqual({
      ok: true,
      output: undefined,
    });
    expect(out.lines).toEqual(["park:mine"]);

    parkMode = "throw";
    await expect(park.default({ source: "cli", args: ["list"] } as InvokeCtx)).resolves.toEqual({
      ok: false,
      error: "park list exploded",
      output: undefined,
    });
  });
});
