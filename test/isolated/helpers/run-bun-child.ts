import { mkdtempSync, readFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

const CHILD_WRAPPER = `
const { writeFileSync } = await import("fs");
const decoder = new TextDecoder();
const resultFile = process.env.MAW_CHILD_RESULT_FILE;
const scriptB64 = process.env.MAW_CHILD_SCRIPT_B64 ?? "";
const stdout = [];
const stderr = [];
const push = (bucket, chunk) => {
  bucket.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
};
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);
const originalExit = process.exit.bind(process);
console.log = (...args) => { stdout.push(args.map(String).join(" ") + "\\n"); };
console.error = (...args) => { stderr.push(args.map(String).join(" ") + "\\n"); };
console.warn = (...args) => { stderr.push(args.map(String).join(" ") + "\\n"); };
process.stdout.write = (chunk) => { push(stdout, chunk); return true; };
process.stderr.write = (chunk) => { push(stderr, chunk); return true; };
class ExitSignal extends Error {
  constructor(code) {
    super("__exit__:" + code);
    this.code = code;
  }
}
let code = 0;
process.exit = (value) => { throw new ExitSignal(Number(value ?? 0)); };
try {
  await import("data:text/javascript;base64," + scriptB64);
} catch (error) {
  if (error instanceof ExitSignal) {
    code = error.code;
  } else {
    code = 1;
    stderr.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
} finally {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exit = originalExit;
  writeFileSync(resultFile, JSON.stringify({ code, stdout: stdout.join(""), stderr: stderr.join("") }));
}
`;

export function runBunChild(opts: {
  script: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): { code: number; stdout: string; stderr: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "maw-bun-child-"));
  const resultFile = join(tempDir, "result.json");
  const proc = spawnSync(process.execPath, ["-e", CHILD_WRAPPER], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...opts.env,
      MAW_CHILD_RESULT_FILE: resultFile,
      MAW_CHILD_SCRIPT_B64: Buffer.from(opts.script, "utf8").toString("base64"),
    },
  });

  try {
    return JSON.parse(readFileSync(resultFile, "utf8")) as {
      code: number;
      stdout: string;
      stderr: string;
    };
  } catch {
    return {
      code: proc.status ?? 1,
      stdout: proc.stdout ?? "",
      stderr: `${proc.stderr ?? ""}${proc.error ? `${proc.stderr ? "\n" : ""}${proc.error.message}` : ""}`,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
