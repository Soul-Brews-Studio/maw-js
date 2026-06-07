import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const tmpRoot = mkdtempSync(join(tmpdir(), "maw-artifact-manager-standalone-"));

type ArtifactSummary = {
  team: string;
  taskId: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  files: number;
  hasResult: boolean;
  subject: string;
};

type ArtifactRecord = {
  meta: ArtifactSummary & { commitHash?: string };
  spec: string;
  result: string | null;
  attachments: string[];
  dir: string;
};

let summaries: ArtifactSummary[] = [];
let records = new Map<string, ArtifactRecord>();
const createCalls: unknown[][] = [];
const writeCalls: unknown[][] = [];
const attachCalls: unknown[][] = [];

mock.module("maw-js/lib/artifacts", () => ({
  createArtifact: (team: string, taskId: string, subject: string, description: string) => {
    createCalls.push([team, taskId, subject, description]);
    return join(tmpRoot, team, taskId);
  },
  updateArtifact: () => {},
  writeResult: (team: string, taskId: string, message: string) => {
    writeCalls.push([team, taskId, message]);
  },
  addAttachment: (team: string, taskId: string, name: string, data: Buffer | string) => {
    attachCalls.push([team, taskId, name, Buffer.isBuffer(data) ? data.toString("utf8") : String(data)]);
    return join(tmpRoot, team, taskId, "attachments", name);
  },
  listArtifacts: (team?: string) => summaries.filter((item) => !team || item.team === team),
  getArtifact: (team: string, taskId: string) => records.get(`${team}/${taskId}`) ?? null,
  artifactDir: (team: string, taskId: string) => join(tmpRoot, team, taskId),
}));

mock.module("maw-js/cli/parse-args", () => ({
  parseFlags: (args: string[], spec: Record<string, unknown>) => {
    const out: Record<string, unknown> & { _: string[] } = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      const parser = spec[arg];
      if (!parser) {
        out._.push(arg);
      } else if (parser === Boolean) {
        out[arg] = true;
      } else {
        const value = args[++i];
        if (value === undefined) throw new Error(`option requires argument: ${arg}`);
        out[arg] = value;
      }
    }
    return out;
  },
}));

const { default: artifactHandler } = await import("../../src/vendor/mpr-plugins/artifact-manager/index.ts?plugin-artifact-manager-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  summaries = [
    { team: "alpha", taskId: "T1", status: "pending", owner: "neo", files: 0, hasResult: false, subject: "First artifact" },
    { team: "beta", taskId: "T2", status: "completed", files: 2, hasResult: true, subject: "Second artifact" },
  ];
  records = new Map([
    [
      "alpha/T1",
      {
        meta: { ...summaries[0]!, commitHash: "abc123" },
        spec: "Spec body",
        result: "Result body",
        attachments: ["log.txt"],
        dir: join(tmpRoot, "alpha", "T1"),
      },
    ],
  ]);
  createCalls.length = 0;
  writeCalls.length = 0;
  attachCalls.length = 0;
});

describe("artifact-manager plugin standalone boundary (#2224)", () => {
  test("has no direct core or shared command imports", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/artifact-manager/index.ts"), "utf8");
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
  });

  test("lists artifacts in human output and filters by team", async () => {
    const result = await artifactHandler({ source: "cli", args: ["ls", "alpha"] } as any);

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output);
    expect(output).toContain("TEAM");
    expect(output).toContain("alpha");
    expect(output).toContain("T1");
    expect(output).not.toContain("beta");
  });

  test("shows an artifact in human output", async () => {
    const result = await artifactHandler({ source: "cli", args: ["get", "alpha", "T1"] } as any);

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output);
    expect(output).toContain("First artifact");
    expect(output).toContain("alpha/T1 · pending · neo");
    expect(output).toContain("Spec body");
    expect(output).toContain("Result body");
    expect(output).toContain("log.txt");
  });

  test("writes, attaches, and creates through mocked artifact helpers", async () => {
    const write = await artifactHandler({ source: "cli", args: ["write", "alpha", "T1", "ship", "it"] } as any);
    expect(write.ok).toBe(true);
    expect(writeCalls).toEqual([["alpha", "T1", "ship it"]]);
    expect(stripAnsi(write.output)).toContain("result written");

    const filePath = join(tmpRoot, "note.txt");
    writeFileSync(filePath, "attachment body", "utf8");
    const attach = await artifactHandler({ source: "cli", args: ["attach", "alpha", "T1", filePath] } as any);
    expect(attach.ok).toBe(true);
    expect(attachCalls).toEqual([["alpha", "T1", "note.txt", "attachment body"]]);

    const create = await artifactHandler({ source: "cli", args: ["init", "gamma", "T3", "Subject", "long", "description"] } as any);
    expect(create.ok).toBe(true);
    expect(createCalls).toEqual([["gamma", "T3", "Subject", "long description"]]);
  });

  test("reports unknown subcommands through captured output", async () => {
    const result = await artifactHandler({ source: "cli", args: ["bogus"] } as any);

    expect(result.ok).toBe(true);
    expect(stripAnsi(result.output)).toContain("usage: maw art [ls|get|write|attach|init] [--json]");
  });
});
