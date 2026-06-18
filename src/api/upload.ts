import { Elysia } from "elysia";
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from "fs";
import { join, basename, extname } from "path";
import { randomUUID } from "crypto";
import { mawDataPath } from "../core/xdg";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
/** Extensions written by /upload — lets the reaper spot upload blobs in the shared
 * inbox without ever touching oracle data (.jsonl etc). */
const IMAGE_EXTS = new Set(Object.values(EXT_BY_MIME));

export function uploadInboxDir(): string {
  return mawDataPath("inbox");
}

function uploadWebDir(): string {
  return process.env.MAW_UPLOAD_WEB_DIR || "/var/www/maw-uploads";
}

/** Ensure inbox dir exists on first use */
function ensureInbox() {
  const inboxDir = uploadInboxDir();
  if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });
  return inboxDir;
}

/** Ensure dated web-served dir exists; returns { dir, dateSlug } */
function ensureWebDated() {
  const dateSlug = new Date().toISOString().slice(0, 10);
  const dir = join(uploadWebDir(), dateSlug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return { dir, dateSlug };
}

export const uploadApi = new Elysia();

/** POST /upload — accept a file via multipart form data */
uploadApi.post("/upload", async ({ body, set }) => {
  try {
    const file = (body as any)?.file;
    if (!file || !(file instanceof Blob)) {
      set.status = 400;
      return { error: "missing 'file' field — use: curl -F 'file=@image.png' /api/upload" };
    }

    const mime = (file as any).type || "";
    if (!ALLOWED_MIME.has(mime)) {
      set.status = 415;
      return { error: `unsupported mime: ${mime || "unknown"} — allowed: png, jpeg, webp, heic, heif` };
    }
    if (file.size > MAX_BYTES) {
      set.status = 413;
      return { error: `file too large: ${(file.size / 1024 / 1024).toFixed(1)}MB (max 10MB)` };
    }

    const id = randomUUID();
    const origName = (file as any).name || `upload-${Date.now()}`;
    const safeName = basename(origName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const ext = (EXT_BY_MIME[mime] || extname(safeName).replace(/^\./, "") || "bin").toLowerCase();
    const filename = `${id}.${ext}`;

    const buf = Buffer.from(await file.arrayBuffer());

    // Required: mirror to maw's XDG data inbox — this is what /api/files serves and
    // the portable cross-node reference (maw://<node>/<filename>).
    const mirror = join(ensureInbox(), filename);
    await Bun.write(mirror, buf);

    // Best-effort: also write the nginx web-served path. Nodes without a writable
    // web dir (e.g. laptops where /var/www is not writable) fall back cleanly to the
    // inbox mirror + /api/files instead of failing the whole upload.
    let url = `/api/files/${filename}`;
    let path = mirror;
    try {
      const { dir: webDir, dateSlug } = ensureWebDated();
      const dest = join(webDir, filename);
      await Bun.write(dest, buf);
      url = `/maw-uploads/${dateSlug}/${filename}`;
      path = dest;
    } catch { /* no writable web dir — inbox mirror + /api/files is the reference */ }

    const kb = (buf.length / 1024).toFixed(1);
    return { ok: true, id, url, path, name: safeName, size: `${kb}KB`, mime };
  } catch (e: any) {
    set.status = 500;
    return { error: e.message };
  }
});

/** GET /files — list inbox files */
uploadApi.get("/files", () => {
  const dir = ensureInbox();
  try {
    return readdirSync(dir).map((name) => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, modified: st.mtime.toISOString() };
    });
  } catch {
    return [];
  }
});

/** GET /files/:name — download a file */
uploadApi.get("/files/:name", ({ params, set }) => {
  const filePath = join(ensureInbox(), basename(params.name));
  if (!existsSync(filePath)) { set.status = 404; return { error: "not found" }; }
  return Bun.file(filePath);
});

/** DELETE /files/:name — remove a file (moves to /tmp) */
uploadApi.delete("/files/:name", ({ params, set }) => {
  const filePath = join(ensureInbox(), basename(params.name));
  if (!existsSync(filePath)) { set.status = 404; return { error: "not found" }; }
  const archive = `/tmp/maw-inbox-${basename(params.name)}-${Date.now()}`;
  Bun.write(archive, Bun.file(filePath));
  unlinkSync(filePath);
  return { ok: true, archived: archive };
});

/**
 * Reap upload blobs older than `ttlDays`. Safe by construction:
 *  - the web-served store is upload-only → any old file is removed and emptied
 *    dated dirs are pruned;
 *  - the inbox is shared with oracle data → ONLY image files are eligible, so
 *    `.jsonl` and other oracle files are never matched.
 * Best-effort: absent dirs and per-entry errors are ignored so a long-running
 * `maw serve` never crashes during GC. Returns counts removed per location.
 */
export function reapOldUploads(ttlDays = 7): { web: number; inbox: number } {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let web = 0;
  let inbox = 0;

  // Web-served store (upload-only): prune old files in dated dirs, then empty dirs.
  const webRoot = uploadWebDir();
  try {
    for (const dateDir of readdirSync(webRoot)) {
      const dirPath = join(webRoot, dateDir);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
        for (const f of readdirSync(dirPath)) {
          const fp = join(dirPath, f);
          try {
            if (statSync(fp).mtimeMs < cutoff) { unlinkSync(fp); web++; }
          } catch { /* skip unreadable entry */ }
        }
        try { if (readdirSync(dirPath).length === 0) rmdirSync(dirPath); } catch { /* keep non-empty */ }
      } catch { /* skip unreadable dated dir */ }
    }
  } catch { /* web dir absent — nothing to reap */ }

  // Inbox mirror (shared with oracle data): ONLY image blobs are eligible.
  try {
    const inboxRoot = uploadInboxDir();
    for (const f of readdirSync(inboxRoot)) {
      const ext = extname(f).replace(/^\./, "").toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      const fp = join(inboxRoot, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) { unlinkSync(fp); inbox++; }
      } catch { /* skip unreadable entry */ }
    }
  } catch { /* inbox absent — nothing to reap */ }

  return { web, inbox };
}
