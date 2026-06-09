import type { MawConfig } from "../config/types";
import { UserError } from "./util/user-error";
import type { StartServerOptions } from "./server";

export type GatewayKind = "bun" | "rust" | "auto";

export type GatewayStartOptions = StartServerOptions & {
  gateway?: GatewayKind;
};

export type GatewaySelectionInput = {
  cliGateway?: string | null;
  env?: Pick<NodeJS.ProcessEnv, "MAW_GATEWAY">;
  config?: Partial<Pick<MawConfig, "gateway">> | null;
};

export type Gateway = {
  readonly kind: GatewayKind;
  start(port: number, options?: GatewayStartOptions): Promise<unknown>;
};

const VALID_GATEWAYS = new Set<GatewayKind>(["bun", "rust", "auto"]);

export function normalizeGateway(value: unknown, source = "gateway"): GatewayKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new UserError(`${source} must be one of: bun, rust, auto`);
  const normalized = value.trim().toLowerCase();
  if (VALID_GATEWAYS.has(normalized as GatewayKind)) return normalized as GatewayKind;
  throw new UserError(`${source} must be one of: bun, rust, auto`);
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

  if (selected === "rust") return new RustGateway();
  // auto remains conservative in Phase 2: preserve the existing Bun/Elysia path
  // until the external maw-gateway binary is production-ready.
  return new BunGateway(selected);
}

export class BunGateway implements Gateway {
  readonly kind: GatewayKind;

  constructor(kind: GatewayKind = "bun") {
    this.kind = kind;
  }

  async start(port: number, options: GatewayStartOptions = {}): Promise<unknown> {
    const { startBunGatewayServer } = await import("./server");
    return startBunGatewayServer(port, options);
  }
}

export class RustGateway implements Gateway {
  readonly kind = "rust" as const;

  constructor(private readonly binary = process.env.MAW_GATEWAY_BIN || "maw-gateway") {}

  async start(port: number, options: GatewayStartOptions = {}): Promise<unknown> {
    const verbosity = options.verbosity ?? 1;
    if (verbosity >= 1) {
      console.warn(
        `[gateway:rust] ${this.binary} stub selected for port ${port}; ` +
        `IPC contract register/request/response/ws-frame/ping/pong over /tmp/maw-${port}.sock or TCP is not wired yet; falling back to BunGateway.`,
      );
    }
    // Phase 2 intentionally preserves runtime behavior while creating the seam
    // where the future Rust gateway process will be spawned and supervised.
    return new BunGateway("bun").start(port, { ...options, gateway: "bun" });
  }
}
