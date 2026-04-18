/**
 * maw pair — CLI glue (#573). pairGenerate (recipient) + pairAccept (initiator).
 * HTTP server-to-server: initiator supplies the target URL explicitly.
 * Both paths end with cmdAdd() so peers.json has reciprocal aliases.
 */

import { loadConfig } from "../../../config";
import { cmdAdd } from "../peers/impl";
import { postHandshake, warnIfPlainHttp } from "./handshake";
import { normalize, isValidShape, redact } from "./codes";

export interface GenerateOpts { expiresSec?: number; pollIntervalMs?: number; localUrl?: string }
export interface GenerateResult { ok: boolean; code?: string; remoteNode?: string; error?: string }

function validateUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return `invalid URL "${raw}"`; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `invalid URL "${raw}" (must be http:// or https://)`;
  return null;
}

export async function pairGenerate(opts: GenerateOpts = {}): Promise<GenerateResult> {
  const port = loadConfig().port ?? 3456;
  const base = opts.localUrl ?? `http://localhost:${port}`;
  const ttlMs = (opts.expiresSec ?? 120) * 1000;
  let gen: Response;
  try {
    gen = await fetch(new URL("/api/pair/generate", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlMs }),
    });
  } catch (e: any) {
    return { ok: false, error: `cannot reach local server at ${base}: ${e?.message ?? "network_error"} (is 'maw serve' running?)` };
  }
  if (!gen.ok) return { ok: false, error: `generate failed: ${gen.status}` };
  const body = await gen.json() as { code: string; expiresAt: number };
  const code = body.code;
  const expiresSec = Math.ceil((body.expiresAt - Date.now()) / 1000);
  console.log(`🤝 pair code: ${code}  (expires ${expiresSec}s)`);
  console.log(`   listening on ${base}/api/pair/${normalize(code)}`);

  const interval = opts.pollIntervalMs ?? 1000;
  const deadline = body.expiresAt;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    const r = await fetch(new URL(`/api/pair/${normalize(code)}/status`, base)).catch(() => null);
    if (!r) continue;
    if (r.status === 410) return { ok: false, error: "code expired before acceptor arrived" };
    const s = await r.json().catch(() => ({})) as { consumed?: boolean; remoteNode?: string; remoteUrl?: string };
    if (s.consumed) {
      console.log(`✅ paired with ${s.remoteNode} at ${s.remoteUrl}`);
      console.log(`   added peer alias: ${s.remoteNode} → ${s.remoteUrl}`);
      return { ok: true, code, remoteNode: s.remoteNode };
    }
  }
  return { ok: false, error: "pair code expired — no acceptor" };
}

export interface AcceptOpts { localUrl?: string }

export async function pairAccept(url: string, rawCode: string, opts: AcceptOpts = {}): Promise<GenerateResult> {
  const urlErr = validateUrl(url);
  if (urlErr) return { ok: false, error: urlErr };
  if (!isValidShape(rawCode)) return { ok: false, error: `invalid code shape: ${redact(rawCode)}` };
  const code = normalize(rawCode);
  warnIfPlainHttp(url);

  const myPort = loadConfig().port ?? 3456;
  const myNode = loadConfig().node ?? "local";
  const myUrl = opts.localUrl ?? `http://localhost:${myPort}`;
  console.log(`🤝 posting to ${url}/api/pair/${code} ...`);
  const res = await postHandshake(url, code, { node: myNode, url: myUrl });
  if (!res.ok) {
    const hint = res.status === 410 ? " (code expired or already consumed)"
      : res.status === 404 ? " (code not found — check spelling or regenerate)"
      : res.status === 400 ? " (bad request — check code shape)"
      : res.status === 0   ? " (network unreachable — check URL + server running)"
      : "";
    return { ok: false, error: `handshake failed: ${res.error}${hint}` };
  }

  try {
    await cmdAdd({ alias: res.node, url: res.url || url, node: res.node });
    console.log(`✅ paired: ${res.node} ↔ ${myNode}`);
    console.log(`   added peer alias: ${res.node} → ${res.url || url}`);
  } catch (e: any) {
    return { ok: false, error: `paired but peer write failed: ${e?.message ?? "unknown"}` };
  }
  return { ok: true, code, remoteNode: res.node };
}
