import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

const repoRoot = join(import.meta.dir, "../..");
const tmpRoot = join(repoRoot, ".tmp");
const apiImport = "../../src/wasm/maw-plugin-sdk-assemblyscript/assembly/api";

type HarnessExports = {
  memory: WebAssembly.Memory;
  testAlloc(size: number): number;
  testReadArgs(ptr: number, len: number): number;
  testIdentity(): number;
  testFederation(): number;
  testSend(targetPtr: number, targetLen: number, msgPtr: number, msgLen: number): number;
  testFetch(urlPtr: number, urlLen: number): number;
  testAsyncResult(id: number): number;
  testOutput(): void;
};

let tmpDir = "";
let wasmPath = "";
let exportsRef: HarnessExports;
const printed: string[] = [];
const printedErr: string[] = [];
const logs: Array<{ level: number; message: string }> = [];
const sends: Array<{ target: string; message: string }> = [];
const fetches: string[] = [];

function compileHarness(): void {
  mkdirSync(tmpRoot, { recursive: true });
  tmpDir = mkdtempSync(join(tmpRoot, "assembly-api-harness-"));
  const entryPath = join(tmpDir, "api-harness.ts");
  wasmPath = join(tmpDir, "api-harness.wasm");
  writeFileSync(entryPath, `
import { maw, readArgs, writeResult } from "${apiImport}";

export function testAlloc(size: i32): i32 {
  return maw.alloc(size as usize) as i32;
}

export function testReadArgs(ptr: i32, len: i32): i32 {
  const args = readArgs(ptr, len);
  if (args.length == 0) return writeResult("empty");
  return writeResult(args.join("|"));
}

export function testIdentity(): i32 {
  const id = maw.identity();
  return writeResult(id.node + "|" + id.version + "|" + id.clockUtc + "|" + id.uptime.toString() + "|" + id.agents.join(","));
}

export function testFederation(): i32 {
  const fed = maw.federation();
  const first = fed.peers.length > 0 ? fed.peers[0].node + ":" + fed.peers[0].alive.toString() + ":" + fed.peers[0].latencyMs.toString() : "none";
  return writeResult(fed.localUrl + "|" + fed.totalPeers.toString() + "|" + fed.reachablePeers.toString() + "|" + first);
}

export function testSend(targetPtr: i32, targetLen: i32, msgPtr: i32, msgLen: i32): i32 {
  const target = String.UTF8.decodeUnsafe(targetPtr as usize, targetLen as usize);
  const msg = String.UTF8.decodeUnsafe(msgPtr as usize, msgLen as usize);
  return maw.send(target, msg) ? 1 : 0;
}

export function testFetch(urlPtr: i32, urlLen: i32): i32 {
  const url = String.UTF8.decodeUnsafe(urlPtr as usize, urlLen as usize);
  return maw.fetch(url);
}

export function testAsyncResult(id: i32): i32 {
  return writeResult(maw.asyncResult(id));
}

export function testOutput(): void {
  maw.print("");
  maw.print("hello stdout");
  maw.printErr("hello stderr");
  maw.debug("debug log");
  maw.info("info log");
  maw.warn("warn log");
  maw.error("error log");
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
      "AssemblyScript harness compile failed",
      JSON.stringify({ status: result.status, signal: result.signal, pid: result.pid, exec: process.execPath, entryPath, wasmPath }),
      String(result.error ?? ""),
      result.stdout ?? "",
      result.stderr ?? "",
    ].join("\n"));
  }
  expect(existsSync(wasmPath)).toBe(true);
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
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  let instance: WebAssembly.Instance;
  const imports = {
    env: {
      abort: () => { throw new Error("AssemblyScript abort"); },
      maw_print: (ptr: number, len: number) => { printed.push(readBytes(ptr, len)); },
      maw_print_err: (ptr: number, len: number) => { printedErr.push(readBytes(ptr, len)); },
      maw_log: (level: number, ptr: number, len: number) => { logs.push({ level, message: readBytes(ptr, len) }); },
      maw_identity: () => writeHostString('{"node":"test-node","version":"1.2.3","agents":["alpha","beta"],"clockUtc":"2026-05-18T00:00:00Z","uptime":42}'),
      maw_federation: () => writeHostString('{"localUrl":"http://local","totalPeers":2,"reachablePeers":1,"peers":[{"url":"http://peer","node":"peer-a","latencyMs":12.5,"alive":true}]}'),
      maw_send: (tPtr: number, tLen: number, mPtr: number, mLen: number) => {
        const target = readBytes(tPtr, tLen);
        const message = readBytes(mPtr, mLen);
        sends.push({ target, message });
        return target === "alpha" ? 1 : 0;
      },
      maw_fetch: (urlPtr: number, urlLen: number) => {
        fetches.push(readBytes(urlPtr, urlLen));
        return 77;
      },
      maw_async_result: (id: number) => id === 0 ? 0 : writeHostString(`ready:${id}`),
    },
  };
  instance = await WebAssembly.instantiate(module, imports);
  exportsRef = instance.exports as unknown as HarnessExports;
}

beforeAll(async () => {
  compileHarness();
  await instantiateHarness();
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("AssemblyScript maw api first-pass coverage harness", () => {
  test("compiles api.ts into a deterministic wasm harness and exercises readArgs branches", () => {
    expect(readNullTerminated(exportsRef.testReadArgs(0, 0))).toBe("empty");

    const args = writeRawString('["one","two"]');
    expect(readNullTerminated(exportsRef.testReadArgs(args.ptr, args.len))).toBe("one|two");
  });

  test("parses identity and federation host JSON through the high-level SDK classes", () => {
    expect(readNullTerminated(exportsRef.testIdentity())).toBe("test-node|1.2.3|2026-05-18T00:00:00Z|42|alpha,beta");
    expect(readNullTerminated(exportsRef.testFederation())).toBe("http://local|2|1|peer-a:true:12.5");
  });

  test("covers host-call wrappers for send, fetch, async pending/ready, and output logging", () => {
    const alpha = writeRawString("alpha");
    const beta = writeRawString("beta");
    const message = writeRawString("hello from wasm");
    const url = writeRawString("https://example.test/data");

    expect(exportsRef.testSend(alpha.ptr, alpha.len, message.ptr, message.len)).toBe(1);
    expect(exportsRef.testSend(beta.ptr, beta.len, message.ptr, message.len)).toBe(0);
    expect(exportsRef.testFetch(url.ptr, url.len)).toBe(77);
    expect(readNullTerminated(exportsRef.testAsyncResult(0))).toBe("");
    expect(readNullTerminated(exportsRef.testAsyncResult(77))).toBe("ready:77");

    exportsRef.testOutput();

    expect(sends).toEqual([
      { target: "alpha", message: "hello from wasm" },
      { target: "beta", message: "hello from wasm" },
    ]);
    expect(fetches).toEqual(["https://example.test/data"]);
    expect(printed).toEqual(["", "hello stdout"]);
    expect(printedErr).toEqual(["hello stderr"]);
    expect(logs).toEqual([
      { level: 0, message: "debug log" },
      { level: 1, message: "info log" },
      { level: 2, message: "warn log" },
      { level: 3, message: "error log" },
    ]);
  });
});
