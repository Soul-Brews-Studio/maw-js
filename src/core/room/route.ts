/**
 * Brainstorm Room — core wire (kobo-245, slice 1).
 *
 * A "room" is NOT new infra: it's a `[room:<id>]` tag riding the EXISTING hey
 * transport. The web input box POSTs here; we deliver the message to the lead pane
 * with `maw hey` — the same primitive every oracle uses. That hey emits a
 * `MessageSend` feed event (buildMessageLifecycleFeedEvent), so the message shows up
 * on the public `/api/feed` with NO extra write. The lead replies with its own
 * `[room:<id>]`-tagged hey → another feed event → the web renders both sides by
 * filtering `/api/feed` on the room tag. Round-trip = hey + feed, zero new transport.
 *
 * Out of scope (later slices): thread persistence (2), attribution (3), merge (4),
 * distill-to-card (5). This is only the wire.
 */

/** The tag that scopes a message to a room (both directions carry it). */
export function roomTag(room: string): string {
  return `[room:${room}]`;
}

/** True when a feed message/text belongs to this room (client + server share this). */
export function messageInRoom(text: string | undefined, room: string): boolean {
  return !!text && text.includes(roomTag(room));
}

/** The `maw hey` argv that delivers a room message to the lead (reuses hey 100%). */
export function roomSendArgs(room: string, to: string, text: string): string[] {
  return ["hey", to, `${roomTag(room)} ${text}`];
}

export type SpawnFn = (argv: string[]) => { exited: Promise<number> };

const defaultSpawn: SpawnFn = (argv) => Bun.spawn(["maw", ...argv], { stdout: "ignore", stderr: "ignore" });

/**
 * POST /api/room/send — body { room, to, text } → deliver via `maw hey` (spawns the
 * CLI, the SAME path a human `maw hey` takes: delivery + the MessageSend feed event).
 * Returns { ok:true } once spawned; the reply arrives asynchronously via the feed.
 * `spawn` is injectable so the argv wiring is unit-testable without a subprocess.
 */
export async function handleRoomSendRequest(request: Request, spawn: SpawnFn = defaultSpawn): Promise<Response> {
  let body: { room?: unknown; to?: unknown; text?: unknown };
  try {
    body = (await request.json()) as { room?: unknown; to?: unknown; text?: unknown };
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const room = typeof body.room === "string" ? body.room.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!room || !to || !text) {
    return Response.json({ ok: false, error: "room, to and text are required" }, { status: 400 });
  }
  try {
    const proc = spawn(roomSendArgs(room, to, text));
    // Best-effort: don't block the response on delivery (hey queues + the dispatch
    // engine delivers when the lead pane is idle — kobo-240 spike). Fire and return.
    void proc.exited;
    return Response.json({ ok: true, room, to });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "send failed" }, { status: 500 });
  }
}
