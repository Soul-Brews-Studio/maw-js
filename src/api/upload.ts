import { Elysia } from "elysia";
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, basename, extname } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

const INBOX_DIR = join(homedir(), ".maw", "inbox");
const WEB_DIR = process.env.MAW_UPLOAD_WEB_DIR || "/var/www/maw-uploads";
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

/** Ensure inbox dir exists on first use */
function ensureInbox() {
  if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true });
  return INBOX_DIR;
}

/** Ensure dated web-served dir exists; returns { dir, dateSlug } */
function ensureWebDated() {
  const dateSlug = new Date().toISOString().slice(0, 10);
  const dir = join(WEB_DIR, dateSlug);
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

    // Primary: web-served path (nginx /maw-uploads/<date>/<id>.<ext>)
    const { dir: webDir, dateSlug } = ensureWebDated();
    const dest = join(webDir, filename);
    const buf = Buffer.from(await file.arrayBuffer());
    await Bun.write(dest, buf);

    // Mirror to ~/.maw/inbox for back-compat with /files listing
    const mirror = join(ensureInbox(), filename);
    await Bun.write(mirror, buf);

    const url = `/maw-uploads/${dateSlug}/${filename}`;
    const kb = (buf.length / 1024).toFixed(1);
    return { ok: true, id, url, path: dest, name: safeName, size: `${kb}KB`, mime };
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
