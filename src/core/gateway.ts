import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { MawConfig } from "../config/types";
import { UserError } from "./util/user-error";
import type { StartServerOptions } from "./server";

export type GatewayKind = "bun" | "rust";

export type GatewayStartOptions = StartServerOptions & {
  gateway?: GatewayKind;
};

export type GatewaySelectionInput = {
  cliGateway?: string | null;
  env?: Pick<NodeJS.ProcessEnv, "MAW_GATEWAY">;
  config?: Partial<Pick<MawConfig, "gateway">> | null;
  log?: Pick<Console, "debug">;
};

export type Gateway = {
  readonly kind: GatewayKind;
  start(port: number, options?: GatewayStartOptions): Promise<unknown>;
};

const VALID_GATEWAYS = new Set<GatewayKind>(["bun", "rust"]);
const GATEWAY_LIST = "bun, rust";
const RUST_GATEWAY_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "MAW_GATEWAY_BIN",
  "PORT",
  "MAW_BACKEND_PORT",
  "MAW_HOME",
  "XDG_CONFIG_HOME",
] as const;

export function normalizeGateway(value: unknown, source = "gateway"): GatewayKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new UserError(`${source} must be one of: ${GATEWAY_LIST}`);
  const normalized = value.trim().toLowerCase();
  if (VALID_GATEWAYS.has(normalized as GatewayKind)) return normalized as GatewayKind;
  throw new UserError(`${source} must be one of: ${GATEWAY_LIST}`);
}

/**
 * Select the maw serve gateway. Precedence is intentionally explicit for #2566:
 * CLI flag > MAW_GATEWAY > config.gateway > bun default.
 */
export function selectGateway(input: GatewaySelectionInput = {}): Gateway {
  const selected = normalizeGateway(input.cliGateway, "--gateway")
    ?? normalizeGateway(input.env?.MAW_GATEWAY, "MAW_GATEWAY")
    ?? normalizeGateway(input.config?.gateway, "config.gateway")
    ?? "bun";

  if (selected !== "bun") {
    input.log?.debug(`[gateway] selected ${selected} gateway instead of default bun`);
  }

  if (selected === "rust") return new RustGateway();
  return new BunGateway();
}

class BunGateway implements Gateway {
  readonly kind = "bun" as const;

  async start(port: number, options: GatewayStartOptions = {}): Promise<unknown> {
    const { startBunGatewayServer } = await import("./server");
    return startBunGatewayServer(port, options);
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(binary: string, pathValue = process.env.PATH ?? ""): string | null {
  if (binary.includes("/") || binary.includes("\\") || isAbsolute(binary)) {
    return isExecutable(binary) ? binary : null;
  }
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveGatewayBinary(env: Pick<NodeJS.ProcessEnv, "MAW_GATEWAY_BIN" | "PATH"> = process.env): string | null {
  const configured = env.MAW_GATEWAY_BIN?.trim();
  if (configured) return findOnPath(configured, env.PATH);
  return findOnPath("maw-gateway", env.PATH);
}

function rustGatewayEnv(source: NodeJS.ProcessEnv, port: number, backendPort: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PORT: String(port), MAW_BACKEND_PORT: String(backendPort) };
  for (const key of RUST_GATEWAY_ENV_ALLOWLIST) {
    const value = key === "PORT"
      ? String(port)
      : key === "MAW_BACKEND_PORT"
        ? String(backendPort)
        : source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function stopGatewayHandle(handle: unknown): void {
  const stop = (handle as { stop?: (closeActiveConnections?: boolean) => unknown } | undefined)?.stop;
  if (typeof stop === "function") {
    try { stop.call(handle, true); } catch { /* best effort */ }
  }
}

async function cleanupGatewayPort(port: number): Promise<void> {
  try {
    execSync(`lsof -ti :${port} | xargs kill`, { stdio: "ignore" });
  } catch {
    // lsof exits non-zero when the port is free, or may be unavailable on a
    // minimal system. Either case should not block gateway startup.
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}

class RustGateway implements Gateway {
  readonly kind = "rust" as const;

  constructor(private readonly binary = resolveGatewayBinary()) {}

  async start(port: number, options: GatewayStartOptions = {}): Promise<ChildProcessWithoutNullStreams> {
    if (!this.binary) throw new UserError("maw-gateway binary not found");

    const backendPort = port + 1;
    await cleanupGatewayPort(port);
    await cleanupGatewayPort(backendPort);
    const backend = await new BunGateway().start(backendPort, { ...options, gateway: "bun" });
    const childArgs = ["serve", "--port", String(port), "--backend", String(backendPort)];
    if (typeof options.verbosity === "number") childArgs.push("--verbose", String(Math.max(0, Math.min(4, options.verbosity))));

    const child = spawn(this.binary, childArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: rustGatewayEnv(process.env, port, backendPort),
    });

    const readyNeedle = `listening on :${port}`;
    let stdout = "";
    let stderr = "";

    return await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new UserError(`maw-gateway did not report readiness on :${port}`));
      }, 5_000);

      const cleanupReadinessListeners = () => {
        clearTimeout(timeout);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("exit", onExitBeforeReady);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupReadinessListeners();
        if (!child.killed) child.kill();
        stopGatewayHandle(backend);
        reject(error);
      };
      const supervise = () => {
        child.stdout.on("data", (chunk) => process.stdout.write(chunk));
        child.stderr.on("data", (chunk) => process.stderr.write(chunk));
        child.on("exit", (code, signal) => {
          console.warn("[gateway:rust] process exited", { code, signal });
          stopGatewayHandle(backend);
        });
        process.once("exit", () => {
          if (!child.killed) child.kill();
          stopGatewayHandle(backend);
        });
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanupReadinessListeners();
        supervise();
        resolve(child);
      };
      const onStdout = (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes(readyNeedle)) succeed();
      };
      const onStderr = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      };
      const onError = (error: Error) => {
        fail(new UserError(`failed to start maw-gateway: ${error.message}`));
      };
      const onExitBeforeReady = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(new UserError(`maw-gateway exited before readiness (${signal ?? `code ${code ?? "unknown"}`})${stderr ? `: ${stderr.trim()}` : ""}`));
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("exit", onExitBeforeReady);
    });
  }
}
