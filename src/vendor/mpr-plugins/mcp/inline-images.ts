/**
 * inline-images.ts — resolve `maw://<node>/<file>` image refs in markdown to
 * inline base64 data URIs.
 *
 * A caller on the mesh runs this so it can hand fully self-contained markdown to
 * a downstream consumer that must NOT reach into the oracle mesh itself (e.g. a
 * zone-isolated service). This module owns the `maw://` concept end-to-end and
 * knows nothing about any such consumer — it takes markdown and returns markdown.
 *
 * Security posture:
 *   - node allowlist: a ref's node must resolve to a CONFIGURED node (self or a
 *     namedPeers/peers entry). Unknown nodes are rejected — we never fetch an
 *     arbitrary host (anti-SSRF).
 *   - the filename segment is a single path component (the parse regex forbids
 *     `/`), so no path traversal; `/api/files` also basename()s defensively.
 *   - mime allowlist (png/jpg/gif/webp) by extension.
 *   - per-image AND total size caps.
 *   - FAIL-FAST: any ref that can't be fully resolved throws, naming the ref. A
 *     partially-resolved markdown (still containing `maw://`) is NEVER returned.
 */
import { loadConfig, type MawConfig } from "maw-js/sdk";

/** A `maw://…` token runs until the next markdown/HTML/quote delimiter. */
const MAW_REF_RE = /maw:\/\/[^\s)"'<>\]]+/g;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// Caps are aligned with (≤) the te-kb downstream so a ref that maw lets through
// can't then surprise-413 at the consumer — maw fails fast, te-kb stays a safety
// net. te-kb #18: per-image 5MB · total 25MB · ≤20 images. Both sides measure
// DECODED bytes, so the numbers line up exactly.
export const DEFAULT_PER_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB  (5_242_880)
export const DEFAULT_TOTAL_MAX_BYTES = 25 * 1024 * 1024; // 25MB (26_214_400)
export const DEFAULT_MAX_IMAGES = 20;

export interface FetchedImage {
  ok: boolean;
  status: number;
  bytes?: Uint8Array;
}

export interface InlineImagesDeps {
  /** Allowlist + URL map: bare node name → base URL, or null if not allowed (anti-SSRF). */
  resolveNodeBaseUrl: (node: string) => string | null;
  /** Fetch raw image bytes for a resolved `<base>/api/files/<file>` URL. */
  fetchImage: (url: string) => Promise<FetchedImage>;
  maxPerImageBytes?: number;
  maxTotalBytes?: number;
  maxImages?: number;
}

interface ParsedRef {
  node: string;
  filename: string;
  ext: string;
}

/** @internal exported for tests. Parse one `maw://<node>/<file>.<ext>` token. */
export function parseMawRef(token: string): ParsedRef | null {
  const m = /^maw:\/\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+\.([A-Za-z0-9]+))$/.exec(token);
  if (!m) return null;
  return { node: m[1], filename: m[2], ext: m[3].toLowerCase() };
}

/**
 * Replace every `maw://` image ref in `markdown` with a base64 data URI. Throws
 * (fail-fast, naming the offending ref) if any ref can't be fully resolved.
 */
export async function inlineImages(markdown: string, deps: InlineImagesDeps): Promise<string> {
  const maxPer = deps.maxPerImageBytes ?? DEFAULT_PER_IMAGE_MAX_BYTES;
  const maxTotal = deps.maxTotalBytes ?? DEFAULT_TOTAL_MAX_BYTES;
  const maxImages = deps.maxImages ?? DEFAULT_MAX_IMAGES;
  const tokens = [...new Set(markdown.match(MAW_REF_RE) ?? [])];
  if (tokens.length === 0) return markdown;
  if (tokens.length > maxImages) {
    throw new Error(`maw_inline_images: too many images (${tokens.length} distinct refs > cap ${maxImages})`);
  }

  let total = 0;
  const dataUriByToken = new Map<string, string>();

  for (const token of tokens) {
    const ref = parseMawRef(token);
    if (!ref) throw new Error(`maw_inline_images: malformed ref '${token}'`);

    const mime = MIME_BY_EXT[ref.ext];
    if (!mime) {
      throw new Error(
        `maw_inline_images: unsupported image type '.${ref.ext}' in ref '${token}' (allowed: png, jpg, gif, webp)`,
      );
    }

    const base = deps.resolveNodeBaseUrl(ref.node);
    if (!base) {
      throw new Error(`maw_inline_images: node '${ref.node}' not in allowlist — refusing to fetch ref '${token}'`);
    }

    const url = `${base.replace(/\/+$/, "")}/api/files/${ref.filename}`;
    let res: FetchedImage;
    try {
      res = await deps.fetchImage(url);
    } catch (e) {
      throw new Error(`maw_inline_images: fetch failed for ref '${token}': ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok || !res.bytes) {
      throw new Error(`maw_inline_images: ref '${token}' not retrievable (HTTP ${res.status})`);
    }

    const size = res.bytes.byteLength;
    if (size > maxPer) {
      throw new Error(`maw_inline_images: ref '${token}' too large (${size} bytes > per-image cap ${maxPer})`);
    }
    total += size;
    if (total > maxTotal) {
      throw new Error(`maw_inline_images: total image bytes exceeded cap ${maxTotal} (reached ${total} at ref '${token}')`);
    }

    dataUriByToken.set(token, `data:${mime};base64,${Buffer.from(res.bytes).toString("base64")}`);
  }

  let out = markdown;
  for (const [token, dataUri] of dataUriByToken) out = out.split(token).join(dataUri);

  // Invariant: no `maw://` may survive — this is the whole contract (callers may
  // hand the result to a mesh-isolated consumer). base64 can't contain "maw://"
  // (no colon in the base64 alphabet), so any hit is a genuine unresolved ref.
  if (out.includes("maw://")) {
    throw new Error("maw_inline_images: unresolved maw:// ref(s) remain after inlining");
  }
  return out;
}

/**
 * @internal exported for tests. Map a bare node name to its base URL using ONLY
 * configured nodes (self + namedPeers/peers). Returns null for anything else —
 * this IS the SSRF allowlist.
 */
export function resolveConfiguredNodeBaseUrl(node: string, config: MawConfig): string | null {
  const self = config.node ?? "local";
  if (node === self || node === "local") {
    return `http://127.0.0.1:${config.port ?? 3456}`;
  }
  const named = (config.namedPeers ?? []).find(
    (p) => p.name === node || p.node === node || p.identity?.node === node,
  );
  if (named?.url) return named.url;
  const legacy = (config.peers ?? []).find((u) => typeof u === "string" && u.includes(node));
  return legacy ?? null;
}

/** Production deps: node allowlist from config (self + peers), bytes via global fetch. */
export function defaultInlineImagesDeps(config: MawConfig = loadConfig()): InlineImagesDeps {
  return {
    resolveNodeBaseUrl: (node) => resolveConfiguredNodeBaseUrl(node, config),
    fetchImage: async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
