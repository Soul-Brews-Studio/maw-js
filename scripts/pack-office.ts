#!/usr/bin/env bun
/**
 * Pack dist-office/ into a single office.wasm binary
 *
 * Format: WASM module with embedded file system
 * - Exports: file_count() -> i32, get_file_name(idx, buf) -> len, get_file_data(idx, buf) -> len
 * - Memory contains all files as a virtual filesystem
 *
 * Simpler approach: pack as a tar-like binary with JSON manifest header
 * Format: [4 bytes manifest_len][JSON manifest][file1 bytes][file2 bytes]...
 *
 * The .wasm extension is conceptual — it's a portable binary artifact for the office.
 */

import { readdir, stat } from 'fs/promises';
import path from 'path';

const DIST_DIR = path.join(import.meta.dir, '..', 'dist-office');
const OUT_FILE = path.join(import.meta.dir, '..', 'office.wasm');

interface FileEntry {
  path: string;       // relative path (e.g. "index.html", "assets/index-xxx.js")
  offset: number;     // byte offset into data section
  size: number;       // file size
  mime: string;       // content-type
}

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

async function walk(dir: string, base: string = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      files.push(...await walk(path.join(dir, e.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

async function pack() {
  const files = await walk(DIST_DIR);
  console.log(`Packing ${files.length} files from dist-office/`);

  // Read all file contents
  const buffers: Buffer[] = [];
  const manifest: FileEntry[] = [];
  let offset = 0;

  for (const f of files) {
    const fullPath = path.join(DIST_DIR, f);
    const buf = Buffer.from(await Bun.file(fullPath).arrayBuffer());
    const ext = path.extname(f);
    manifest.push({
      path: f,
      offset,
      size: buf.length,
      mime: MIME_MAP[ext] || 'application/octet-stream',
    });
    buffers.push(buf);
    offset += buf.length;
    console.log(`  ${f} (${buf.length} bytes, ${MIME_MAP[ext] || 'binary'})`);
  }

  // Pack: magic + manifest_json_length(4 bytes) + manifest_json + all file data
  const magic = Buffer.from('OWSM'); // Oracle WASM
  const manifestJson = Buffer.from(JSON.stringify(manifest));
  const manifestLen = Buffer.alloc(4);
  manifestLen.writeUInt32LE(manifestJson.length);

  const totalData = Buffer.concat(buffers);
  const packed = Buffer.concat([magic, manifestLen, manifestJson, totalData]);

  await Bun.write(OUT_FILE, packed);
  console.log(`\n✓ office.wasm written (${(packed.length / 1024).toFixed(1)}KB, ${files.length} files)`);
}

pack();
