/**
 * Consent stores — trust.json + consent-pending/<id>.json (#644 Phase 1).
 *
 * trust.json: long-lived, append-mostly. Atomic write via temp+rename.
 * consent-pending/: one file per request, lazy expiry on list.
 *
 * Paths are functions (not consts) so tests can override via env vars
 * (CONSENT_TRUST_FILE, CONSENT_PENDING_DIR) and get a fresh value each
 * call — same pattern as peers/store.ts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// --- Paths ---

export function trustPath(): string {
  return process.env.CONSENT_TRUST_FILE || join(homedir(), ".maw", "trust.json");
}

export function pendingDir(): string {
  return process.env.CONSENT_PENDING_DIR || join(homedir(), ".maw", "consent-pending");
}

// --- Types ---

export type ConsentAction = "hey" | "team-invite" | "plugin-install";
export type ConsentStatus = "pending" | "approved" | "rejected" | "expired";

export interface TrustEntry {
  from: string;
  to: string;
  action: ConsentAction;
  approvedAt: string;
  approvedBy: "human" | "auto";
  requestId: string | null;
}

export interface TrustFile {
  version: 1;
  trust: Record<string, TrustEntry>;
}

export interface PendingRequest {
  id: string;
  from: string;          // requesting node name
  to: string;            // target node name
  action: ConsentAction;
  summary: string;
  pinHash: string;       // sha256(pin) — never plaintext on disk
  createdAt: string;
  expiresAt: string;
  status: ConsentStatus;
}

// --- Trust file ---

function emptyTrust(): TrustFile { return { version: 1, trust: {} }; }

export function loadTrust(): TrustFile {
  const path = trustPath();
  if (!existsSync(path)) return emptyTrust();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<TrustFile>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyTrust();
    const trust = (parsed as { trust?: unknown }).trust;
    if (trust !== undefined && (typeof trust !== "object" || trust === null || Array.isArray(trust))) {
      return emptyTrust();
    }
    return { version: 1, trust: (trust ?? {}) as Record<string, TrustEntry> };
  } catch {
    return emptyTrust();
  }
}

export function trustKey(from: string, to: string, action: ConsentAction): string {
  return `${from}→${to}:${action}`;
}

export function saveTrust(data: TrustFile): void {
  const path = trustPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

export function recordTrust(entry: TrustEntry): void {
  const data = loadTrust();
  data.trust[trustKey(entry.from, entry.to, entry.action)] = entry;
  saveTrust(data);
}

export function removeTrust(from: string, to: string, action: ConsentAction): boolean {
  const data = loadTrust();
  const key = trustKey(from, to, action);
  if (!data.trust[key]) return false;
  delete data.trust[key];
  saveTrust(data);
  return true;
}

export function isTrusted(from: string, to: string, action: ConsentAction): boolean {
  return Boolean(loadTrust().trust[trustKey(from, to, action)]);
}

export function listTrust(): TrustEntry[] {
  return Object.values(loadTrust().trust).sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
}

// --- Pending requests ---

function pendingFile(id: string): string {
  return join(pendingDir(), `${id}.json`);
}

export function writePending(req: PendingRequest): void {
  mkdirSync(pendingDir(), { recursive: true });
  const path = pendingFile(req.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(req, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readPending(id: string): PendingRequest | null {
  const path = pendingFile(id);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PendingRequest;
    return applyExpiry(parsed);
  } catch {
    return null;
  }
}

export function listPending(): PendingRequest[] {
  const dir = pendingDir();
  if (!existsSync(dir)) return [];
  const out: PendingRequest[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf-8")) as PendingRequest;
      out.push(applyExpiry(parsed));
    } catch { /* skip junk */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateStatus(id: string, status: ConsentStatus): boolean {
  const req = readPending(id);
  if (!req) return false;
  req.status = status;
  writePending(req);
  return true;
}

export function deletePending(id: string): boolean {
  const path = pendingFile(id);
  if (!existsSync(path)) return false;
  try { unlinkSync(path); return true; } catch { return false; }
}

/** Pure helper — flips status to "expired" if past expiresAt and still pending. */
export function applyExpiry(req: PendingRequest, now: number = Date.now()): PendingRequest {
  if (req.status === "pending" && now > new Date(req.expiresAt).getTime()) {
    return { ...req, status: "expired" };
  }
  return req;
}
