import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "maw-artifact-manager-"));

let listReturn: any[] = [];
let getReturn: any = null;
let createReturn = "/tmp/artifacts/team-1";
let updateReturn: any = undefined;
let addAttachmentReturn = "/tmp/artifacts/team-1/attachments/proof.txt";
let artifactDirReturn = "/tmp/artifacts/team-1";
let throwLabel: string | null = null;

let listCalls: any[] = [];
let getCalls: any[] = [];
let createCalls: any[] = [];
let writeCalls: any[] = [];
let attachCalls: any[] = [];
let artifactDirCalls: any[] = [];

mock.module("maw-js/lib/artifacts", () => ({
  createArtifact: (...args: any[]) => {
    createCalls.push(args);
    if (throwLabel === "createArtifact") throw new Error("create exploded");
    return createReturn;
  },
  updateArtifact: (...args: any[]) => {
    if (throwLabel === "updateArtifact") throw new Error("update exploded");
    return updateReturn;
  },
  writeResult: (...args: any[]) => {
    writeCalls.push(args);
    if (throwLabel === "writeResult") throw new Error("write exploded");
  },
  addAttachment: (...args: any[]) => {
    attachCalls.push(args);
    if (throwLabel === "addAttachment") throw new Error("attach exploded");
    return addAttachmentReturn;
  },
  listArtifacts: (...args: any[]) => {
    listCalls.push(args);
    if (throwLabel === "listArtifacts") throw new Error("list exploded");
    return listReturn;
  },
  getArtifact: (...args: any[]) => {
    getCalls.push(args);
    if (throwLabel === "getArtifact") throw new Error("get exploded");
    return getReturn;
  },
  artifactDir: (...args: any[]) => {
    artifactDirCalls.push(args);
    if (throwLabel === "artifactDir") throw new Error("dir exploded");
    return artifactDirReturn;
  },
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/artifact-manager/index.ts?artifact-manager-index-coverage");

beforeEach(() => {
  listReturn = [];
  getReturn = null;
  createReturn = "/tmp/artifacts/team-1";
  updateReturn = undefined;
  addAttachmentReturn = "/tmp/artifacts/team-1/attachments/proof.txt";
  artifactDirReturn = "/tmp/artifacts/team-1";
  throwLabel = null;

  listCalls = [];
  getCalls = [];
  createCalls = [];
  writeCalls = [];
  attachCalls = [];
  artifactDirCalls = [];
});

afterEach(() => {
  for (const name of ["proof.txt"]) {
    try {
      rmSync(join(TMP_ROOT, name), { force: true });
    } catch {
      // ignore
    }
  }
});

async function invoke(args: string[], writer?: (...parts: unknown[]) => void) {
  return handler({ source: "cli", args, writer } as any);
}

function makeWriterSink() {
  const writes: string[] = [];
  return {
    writes,
    writer: (...parts: unknown[]) => writes.push(parts.map(String).join(" ")),
  };
}

describe("artifact-manager plugin index coverage", () => {
  test("exports metadata and default ls prints the empty state", async () => {
    const { writes, writer } = makeWriterSink();
    const result = await invoke([], writer);

    expect(command).toEqual({
      name: ["art", "artifact-manager"],
      description: "Task artifact manager — ls, get, write, attach, init",
      flags: {
        "--json": Boolean,
        "--team": String,
      },
    });
    expect(listCalls).toEqual([[]]);
    expect(result).toBeUndefined();
    expect(writes).toEqual(["No artifacts."]);
  });

  test("ls supports team filters, json output, and formatted table rendering", async () => {
    listReturn = [
      {
        team: "alpha",
        taskId: "7",
        status: "completed",
        owner: "nat",
        files: 2,
        hasResult: true,
        subject: "Fix wake resolver coverage regression",
      },
      {
        team: "alpha",
        taskId: "8",
        status: "in_progress",
        owner: null,
        files: 0,
        hasResult: false,
        subject: "Longer description to prove truncation happens in the subject column",
      },
      {
        team: "beta",
        taskId: "9",
        status: "pending",
        owner: "oracle",
        files: 1,
        hasResult: false,
        subject: "Pending artifact",
      },
    ];

    let { writes, writer } = makeWriterSink();
    let result = await invoke(["ls", "alpha", "--json"], writer);
    expect(listCalls).toEqual([["alpha"]]);
    expect(result).toBeUndefined();
    expect(JSON.parse(writes.join("\n"))).toEqual(listReturn);

    ({ writes, writer } = makeWriterSink());
    result = await invoke(["list", "--team", "blue"], writer);
    expect(listCalls.at(-1)).toEqual(["blue"]);
    expect(result).toEqual({ ok: true, output: undefined });
    const rendered = writes.join("\n");
    expect(rendered).toContain("TEAM");
    expect(rendered).toContain("✓");
    expect(rendered).toContain("⚡");
    expect(rendered).toContain("pending");
    expect(rendered).toContain("Fix wake resolver coverage regressio");
  });

  test("get/show covers usage, missing, json, and rich rendered output", async () => {
    let { writes, writer } = makeWriterSink();
    let result = await invoke(["get"], writer);
    expect(result).toBeUndefined();
    expect(writes).toEqual(["usage: maw art get <team> <task-id>"]);

    ({ writes, writer } = makeWriterSink());
    result = await invoke(["show", "alpha", "7"], writer);
    expect(getCalls).toEqual([["alpha", "7"]]);
    expect(result).toBeUndefined();
    expect(writes).toEqual(["not found: alpha/7"]);

    getReturn = {
      meta: {
        subject: "Wake coverage batch",
        team: "alpha",
        taskId: "7",
        status: "completed",
        owner: "nat",
        commitHash: "abc1234",
      },
      spec: "spec details\n".repeat(4),
      result: "result details\n".repeat(4),
      attachments: ["proof.txt", "trace.log"],
      dir: "/tmp/artifacts/alpha/7",
    };

    ({ writes, writer } = makeWriterSink());
    result = await invoke(["get", "alpha", "7", "--json"], writer);
    expect(result).toBeUndefined();
    expect(JSON.parse(writes.join("\n"))).toEqual(getReturn);

    ({ writes, writer } = makeWriterSink());
    result = await invoke(["get", "alpha", "7"], writer);
    expect(result).toEqual({ ok: true, output: undefined });
    const rendered = writes.join("\n");
    expect(rendered).toContain("Wake coverage batch");
    expect(rendered).toContain("alpha/7 · completed · nat");
    expect(rendered).toContain("commit: abc1234");
    expect(rendered).toContain("─── spec ───");
    expect(rendered).toContain("─── result ───");
    expect(rendered).toContain("attachments (2)");
    expect(rendered).toContain("📎 proof.txt");
    expect(rendered).toContain("/tmp/artifacts/alpha/7");
  });

  test("write and attach cover usage plus success branches", async () => {
    let { writes, writer } = makeWriterSink();
    let result = await invoke(["write"], writer);
    expect(result).toBeUndefined();
    expect(writes).toEqual(["usage: maw art write <team> <task-id> <message...>"]);

    ({ writes, writer } = makeWriterSink());
    result = await invoke(["write", "alpha", "7", "done", "now"], writer);
    expect(writeCalls).toEqual([["alpha", "7", "done now"]]);
    expect(artifactDirCalls).toEqual([["alpha", "7"]]);
    expect(result).toEqual({ ok: true, output: undefined });
    expect(writes).toEqual(["\u001b[32m✓\u001b[0m result written → /tmp/artifacts/team-1/result.md"]);

    ({ writes, writer } = makeWriterSink());
    result = await invoke(["attach"], writer);
    expect(result).toBeUndefined();
    expect(writes).toEqual(["usage: maw art attach <team> <task-id> <file-path>"]);

    const proofPath = join(TMP_ROOT, "proof.txt");
    writeFileSync(proofPath, "proof payload");
    ({ writes, writer } = makeWriterSink());
    result = await invoke(["attach", "alpha", "7", proofPath], writer);
    expect(attachCalls).toEqual([["alpha", "7", "proof.txt", Buffer.from("proof payload")]]);
    expect(result).toEqual({ ok: true, output: undefined });
    expect(writes).toEqual(["\u001b[32m✓\u001b[0m attached → /tmp/artifacts/team-1/attachments/proof.txt"]);
  });

  test("init/create covers usage plus success branches", async () => {
    let { writes, writer } = makeWriterSink();
    let result = await invoke(["init"], writer);
    expect(result).toBeUndefined();
    expect(writes).toEqual(["usage: maw art init <team> <task-id> <subject> [description...]"]);

    ({ writes, writer } = makeWriterSink());
    result = await invoke(["create", "alpha", "7", "Subject", "with", "details"], writer);
    expect(createCalls).toEqual([["alpha", "7", "Subject", "with details"]]);
    expect(result).toEqual({ ok: true, output: undefined });
    expect(writes).toEqual(["\u001b[32m✓\u001b[0m artifact created → /tmp/artifacts/team-1"]);
  });

  test("unknown commands and thrown dispatcher errors surface cleanly", async () => {
    let result = await invoke(["bogus"]);
    expect(result).toEqual({ ok: true, output: "usage: maw art [ls|get|write|attach|init] [--json]" });

    throwLabel = "listArtifacts";
    result = await invoke(["ls"]);
    expect(result).toEqual({ ok: false, error: "list exploded", output: undefined });
  });
});
