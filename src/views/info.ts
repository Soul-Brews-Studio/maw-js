import { Hono } from "hono";
import { hostname } from "os";
import { readFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config";

export interface InfoResponse {
  node: string;
  version: string;
  ts: string;
  maw: true;
}

function readVersion(): string {
  try {
    const pkgPath = join(import.meta.dir, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

function readNode(): string {
  try {
    const cfg = loadConfig();
    if (typeof cfg.node === "string" && cfg.node) return cfg.node;
  } catch {}
  return hostname();
}

export function buildInfo(): InfoResponse {
  return {
    node: readNode(),
    version: readVersion(),
    ts: new Date().toISOString(),
    maw: true,
  };
}

export const infoView = new Hono();
infoView.get("/", (c) => c.json(buildInfo()));
