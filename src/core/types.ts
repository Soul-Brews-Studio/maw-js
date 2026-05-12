import type { ServerWebSocket } from "bun";

export type WSData = { target: string | null; previewTargets: Set<string>; mode?: "pty" };
export type MawWS = ServerWebSocket<WSData>;
export type Handler = (ws: MawWS, data: unknown, engine: MawEngine) => void | Promise<void>;

// Forward reference — resolved at runtime via engine.ts
import type { MawEngine } from "../engine";
