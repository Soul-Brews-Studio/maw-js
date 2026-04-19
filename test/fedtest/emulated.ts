/**
 * fedtest — EmulatedBackend (#655 Phase 1).
 *
 * Spawns N `Bun.serve` instances on ephemeral ports. Each responds to
 * GET /info with the real buildInfo() body so probePeer()'s handshake
 * contract stays in sync with production — only `node` is overridden
 * per peer.
 */

import type { BaseFederationBackend, PeerHandle, SetUpOpts } from "./backend";
import { buildInfo } from "../../src/views/info";

type EmuServer = { stop: (closeActive?: boolean) => void; port: number };

export class EmulatedBackend implements BaseFederationBackend {
  readonly name = "emulated" as const;
  private servers: EmuServer[] = [];

  async setUp(opts: SetUpOpts): Promise<PeerHandle[]> {
    if (opts.peers < 1) throw new Error("peers must be >= 1");
    if (opts.ports && opts.ports.length !== opts.peers) {
      throw new Error(`ports.length (${opts.ports.length}) !== peers (${opts.peers})`);
    }

    const handles: PeerHandle[] = [];
    for (let i = 0; i < opts.peers; i++) {
      const node = `emu-node-${String.fromCharCode(97 + i)}`; // emu-node-a, -b, ...
      const port = opts.ports?.[i] ?? 0;
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch(req: Request) {
          const u = new URL(req.url);
          if (u.pathname === "/info") {
            const body = { ...buildInfo(), node };
            return Response.json(body);
          }
          return new Response("not found", { status: 404 });
        },
      });
      this.servers.push(server);
      handles.push({ url: `http://127.0.0.1:${server.port}`, node });
    }
    return handles;
  }

  async teardown(): Promise<void> {
    for (const s of this.servers) {
      try { s.stop(true); } catch { /* idempotent */ }
    }
    this.servers = [];
  }
}
