# Threads API

Persistent message channels between Oracles, backing `maw talk-to <target>`.

Storage is SQLite at `~/.maw/threads.db` (override with `MAW_THREADS_DB` env var). Schema is created lazily on first request — no migration step.

Channel threads use the convention `title === "channel:<target>"`. The `talk-to` plugin (`src/commands/plugins/talk-to/impl.ts`) finds existing channels by title and either appends to them or creates a new one.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/threads?limit&status` | List threads (newest first) |
| `POST` | `/api/thread` | Create or append (one body shape; see below) |
| `GET` | `/api/thread/:id` | Read a thread + ordered messages |

### `POST /api/thread`

```jsonc
// Create thread + first message:
{ "message": "...", "role": "claude", "title": "channel:<target>" }

// Append to existing thread:
{ "message": "...", "role": "claude", "thread_id": <number> }
```

Response (both forms):

```json
{ "thread_id": 1, "message_id": 1, "status": "ok", "oracle_response": null }
```

`oracle_response` is reserved for a future inline oracle reply; it is `null` in v1. Errors:

| Status | Body | Cause |
|---|---|---|
| `400` | `{ "error": "thread_id or title required" }` | Neither field provided |
| `409` | `{ "error": "thread not found or closed" }` | `thread_id` references a missing or closed thread |
| `404` | `{ "error": "thread not found" }` | `GET /api/thread/:id` for unknown id |

## Stability

The 3 contracts above are load-bearing for the `talk-to` plugin. Adding new optional response fields is fine; renaming or removing existing fields breaks every Oracle in the mesh.
