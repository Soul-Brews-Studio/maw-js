import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

type ShareAuthKind = "token" | "federation" | "none";

export interface Share {
  target: string;
  panes: string[];
  readOnly: boolean;
  tokenHash: string;
  expiresAt: number;
  auth: ShareAuthKind;
}

export interface CreateShareOptions {
  target: string;
  panes?: string[];
  readOnly?: boolean;
  ttl?: number;
  auth?: ShareAuthKind;
}

export interface CreateShareResult {
  slug: string;
  token: string;
  url: string;
}

export interface ShareAuth {
  mint(share: Omit<Share, "tokenHash" | "expiresAt" | "auth">, slug: string): Promise<string> | string;
  verify(slug: string, presented: string): Promise<boolean> | boolean;
  kind: ShareAuthKind;
}

const DEFAULT_TTL_MS = 3_600_000;
const SWEEP_INTERVAL_MS = 10_000;

const shareRegistry = new Map<string, Share>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function makeSlug(): string {
  while (true) {
    const raw = randomUUID().replace(/-/g, "");
    const slug = BigInt(`0x${raw}`).toString(36).toLowerCase();
    if (slug.length >= 10) return slug;
    const padded = slug.padStart(10, "0");
    if (padded.length >= 10) return padded;
  }
}

function ensureTTL(ttl?: number): number {
  if (!Number.isFinite(ttl) || ttl === undefined) return DEFAULT_TTL_MS;
  return Math.max(0, ttl) * 1000;
}

function tokenAuthProvider(): ShareAuth {
  return {
    kind: "token",
    mint: () => randomBytes(24).toString("base64url"),
    verify: (slug, presented) => {
      const share = shareRegistry.get(slug);
      if (!share) return false;
      return hashesMatch(share.tokenHash, hashToken(presented));
    },
  };
}

function noneAuthProvider(): ShareAuth {
  const NONE_TOKEN = "";
  return {
    kind: "none",
    mint: () => NONE_TOKEN,
    verify: (slug, presented) => {
      return (presented === NONE_TOKEN) && shareRegistry.has(slug);
    },
  };
}

let federationAuth: (() => Promise<typeof import("../../../lib/federation-auth")>) | null = null;

function resolveFederationAuthModule(): Promise<typeof import("../../../lib/federation-auth")> {
  if (!federationAuth) {
    federationAuth = async () => await import("../../../lib/federation-auth");
  }
  return federationAuth();
}

let federationConfigModule: (() => Promise<typeof import("../../../config")>) | null = null;

function resolveConfigModule(): Promise<typeof import("../../../config")> {
  if (!federationConfigModule) {
    federationConfigModule = async () => await import("../../../config");
  }
  return federationConfigModule();
}

function federationAuthProvider(): Promise<ShareAuth> {
  return Promise.all([resolveFederationAuthModule(), resolveConfigModule()]).then(([federation, configModule]) => {
    const token = configModule.loadConfig()?.federationToken;
    if (!token) {
      throw new Error("federation auth requires federationToken");
    }
    return {
      kind: "federation",
      mint: (_share, slug) => {
        const ts = Math.floor(Date.now() / 1000);
        const signature = federation.sign(token, "GET", `/share/${slug}`, ts);
        return `${ts}.${signature}`;
      },
      verify: (slug, presented) => {
        const share = shareRegistry.get(slug);
        if (!share) return false;
        const parts = presented.split(".", 2);
        if (parts.length !== 2) return false;
        const ts = Number(parts[0]);
        const signature = parts[1];
        if (!Number.isFinite(ts)) return false;
        return federation.verify(token, "GET", `/share/${slug}`, ts, signature);
      },
    };
  });
}

async function resolveAuth(kind: ShareAuthKind): Promise<ShareAuth> {
  if (kind === "token") return tokenAuthProvider();
  if (kind === "none") return noneAuthProvider();
  return federationAuthProvider();
}

function purgeExpired(): number {
  const now = Date.now();
  let removed = 0;
  for (const [slug, share] of shareRegistry.entries()) {
    if (share.expiresAt <= now) {
      shareRegistry.delete(slug);
      removed += 1;
    }
  }
  return removed;
}

function ensureSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    purgeExpired();
  }, SWEEP_INTERVAL_MS);
}

export function stopShareSweepTimer(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

export async function createShare(opts: CreateShareOptions): Promise<CreateShareResult> {
  if (!opts.target?.trim()) throw new Error("share target is required");

  const target = opts.target;
  const panes = Array.isArray(opts.panes) ? opts.panes.slice() : [];
  const readOnly = opts.readOnly !== false;
  const auth: ShareAuthKind = opts.auth ?? "token";
  const expiresAt = Date.now() + ensureTTL(opts.ttl);

  const authHandler = await resolveAuth(auth);
  const slug = makeSlug();
  const share: Share = {
    target,
    panes,
    readOnly,
    tokenHash: "",
    expiresAt,
    auth,
  };
  const token = await authHandler.mint(share, slug);
  share.tokenHash = hashToken(token);

  shareRegistry.set(slug, share);
  ensureSweepTimer();

  return {
    slug,
    token,
    url: `/share/${slug}#${token}`,
  };
}

export function getShare(slug: string): Share | undefined {
  const share = shareRegistry.get(slug);
  if (!share) return undefined;
  if (share.expiresAt <= Date.now()) {
    shareRegistry.delete(slug);
    return undefined;
  }
  return share;
}

export async function verifyShare(slug: string, presented: string): Promise<boolean> {
  const share = getShare(slug);
  if (!share) return false;
  const provider = await resolveAuth(share.auth);
  const ok = await provider.verify(slug, presented);
  if (!ok) return false;
  const expectedHash = share.tokenHash;
  if (expectedHash.length === 0) return false;
  return hashesMatch(expectedHash, hashToken(presented));
}

export function revoke(slug: string): boolean {
  return shareRegistry.delete(slug);
}

export function sweepExpiredShares(): number {
  return purgeExpired();
}

export function clearShareRegistry(): void {
  shareRegistry.clear();
  stopShareSweepTimer();
}
