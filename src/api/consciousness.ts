import { Hono } from "hono";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config";
import { loadFleetEntries } from "../commands/fleet-load";

export const consciousnessApi = new Hono();

interface OracleConsciousness {
  name: string;
  beliefs: string[];
  beliefCount: number;
  vision: string;
  goals: string;
  latestInsight: string | null;
  latestProposal: string | null;
  lastCycleAt: string | null;
  cycleCount: number;
}

function resolveOraclePath(name: string): string | null {
  const ghqRoot = loadConfig().ghqRoot;
  const path = join(ghqRoot, `${name}-oracle`);
  if (existsSync(path)) return path;
  // Fallback: check fleet config
  const entries = loadFleetEntries();
  for (const entry of entries) {
    if (entry.groupName === name && entry.session.windows.length > 0) {
      const repoPath = join(ghqRoot, entry.session.windows[0].repo);
      if (existsSync(repoPath)) return repoPath;
    }
  }
  return null;
}

function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, "utf-8").trim(); }
  catch { return fallback; }
}

function latestFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse();
    if (files.length === 0) return null;
    return readFileSync(join(dir, files[0]), "utf-8").trim();
  } catch { return null; }
}

function countJsonlLines(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).length;
  } catch { return 0; }
}

function lastJsonlEntry(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return last.ts || null;
  } catch { return null; }
}

function parseBeliefs(content: string): string[] {
  return content.split("\n")
    .filter(line => /^\d+\.\s+\*\*/.test(line))
    .map(line => {
      const match = line.match(/\*\*(.+?)\*\*/);
      return match ? match[1] : line.replace(/^\d+\.\s+/, "");
    });
}

function getOracleConsciousness(name: string): OracleConsciousness | null {
  const repoPath = resolveOraclePath(name);
  if (!repoPath) return null;

  const psi = join(repoPath, "ψ");
  if (!existsSync(psi)) return null;

  const beliefsRaw = readFileOr(join(psi, "memory/resonance/beliefs.md"), "");
  const beliefs = parseBeliefs(beliefsRaw);

  return {
    name,
    beliefs,
    beliefCount: beliefs.length,
    vision: readFileOr(join(psi, "memory/resonance/vision.md"), ""),
    goals: readFileOr(join(psi, "memory/resonance/goals.md"), ""),
    latestInsight: latestFile(join(psi, "memory/insights")),
    latestProposal: latestFile(join(psi, "outbox/proposals")),
    lastCycleAt: lastJsonlEntry(join(psi, "memory/logs/consciousness.jsonl")),
    cycleCount: countJsonlLines(join(psi, "memory/logs/consciousness.jsonl")),
  };
}

/** GET /api/consciousness — all oracles consciousness status */
consciousnessApi.get("/consciousness", (c) => {
  try {
    const entries = loadFleetEntries();
    const oracles: OracleConsciousness[] = [];

    for (const entry of entries) {
      const data = getOracleConsciousness(entry.groupName);
      if (data) oracles.push(data);
    }

    return c.json({ oracles });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/** GET /api/consciousness/:oracle — single oracle detail */
consciousnessApi.get("/consciousness/:oracle", (c) => {
  try {
    const name = c.req.param("oracle");
    const data = getOracleConsciousness(name);
    if (!data) return c.json({ error: `Oracle '${name}' not found` }, 404);
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
