/**
 * FeedTailer — Tails ~/.oracle/feed.log using byte-offset polling.
 * Bun-specific (uses Bun.file, node:fs).
 */

import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { parseLine, activeOracles, type FeedEvent } from "./lib/feed";

const DEFAULT_PATH = join(process.env.HOME || "/home/nat", ".oracle", "feed.log");
const POLL_MS = 1000;
const DEFAULT_MAX_BUFFER = 200;

export class FeedTailer {
  private path: string;
  private maxBuffer: number;
  private offset = 0;
  private buffer: FeedEvent[] = [];
  private listeners = new Set<(event: FeedEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(path?: string, maxBuffer?: number) {
    this.path = path || DEFAULT_PATH;
    this.maxBuffer = maxBuffer || DEFAULT_MAX_BUFFER;
  }

  /** Start polling. Reads last N lines for initial buffer. */
  start(): void {
    if (this.timer) return;

    // Seed buffer from tail of file
    try {
      const file = Bun.file(this.path);
      const size = file.size;
      if (size > 0) {
        // Read last chunk (up to 100KB) for initial buffer
        const chunkSize = Math.min(size, 100_000);
        const fd = openSync(this.path, "r");
        const buf = Buffer.alloc(chunkSize);
        readSync(fd, buf, 0, chunkSize, size - chunkSize);
        closeSync(fd);

        const text = buf.toString("utf-8");
        const lines = text.split("\n").filter(Boolean);
        // Take last maxBuffer lines
        const tail = lines.slice(-this.maxBuffer);
        for (const line of tail) {
          const event = parseLine(line);
          if (event) this.buffer.push(event);
        }
        // Trim buffer
        if (this.buffer.length > this.maxBuffer) {
          this.buffer = this.buffer.slice(-this.maxBuffer);
        }
        this.offset = size;
      }
    } catch {
      // File doesn't exist yet — that's OK
      this.offset = 0;
    }

    // Start polling
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Subscribe to new events. Returns unsubscribe function. */
  onEvent(cb: (event: FeedEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Get recent events from buffer. */
  getRecent(n?: number): FeedEvent[] {
    const count = n || this.maxBuffer;
    return this.buffer.slice(-count);
  }

  /** Get active oracles within time window. */
  getActive(windowMs?: number): Map<string, FeedEvent> {
    return activeOracles(this.buffer, windowMs);
  }

  private poll(): void {
    try {
      const stat = statSync(this.path);
      const size = stat.size;

      // File rotated or truncated
      if (size < this.offset) {
        this.offset = 0;
      }

      // No new data
      if (size <= this.offset) return;

      // Read new bytes
      const newBytes = size - this.offset;
      const fd = openSync(this.path, "r");
      const buf = Buffer.alloc(newBytes);
      readSync(fd, buf, 0, newBytes, this.offset);
      closeSync(fd);

      this.offset = size;

      // Parse new lines
      const text = buf.toString("utf-8");
      const lines = text.split("\n").filter(Boolean);

      for (const line of lines) {
        const event = parseLine(line);
        if (!event) continue;

        this.buffer.push(event);
        // Emit to listeners
        for (const cb of this.listeners) {
          try {
            cb(event);
          } catch {}
        }
      }

      // Trim buffer
      if (this.buffer.length > this.maxBuffer) {
        this.buffer = this.buffer.slice(-this.maxBuffer);
      }
    } catch {
      // File might not exist or be temporarily unavailable
    }
  }
}
