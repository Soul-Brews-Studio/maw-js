/**
 * hello-package — reference maw WASM plugin demonstrating all 3 surfaces.
 *
 * InvokeContext (JSON written to memory before handle() is called):
 *   { source: "cli" | "api" | "peer"; args: string[] | Record<string, unknown> }
 *
 * Dispatches on ctx.source to show surface-specific behaviour.
 * Build: pnpm asbuild:release  → build/release.wasm
 */

import { maw, readArgs } from "maw-plugin-sdk/assembly/index";

/** Extract the "source" field from the InvokeContext JSON. */
function parseSource(json: string): string {
  const needle = '"source":"';
  const idx = json.indexOf(needle);
  if (idx === -1) return "cli";
  const start = idx + needle.length;
  const end = json.indexOf('"', start);
  if (end === -1) return "cli";
  return json.slice(start, end);
}

/**
 * Entry point called by the maw runtime.
 * ptr/len point to a JSON-encoded InvokeContext.
 * Returns 0 for success.
 */
export function handle(ptr: i32, len: i32): i32 {
  const ctxJson =
    ptr === 0 || len === 0
      ? "{}"
      : String.UTF8.decodeUnsafe(ptr as usize, len as usize);

  const source = parseSource(ctxJson);

  if (source === "cli") {
    // CLI surface — print a human-readable greeting with node identity
    const id = maw.identity();
    maw.print("hello-package via CLI\n");
    maw.print("  node:    " + id.node + "\n");
    maw.print("  version: " + id.version + "\n");
    if (id.agents.length > 0) {
      maw.print("  agents:  " + id.agents.join(", ") + "\n");
    }
  } else if (source === "api") {
    // API surface — emit JSON suitable for an HTTP response body
    const id = maw.identity();
    maw.print(
      '{"plugin":"hello-package","surface":"api",' +
      '"node":"' + id.node + '",' +
      '"version":"' + id.version + '",' +
      '"message":"Hello from WASM API surface"}\n'
    );
  } else if (source === "peer") {
    // Peer surface — greet with federation context
    const id = maw.identity();
    const fed = maw.federation();
    maw.print("hello-package via peer from " + id.node + "\n");
    maw.print(
      "  peers: " +
      fed.reachablePeers.toString() + "/" +
      fed.totalPeers.toString() + " reachable\n"
    );
  } else {
    maw.print("hello-package: unknown surface '" + source + "'\n");
  }

  return 0;
}

/**
 * Re-export the allocator — the maw runtime calls maw_alloc(size) to write
 * return data (identity JSON, fetch results, etc.) into our linear memory.
 */
export function maw_alloc(size: i32): i32 {
  return heap.alloc(size as usize) as i32;
}
