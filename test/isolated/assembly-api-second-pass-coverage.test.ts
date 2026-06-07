import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const repoRoot = join(import.meta.dir, "../..");
const tmpRoot = join(repoRoot, ".tmp");
const apiImport = "../../src/wasm/maw-plugin-sdk-assemblyscript/assembly/api";

type HarnessExports = {
  memory: WebAssembly.Memory;
  testAlloc(size: number): number;
  testReadArgsSummary(ptr: number, len: number): number;
  testWriteResultEcho(ptr: number, len: number): number;
  testIdentitySummary(): number;
  testFederationSummary(): number;
  testZeroLengthHostCalls(): number;
  testUnicodeHostCalls(ptr: number, len: number): number;
  testAsyncResult(id: number): number;
};

type HostState = {
  printed: string[];
  printedErr: string[];
  logs: Array<{ level: number; message: string }>;
  sends: Array<{ target: string; message: string }>;
  fetches: string[];
  identityResponses: Array<string | null>;
  federationResponses: Array<string | null>;
};

let tmpDir = "";
let wasmPath = "";
let wasmModule: WebAssembly.Module;
let exportsRef: HarnessExports;
let hostState: HostState;

function compileHarness(): void {
  mkdirSync(tmpRoot, { recursive: true });
  tmpDir = mkdtempSync(join(tmpRoot, "maw-assembly-api-second-pass-"));
  const entryPath = join(tmpDir, "api-second-pass-harness.ts");
  wasmPath = join(tmpDir, "api-second-pass-harness.wasm");
  writeFileSync(entryPath, `
import { maw, readArgs, writeResult } from "${apiImport}";

export function testAlloc(size: i32): i32 {
  return maw.alloc(size as usize) as i32;
}

export function testReadArgsSummary(ptr: i32, len: i32): i32 {
  const args = readArgs(ptr, len);
  return writeResult(args.length.toString() + ":" + args.join("|"));
}

export function testWriteResultEcho(ptr: i32, len: i32): i32 {
  const s = String.UTF8.decodeUnsafe(ptr as usize, len as usize);
  return writeResult("echo:" + s);
}

export function testIdentitySummary(): i32 {
  const id = maw.identity();
  return writeResult(id.node + "|" + id.version + "|" + id.clockUtc + "|" + id.uptime.toString() + "|" + id.agents.length.toString() + "|" + id.agents.join(","));
}

export function testFederationSummary(): i32 {
  const fed = maw.federation();
  let out = fed.localUrl + "|" + fed.totalPeers.toString() + "|" + fed.reachablePeers.toString() + "|" + fed.peers.length.toString();
  for (let i = 0; i < fed.peers.length; i++) {
    const p = fed.peers[i];
    out += "|" + p.node + "," + p.url + "," + p.alive.toString() + "," + p.latencyMs.toString();
  }
  return writeResult(out);
}

export function testZeroLengthHostCalls(): i32 {
  maw.printErr("");
  maw.log(7, "");
  const sent = maw.send("", "");
  const fetchId = maw.fetch("");
  return writeResult((sent ? "sent" : "not-sent") + "|" + fetchId.toString());
}

export function testUnicodeHostCalls(ptr: i32, len: i32): i32 {
  const s = String.UTF8.decodeUnsafe(ptr as usize, len as usize);
  maw.print(s);
  maw.printErr(s);
  maw.log(8, s);
  const sent = maw.send(s, s + "!");
  const fetchId = maw.fetch(s);
  return writeResult((sent ? "sent" : "not-sent") + "|" + fetchId.toString());
}

export function testAsyncResult(id: i32): i32 {
  return writeResult(maw.asyncResult(id));
}
`);

  const childScript = `
const [entryPath, wasmPath] = process.argv.slice(1);
const r = Bun.spawnSync([
  "bunx",
  "--bun",
  "--package",
  "assemblyscript@0.27.35",
  "asc",
  entryPath,
  "--outFile",
  wasmPath,
  "--exportRuntime",
  "--runtime",
  "stub",
  "--optimizeLevel",
  "0",
  "--shrinkLevel",
  "0",
  "--debug",
], {
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MAW_TEST_MODE: "1" },
  stdout: "pipe",
  stderr: "pipe",
});
process.stdout.write(new TextDecoder().decode(r.stdout));
process.stderr.write(new TextDecoder().decode(r.stderr));
process.exit(r.success ? 0 : (r.exitCode ?? 1));
`;
  const result = spawnSync(process.execPath, ["-e", childScript, entryPath, wasmPath], {
    cwd: repoRoot,
    env: { ...process.env, MAW_TEST_MODE: "1" },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error([
      "AssemblyScript second-pass harness compile failed",
      JSON.stringify({ status: result.status, signal: result.signal, pid: result.pid, exec: process.execPath, entryPath, wasmPath, apiImport }),
      String(result.error ?? ""),
      result.stdout ?? "",
      result.stderr ?? "",
    ].join("\n"));
  }
  expect(existsSync(wasmPath)).toBe(true);
}

function freshHostState(): HostState {
  return {
    printed: [],
    printedErr: [],
    logs: [],
    sends: [],
    fetches: [],
    identityResponses: [],
    federationResponses: [],
  };
}

function readBytes(ptr: number, len: number): string {
  return new TextDecoder().decode(new Uint8Array(exportsRef.memory.buffer, ptr, len));
}

function writeRawString(s: string): { ptr: number; len: number } {
  const bytes = new TextEncoder().encode(s);
  const ptr = exportsRef.testAlloc(bytes.length);
  new Uint8Array(exportsRef.memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

function writeHostString(s: string): number {
  const bytes = new TextEncoder().encode(s);
  const ptr = exportsRef.testAlloc(bytes.length + 4);
  const view = new DataView(exportsRef.memory.buffer);
  view.setUint32(ptr, bytes.length, true);
  new Uint8Array(exportsRef.memory.buffer).set(bytes, ptr + 4);
  return ptr;
}

function readNullTerminated(ptr: number): string {
  const mem = new Uint8Array(exportsRef.memory.buffer);
  let end = ptr;
  while (end < mem.length && mem[end] !== 0) end++;
  return new TextDecoder().decode(mem.subarray(ptr, end));
}

async function instantiateHarness(): Promise<void> {
  hostState = freshHostState();
  const imports = {
    env: {
      abort: () => { throw new Error("AssemblyScript abort"); },
      maw_print: (ptr: number, len: number) => { hostState.printed.push(readBytes(ptr, len)); },
      maw_print_err: (ptr: number, len: number) => { hostState.printedErr.push(readBytes(ptr, len)); },
      maw_log: (level: number, ptr: number, len: number) => {
        hostState.logs.push({ level, message: readBytes(ptr, len) });
      },
      maw_identity: () => {
        const next = hostState.identityResponses.shift();
        return next == null ? 0 : writeHostString(next);
      },
      maw_federation: () => {
        const next = hostState.federationResponses.shift();
        return next == null ? 0 : writeHostString(next);
      },
      maw_send: (tPtr: number, tLen: number, mPtr: number, mLen: number) => {
        const target = readBytes(tPtr, tLen);
        const message = readBytes(mPtr, mLen);
        hostState.sends.push({ target, message });
        return target.length === 0 || message === `${target}!` ? 1 : 0;
      },
      maw_fetch: (urlPtr: number, urlLen: number) => {
        const url = readBytes(urlPtr, urlLen);
        hostState.fetches.push(url);
        return url.length === 0 ? 0 : 909;
      },
      maw_async_result: (id: number) => {
        if (id === 88) return writeHostString("");
        if (id === 89) return writeHostString("done-89");
        return 0;
      },
    },
  };
  const instance = await WebAssembly.instantiate(wasmModule, imports);
  exportsRef = instance.exports as unknown as HarnessExports;
}

beforeAll(() => {
  compileHarness();
  wasmModule = new WebAssembly.Module(readFileSync(wasmPath));
});

beforeEach(async () => {
  await instantiateHarness();
});

afterAll(() => {
  if (tmpDir && process.env.KEEP_ASSEMBLY_API_TMP !== "1") rmSync(tmpDir, { recursive: true, force: true });
});

describe("AssemblyScript maw api second-pass coverage harness", () => {
  test("keeps readArgs guarded for independently zero ptr or len and preserves multibyte writeResult data", () => {
    const ignored = writeRawString("not-json");
    expect(readNullTerminated(exportsRef.testReadArgsSummary(0, 9))).toBe("0:");
    expect(readNullTerminated(exportsRef.testReadArgsSummary(ignored.ptr, 0))).toBe("0:");

    const emptyArray = writeRawString("[]");
    expect(readNullTerminated(exportsRef.testReadArgsSummary(emptyArray.ptr, emptyArray.len))).toBe("0:");

    const unicode = writeRawString("naïve 🐈");
    expect(readNullTerminated(exportsRef.testWriteResultEcho(unicode.ptr, unicode.len))).toBe("echo:naïve 🐈");
  });

  test("returns safe default SDK models for null identity/federation pointers and empty host JSON arrays", () => {
    expect(readNullTerminated(exportsRef.testIdentitySummary())).toBe("|||0|0|");

    hostState.identityResponses.push('{"node":"solo","agents":[],"uptime":7}');
    expect(readNullTerminated(exportsRef.testIdentitySummary())).toBe("solo|||7|0|");

    expect(readNullTerminated(exportsRef.testFederationSummary())).toBe("|0|0|0");

    hostState.federationResponses.push('{"localUrl":"http://empty","totalPeers":0,"reachablePeers":0,"peers":[]}');
    expect(readNullTerminated(exportsRef.testFederationSummary())).toBe("http://empty|0|0|0");
  });

  test("parses multiple federation peers including false alive state and decimal latency", () => {
    hostState.federationResponses.push('{"localUrl":"http://local","totalPeers":2,"reachablePeers":1,"peers":[{"url":"http://slow","node":"slow","latencyMs":0,"alive":false},{"url":"http://fast","node":"fast","latencyMs":3.25,"alive":true}]}');

    expect(readNullTerminated(exportsRef.testFederationSummary())).toBe(
      "http://local|2|1|2|slow,http://slow,false,0.0|fast,http://fast,true,3.25",
    );
  });

  test("passes zero-length and multibyte strings through host wrappers with byte-accurate lengths", () => {
    expect(readNullTerminated(exportsRef.testZeroLengthHostCalls())).toBe("sent|0");
    expect(hostState.printedErr).toEqual([""]);
    expect(hostState.logs).toEqual([{ level: 7, message: "" }]);
    expect(hostState.sends).toEqual([{ target: "", message: "" }]);
    expect(hostState.fetches).toEqual([""]);

    const unicode = writeRawString("maw ☕️/猫");
    expect(readNullTerminated(exportsRef.testUnicodeHostCalls(unicode.ptr, unicode.len))).toBe("sent|909");

    expect(hostState.printed).toEqual(["maw ☕️/猫"]);
    expect(hostState.printedErr).toEqual(["", "maw ☕️/猫"]);
    expect(hostState.logs).toEqual([
      { level: 7, message: "" },
      { level: 8, message: "maw ☕️/猫" },
    ]);
    expect(hostState.sends).toEqual([
      { target: "", message: "" },
      { target: "maw ☕️/猫", message: "maw ☕️/猫!" },
    ]);
    expect(hostState.fetches).toEqual(["", "maw ☕️/猫"]);
  });

  test("distinguishes pending async result pointers from ready empty and ready non-empty payloads", () => {
    expect(readNullTerminated(exportsRef.testAsyncResult(0))).toBe("");
    expect(readNullTerminated(exportsRef.testAsyncResult(88))).toBe("");
    expect(readNullTerminated(exportsRef.testAsyncResult(89))).toBe("done-89");
  });
});
