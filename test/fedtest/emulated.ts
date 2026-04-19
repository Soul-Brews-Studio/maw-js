/**
 * fedtest — EmulatedBackend (#655 Phase 1 + Phase 2 mutation API).
 *
 * Spawns N `Bun.serve` instances on ephemeral ports. Each responds to:
 *   GET /info                         — real buildInfo() body w/ node overridden
 *   GET /api/plugin/list-manifest     — in-memory plugin list per peer
 *   GET /api/plugin/download/:name    — serves advertised tarball bytes
 *
 * Phase 2 mutations (installPlugin / setOffline / setSlow / spoofSha) are
 * implemented in-process by flipping per-peer state read by the handlers.
 * Offline is modeled by stopping the listener (connection refused), so
 * fetch failure shape matches a real down peer. Bringing a peer back
 * online rebinds the same port.
 */

import type {
  BaseFederationBackend,
  EmulatedPluginEntry,
  PeerHandle,
  SetUpOpts,
} from "./backend";
import { buildInfo } from "../../src/views/info";

type BunServer = { stop: (closeActive?: boolean) => void; port: number };

interface PeerState {
  node: string;
  port: number;
  server: BunServer | null;
  /** When non-null, every response waits this many ms before returning. */
  slowMs: number | null;
  plugins: Map<string, EmulatedPluginEntry>;
  /** sha256 overrides by plugin name — wins over entry.sha256 when set. */
  shaOverrides: Map<string, string | null>;
}

function startServer(state: PeerState): BunServer {
  return Bun.serve({
    port: state.port,
    hostname: "127.0.0.1",
    async fetch(req: Request) {
      if (state.slowMs != null && state.slowMs > 0) {
        await new Promise(r => setTimeout(r, state.slowMs!));
      }
      const u = new URL(req.url);

      if (u.pathname === "/info") {
        const body = { ...buildInfo(), node: state.node };
        return Response.json(body);
      }

      if (u.pathname === "/api/plugin/list-manifest") {
        const plugins = [...state.plugins.values()].map(e => {
          const override = state.shaOverrides.get(e.name);
          const sha = override !== undefined ? override : e.sha256 ?? null;
          const entry: Record<string, unknown> = {
            name: e.name,
            version: e.version,
            downloadUrl: `/api/plugin/download/${encodeURIComponent(e.name)}`,
          };
          if (e.summary) entry.summary = e.summary;
          if (e.author) entry.author = e.author;
          if (sha !== undefined) entry.sha256 = sha;
          return entry;
        });
        return Response.json({
          schemaVersion: 1,
          node: state.node,
          pluginCount: plugins.length,
          plugins,
        });
      }

      const downloadPrefix = "/api/plugin/download/";
      if (u.pathname.startsWith(downloadPrefix)) {
        const name = decodeURIComponent(u.pathname.slice(downloadPrefix.length));
        const entry = state.plugins.get(name);
        if (!entry) {
          return Response.json({ error: "plugin not installed", name }, { status: 404 });
        }
        if (!entry.tarball) {
          return Response.json(
            { error: "emulated peer has no tarball bytes for this plugin", name },
            { status: 404 },
          );
        }
        return new Response(entry.tarball, {
          status: 200,
          headers: {
            "Content-Type": "application/gzip",
            "Content-Disposition": `attachment; filename="${name}-${entry.version}.tgz"`,
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
}

class EmulatedPeerHandle implements PeerHandle {
  constructor(private readonly state: PeerState) {}
  get url(): string { return `http://127.0.0.1:${this.state.port}`; }
  get node(): string { return this.state.node; }

  async installPlugin(entry: EmulatedPluginEntry): Promise<void> {
    this.state.plugins.set(entry.name, entry);
  }

  async setOffline(offline: boolean): Promise<void> {
    if (offline) {
      if (this.state.server) {
        try { this.state.server.stop(true); } catch { /* idempotent */ }
        this.state.server = null;
      }
      return;
    }
    if (!this.state.server) {
      this.state.server = startServer(this.state);
      // rebind ephemeral port — real port may have moved. For the offline
      // scenario we restore the same port, so we tell Bun to bind the port
      // we remembered at first startup.
    }
  }

  async setSlow(delayMs: number | null): Promise<void> {
    this.state.slowMs = delayMs == null || delayMs <= 0 ? null : delayMs;
  }

  async spoofSha(pluginName: string, sha256: string | null): Promise<void> {
    this.state.shaOverrides.set(pluginName, sha256);
  }
}

export class EmulatedBackend implements BaseFederationBackend {
  readonly name = "emulated" as const;
  private states: PeerState[] = [];

  async setUp(opts: SetUpOpts): Promise<PeerHandle[]> {
    if (opts.peers < 1) throw new Error("peers must be >= 1");
    if (opts.ports && opts.ports.length !== opts.peers) {
      throw new Error(`ports.length (${opts.ports.length}) !== peers (${opts.peers})`);
    }

    const handles: PeerHandle[] = [];
    for (let i = 0; i < opts.peers; i++) {
      const node = `emu-node-${String.fromCharCode(97 + i)}`; // emu-node-a, -b, ...
      const state: PeerState = {
        node,
        port: opts.ports?.[i] ?? 0,
        server: null,
        slowMs: null,
        plugins: new Map(),
        shaOverrides: new Map(),
      };
      state.server = startServer(state);
      // Pin the resolved port so a later setOffline(false) rebinds the same
      // port — callers may have cached handle.url.
      state.port = state.server.port;
      this.states.push(state);
      handles.push(new EmulatedPeerHandle(state));
    }
    return handles;
  }

  async teardown(): Promise<void> {
    for (const s of this.states) {
      if (s.server) {
        try { s.server.stop(true); } catch { /* idempotent */ }
        s.server = null;
      }
    }
    this.states = [];
  }
}
