import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { loadConfig } from "maw-js/config";
import {
  formatZenohScoutResult,
  readZenohScoutConfig,
  runZenohScout,
  type ZenohScoutResult,
} from "./impl";

export const command = {
  name: "scout",
  description: "Opt-in Zenoh liveliness discovery provider for maw peers (#1455).",
};

function emit(ctx: InvokeContext, logs: string[], ...args: unknown[]): void {
  if (ctx.writer) ctx.writer(...args);
  else logs.push(args.map(String).join(" "));
}

function argsObject(ctx: InvokeContext): Record<string, unknown> {
  return ctx.source === "api" && ctx.args && !Array.isArray(ctx.args)
    ? ctx.args as Record<string, unknown>
    : {};
}

function cliArgs(ctx: InvokeContext): string[] {
  return ctx.source === "cli" && Array.isArray(ctx.args) ? ctx.args : [];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function choice(value: unknown): "zenoh" | "scout" | "both" | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "zenoh" || value === "scout" || value === "both") return value;
  return undefined;
}

function boolish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  }
  return undefined;
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult & Partial<ZenohScoutResult>> {
  const logs: string[] = [];
  const args = cliArgs(ctx);
  const query = argsObject(ctx);

  try {
    const config = loadConfig();
    const base = readZenohScoutConfig(config);
    const transportRaw = readOption(args, "--transport")
      ?? (typeof query.transport === "string" ? query.transport : undefined);
    const transport = choice(transportRaw) ?? "zenoh";
    if (transportRaw && !choice(transportRaw)) {
      return {
        ok: false,
        error: "invalid_transport",
        output: "usage: maw scout --transport zenoh|scout|both",
      };
    }

    const locator = readOption(args, "--locator")
      ?? (typeof query.locator === "string" ? query.locator : undefined)
      ?? base.locator;
    const timeoutRaw = readOption(args, "--timeout")
      ?? (typeof query.timeoutMs === "string" ? query.timeoutMs : undefined)
      ?? (typeof query.timeout === "string" ? query.timeout : undefined);
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : base.timeoutMs;
    const force = hasFlag(args, "--force") || boolish(query.force) === true;
    const json = hasFlag(args, "--json") || boolish(query.json) === true;
    const advertise = hasFlag(args, "--no-advertise")
      ? false
      : hasFlag(args, "--advertise")
        ? true
        : boolish(query.advertise) ?? true;

    if (transport === "scout") {
      const { fetchDiscoveries, formatDiscoveries } = await import("../peers/discovered");
      const result = await fetchDiscoveries({
        all: hasFlag(args, "--all") || boolish(query.all) === true,
        limit: Number(readOption(args, "--limit") ?? query.limit) || undefined,
      });
      emit(ctx, logs, json ? JSON.stringify(result, null, 2) : result.ok ? formatDiscoveries(result) : `${result.error}${result.hint ? ` — ${result.hint}` : ""}`);
      return { ok: result.ok, output: logs.join("\n") || undefined, ...(result.ok ? { total: result.total, peers: result.peers as any } : { error: result.error }) };
    }

    if (hasFlag(args, "--status")) {
      const result: ZenohScoutResult = {
        ok: true,
        enabled: base.enabled,
        locator,
        keyPrefix: base.keyPrefix,
        total: 0,
        peers: [],
        hint: base.enabled
          ? "zenoh-scout enabled; run `maw scout --force` to query now"
          : "zenoh-scout disabled; set zenoh.scout.enabled=true or pass --force for a one-shot query",
      };
      emit(ctx, logs, json ? JSON.stringify(result, null, 2) : formatZenohScoutResult(result));
      return { ...result, output: logs.join("\n") || undefined };
    }

    if (!base.enabled && !force) {
      const result: ZenohScoutResult = {
        ok: true,
        enabled: false,
        locator,
        keyPrefix: base.keyPrefix,
        total: 0,
        peers: [],
        hint: "zenoh-scout is opt-in; set zenoh.scout.enabled=true or pass --force for a one-shot query",
      };
      if (transport === "zenoh") {
        emit(ctx, logs, json ? JSON.stringify(result, null, 2) : formatZenohScoutResult(result));
        return { ...result, output: logs.join("\n") || undefined };
      }
    }

    const zenohResult = base.enabled || force
      ? await runZenohScout({
        ...base,
        enabled: true,
        locator,
        timeoutMs,
        advertise,
      })
      : {
        ok: true,
        enabled: false,
        locator,
        keyPrefix: base.keyPrefix,
        total: 0,
        peers: [],
        hint: "zenoh-scout is opt-in; set zenoh.scout.enabled=true or pass --force for a one-shot query",
      } satisfies ZenohScoutResult;

    if (transport === "both") {
      const { fetchDiscoveries, formatDiscoveries } = await import("../peers/discovered");
      const scoutResult = await fetchDiscoveries({
        all: hasFlag(args, "--all") || boolish(query.all) === true,
        limit: Number(readOption(args, "--limit") ?? query.limit) || undefined,
      });
      const zenohUsable = zenohResult.enabled ? zenohResult.ok : false;
      const ok = zenohUsable || scoutResult.ok;
      if (json) {
        emit(ctx, logs, JSON.stringify({ ok, zenoh: zenohResult, scout: scoutResult }, null, 2));
      } else {
        emit(ctx, logs, [
          "zenoh:",
          indent(formatZenohScoutResult(zenohResult)),
          "",
          "scout:",
          indent(scoutResult.ok ? formatDiscoveries(scoutResult) : `${scoutResult.error}${scoutResult.hint ? ` — ${scoutResult.hint}` : ""}`),
        ].join("\n"));
      }
      return {
        ok,
        error: ok ? undefined : "discovery_unavailable",
        output: logs.join("\n") || undefined,
      };
    }

    emit(ctx, logs, json ? JSON.stringify(zenohResult, null, 2) : formatZenohScoutResult(zenohResult));
    return { ...zenohResult, output: logs.join("\n") || undefined };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, output: logs.join("\n") || undefined };
  }
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}
