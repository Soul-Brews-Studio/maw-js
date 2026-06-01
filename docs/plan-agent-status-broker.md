# Agent Status & Message Broker — Design Doc

## Problem

1. **No status awareness** — agents inject prompts into busy oracles, corrupting context
2. **No communication standard** — ad-hoc `maw hey` with no delivery guarantees
3. **Handoffs stall** — messages sit in inbox with no dispatch
4. **Token waste** — polling inbox burns tokens; need push-based delivery
5. **No request-reply** — external clients (OpenCode) can't get results back

## Architecture

```
Claude Code hooks ──POST──▶ /api/status ──▶ AgentStatusStore (in-memory)
                                                   │
Feed events ───listener───────────────────────────▶│
                                                   │
StatusDetector (tmux polling) ──fallback──────────▶│
                                                   │
GET /api/status ◀──────────────────────────────────┘
GET /api/status/:oracle ◀──────────────────────────┘
```

## Key Design Decisions

- **In-memory store** — server restart = reset = safe (no stale state)
- **TTL timeout 120s** — no "response complete" hook in Claude Code, so busy→idle via TTL
- **Feed-derived status** — existing hooks (SessionStart/UserPromptSubmit/Stop) auto-update store
- **Built into maw server** — no external broker (RabbitMQ etc.) — scale is 8-10 agents on 1 machine

## Phases

### Phase 1: Status API + Claude Code hooks ✅
- `AgentStatusStore` in-memory store with TTL-based idle detection
- `POST /api/status` — direct status report from hooks
- `GET /api/status` — all agents with summary counts
- `GET /api/status/:oracle` — single agent status
- Feed listener auto-derives status from existing hook events

### Phase 2: hey/talk-to guard ✅
- `checkBusyGuard()` helper extracts oracle name from target strings
- `cmdSend()` — queues to inbox when target is busy
- `/api/send` — queues via `queueOrFail()` when target is busy
- `talk-to` — skips pane injection, saves to thread only when busy
- Unknown agents (no status data) are allowed through

### Phase 3: Message Queue + Dispatch Engine ✅
- `MessageQueue` in-memory queue with status tracking (pending/delivering/delivered/failed)
- `DispatchEngine` listens to status transitions (busy→ready/idle) and auto-delivers
- `AgentStatusStore.onChange()` callback for status transition events
- Busy guard now enqueues for auto-delivery (not just inbox write)
- Queue API: `GET /api/queue`, `GET /api/queue/:oracle`
- Engine started at server boot in `server.ts`
- Delivery receipts via feed events (MessageSend lifecycle)

### Phase 4: Communication Convention ✅
- `docs/communication-convention.md` — protocol spec (channels, status-aware delivery, message format)
- SessionStart feed event now explicitly marks agent as busy in AgentStatusStore
- Trigger listener integration ensures status store is synchronized with session lifecycle

### Phase 5: Request-Reply + External Client Integration ✅
- `RequestReplyStore` with correlationId-based tracking
- `POST /api/request` — submit request, get correlationId
- `GET /api/request/:correlationId` — poll for reply
- `POST /api/reply/:correlationId` — oracle submits reply
- `GET /api/requests` — list all requests (filterable by oracle/status)
- Push-based callback via `callbackUrl` option
- Auto-queues to MessageQueue when target is busy
- Feed events for request/reply lifecycle

## Status State Machine

```
SessionStart ──▶ busy
UserPromptSubmit ──▶ busy
PreToolUse ──▶ busy
Stop ──▶ ready
SessionEnd ──▶ idle
120s no activity ──▶ idle (TTL)
shell + was running ──▶ crashed (StatusDetector)
```

## API Reference

### POST /api/status
```json
{ "oracle": "neo", "status": "busy", "sessionId": "...", "project": "...", "event": "SessionStart" }
```

### GET /api/status
```json
{
  "agents": [
    { "oracle": "neo", "status": "busy", "updatedAt": 1717200000000, "sessionId": "...", "project": "...", "lastEvent": "PreToolUse" }
  ],
  "summary": { "busy": 3, "ready": 2, "idle": 1 },
  "total": 6
}
```

### GET /api/status/:oracle
```json
{ "oracle": "neo", "status": "busy", "updatedAt": 1717200000000, "sessionId": "...", "project": "...", "lastEvent": "PreToolUse" }
```
