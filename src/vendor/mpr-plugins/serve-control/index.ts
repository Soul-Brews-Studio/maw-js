import { createHash, createHmac, timingSafeEqual } from "crypto";
import { loadConfig } from "maw-js/config";
import type { ServeHookContext } from "../../../core/serve-route-registry";
import { Tmux } from "../../../core/transport/tmux-class";
import { verifyShareControlToken } from "../share/impl";

const MAX_SEND_BYTES = 20_000;
const ALLOWED_KEYS = new Set(["Up", "Down", "Left", "Right", "Escape", "Enter", "C-c"]);
const CONTROL_WARNING = "[serve-control] RCE-equivalent pane control routes registered; verbs require share --control write token and scoped target allowlist";

type ControlBody = Record<string, unknown>;
type RouteParams = { target?: string; verb?: string };
type ControlRequest = {
  slug: string;
  target: string;
  token: string;
  body: ControlBody;
  rawBody: string;
};

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function parseRoute(pathname: string): RouteParams | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "api" || parts[1] !== "control") return null;
  return { target: decodeURIComponent(parts[2] ?? ""), verb: parts[3] };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function sanitizeLiteral(input: unknown): string {
  const text = typeof input === "string" ? input : String(input ?? "");
  const stripped = text.replace(/\0/g, "");
  const bytes = new TextEncoder().encode(stripped);
  if (bytes.byteLength <= MAX_SEND_BYTES) return stripped;
  return new TextDecoder().decode(bytes.slice(0, MAX_SEND_BYTES));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function signControlAction(token: string, method: string, path: string, rawBody: string): string {
  const bodyHash = sha256Hex(rawBody);
  return createHmac("sha256", token).update(`${method.toUpperCase()}\n${path}\n${bodyHash}`).digest("hex");
}

async function readJsonBody(req: Request): Promise<{ body: ControlBody; rawBody: string } | Response> {
  const rawBody = await req.text();
  if (!rawBody.trim()) return { body: {}, rawBody };
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(400, { error: "control_body_must_be_object" });
    return { body: parsed as ControlBody, rawBody };
  } catch {
    return json(400, { error: "control_body_invalid_json" });
  }
}

function extractToken(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-maw-control-token") || "";
}

function remoteControlAllowed(req: Request): Response | null {
  if (!req.headers.get("x-maw-signature")) return null;
  const cfg = loadConfig() as ReturnType<typeof loadConfig> & { control?: { allowRemote?: boolean } };
  if (cfg.control?.allowRemote === true) return null;
  return json(403, { error: "control_remote_disabled" });
}

async function authorize(req: Request): Promise<ControlRequest | Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const remoteBlocked = remoteControlAllowed(req);
  if (remoteBlocked) return remoteBlocked;
  const params = parseRoute(new URL(req.url).pathname);
  const target = params?.target ?? "";
  if (!target) return json(400, { error: "target_required" });
  const bodyRead = await readJsonBody(req);
  if (bodyRead instanceof Response) return bodyRead;
  const { body, rawBody } = bodyRead;
  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!slug) return json(400, { error: "share_slug_required" });
  const token = extractToken(req);
  const verified = verifyShareControlToken(slug, target, token);
  if (!verified.ok) return json(verified.status, { error: verified.reason });

  const signature = req.headers.get("x-maw-control-signature") || "";
  if (!signature) return json(401, { error: "control_signature_required" });
  const expected = signControlAction(token, req.method, new URL(req.url).pathname, rawBody);
  if (!safeEqualHex(signature, expected)) return json(401, { error: "invalid_control_signature" });
  return { slug, target, token, body, rawBody };
}

function tmuxFromBody(body: ControlBody): Tmux {
  const host = typeof body.host === "string" && body.host.trim() ? body.host : undefined;
  return new Tmux(host);
}

async function routeControl(req: Request): Promise<Response> {
  const params = parseRoute(new URL(req.url).pathname);
  const verb = params?.verb;
  if (!verb) return json(404, { error: "not_found" });
  const ctx = await authorize(req);
  if (ctx instanceof Response) return ctx;
  const tmux = tmuxFromBody(ctx.body);
  try {
    if (verb === "send") {
      const text = sanitizeLiteral(ctx.body.text);
      await tmux.sendKeysLiteral(ctx.target, text);
      return json(200, { ok: true, target: ctx.target, bytes: byteLength(text) });
    }
    if (verb === "key") {
      const key = typeof ctx.body.key === "string" ? ctx.body.key : "";
      if (!ALLOWED_KEYS.has(key)) return json(400, { error: "key_not_allowed" });
      await tmux.sendKeys(ctx.target, key);
      return json(200, { ok: true, target: ctx.target, key });
    }
    if (verb === "kill") {
      await tmux.killPane(ctx.target);
      return json(200, { ok: true, target: ctx.target });
    }
    if (verb === "resize") {
      const cols = Math.max(1, Math.min(1000, Math.floor(Number(ctx.body.cols))));
      const rows = Math.max(1, Math.min(1000, Math.floor(Number(ctx.body.rows))));
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return json(400, { error: "invalid_dimensions" });
      await tmux.resizePane(ctx.target, cols, rows);
      return json(200, { ok: true, target: ctx.target, cols, rows });
    }
    return json(404, { error: "unknown_control_verb" });
  } catch (error) {
    return json(500, { error: "control_tmux_failed", detail: error instanceof Error ? error.message : String(error) });
  }
}

export async function serve(ctx: ServeHookContext): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ctx.http) return { ok: false, error: "serve-control requires ctx.http" };
  (ctx as { log?: { warn?: (...args: unknown[]) => void } }).log?.warn?.(CONTROL_WARNING);
  ctx.http.route("POST", "/api/control/:target/send", routeControl);
  ctx.http.route("POST", "/api/control/:target/key", routeControl);
  ctx.http.route("POST", "/api/control/:target/kill", routeControl);
  ctx.http.route("POST", "/api/control/:target/resize", routeControl);
  return { ok: true };
}
