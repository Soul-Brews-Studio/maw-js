/**
 * maw pair — CLI glue (#573). pairGenerate (initiator) + pairAccept (acceptor).
 * Both paths end with cmdAdd() so peers.json has reciprocal aliases.
 */

import { loadConfig } from "../../../config";
import { cmdAdd } from "../peers/impl";
import { discover, fetchNodeName } from "./discovery";
import { postHandshake, warnIfPlainHttp } from "./handshake";
import { pretty, redact, normalize, isValidShape } from "./codes";

export interface GenerateOpts { expiresSec?: number; pollIntervalMs?: number; localUrl?: string }
export interface GenerateResult { ok: boolean; code?: string; remoteNode?: string; error?: string }

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
  console.log(`   listening for accept on ${base}/api/pair/${normalize(code)}`);

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

export interface AcceptOpts { at?: string; port?: number; localUrl?: string }

export async function pairAccept(rawCode: string, opts: AcceptOpts = {}): Promise<GenerateResult> {
  if (!isValidShape(rawCode)) return { ok: false, error: `invalid code shape: ${redact(rawCode)}` };
  const code = normalize(rawCode);
  console.log(`🔍 scanning LAN for ${pretty(code)}...`);
  const hit = await discover(code, { at: opts.at, port: opts.port });
  if (!hit) return { ok: false, error: `could not find oracle advertising ${redact(code)} — try --at <url>` };
  warnIfPlainHttp(hit.url);
  const remoteNode = await fetchNodeName(hit.url) ?? "unknown";
  console.log(`✅ found ${remoteNode} at ${hit.url}`);

  const myPort = loadConfig().port ?? 3456;
  const myNode = loadConfig().node ?? "local";
  const myUrl = opts.localUrl ?? `http://localhost:${myPort}`;
  const res = await postHandshake(hit.url, code, { node: myNode, url: myUrl });
  if (!res.ok) return { ok: false, error: `handshake failed: ${res.error} (status ${res.status})` };
  console.log(`🤝 handshake complete`);

  try {
    await cmdAdd({ alias: res.node || remoteNode, url: res.url || hit.url, node: res.node || remoteNode });
    console.log(`   added peer alias: ${res.node || remoteNode} → ${res.url || hit.url}`);
  } catch (e: any) {
    return { ok: false, error: `paired but peer write failed: ${e?.message ?? "unknown"}` };
  }
  return { ok: true, code, remoteNode: res.node };
}
