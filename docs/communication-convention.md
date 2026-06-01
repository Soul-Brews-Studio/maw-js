# Communication Convention

Protocol for oracle-to-oracle and oracle-to-external communication in maw.

## Channels

| Channel | Command | When to use | Delivery |
|---------|---------|-------------|----------|
| **hey** | `maw hey <target> "msg"` | Quick, direct messages | tmux inject (local) or federation HTTP (remote) |
| **talk-to** | `maw talk-to <target> "msg"` | Persistent conversations | Thread (MCP) + tmux inject |
| **inbox** | `maw hey --inbox <target> "msg"` | Async messages | File-based (`ψ/inbox/`), no pane injection |
| **team** | `maw hey team:<name> "msg"` | Fan-out to team members | Individual delivery to each member |

## Status-Aware Delivery

Messages respect the target's status:

| Target Status | Behavior |
|---------------|----------|
| **ready** | Direct injection via `sendKeys` |
| **idle** | Direct injection via `sendKeys` |
| **busy** | Queued for auto-delivery when idle |
| **crashed** | Queued to inbox |
| **unknown** | Direct injection (no guard) |

## Message Format

Messages between oracles use body-level signing:

```
[node:sender] message content here
```

- Slash commands (`/skill`, `$cmd`) are NOT signed (preserved as-is)
- Already-signed messages are passed through unchanged

## Queue Auto-Delivery

When a busy agent transitions to ready/idle:
1. DispatchEngine picks the oldest pending message
2. Delivers one message per transition (no flooding)
3. Emits `MessageDeliver` feed event on success
4. Emits `MessageFail` on delivery error

## API Endpoints

### Status & Queue

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/status` | GET | All agent statuses + summary |
| `/api/status/:oracle` | GET | Single agent status + pending count |
| `/api/status` | POST | Report status change (from hooks) |
| `/api/queue` | GET | All queued messages |
| `/api/queue/:oracle` | GET | Pending messages for oracle |

### Request-Reply (External Clients)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/request` | POST | Submit request → get correlationId |
| `/api/request/:correlationId` | GET | Poll for reply |
| `/api/reply/:correlationId` | POST | Oracle submits reply |
| `/api/requests` | GET | List all requests (?oracle=&status=) |

### Request-Reply Flow

```
External Client                    maw server                    Oracle Agent
      │                                │                              │
      ├── POST /api/request ──────────▶│                              │
      │   { to: "neo", message: "?" }  │                              │
      │◀── { correlationId: "req-1" }──┤                              │
      │                                ├── sendKeys(target, msg) ────▶│
      │                                │                              │
      │   (poll)                       │                              │
      ├── GET /api/request/req-1 ─────▶│                              │
      │◀── { status: "delivered" } ────┤                              │
      │                                │                              │
      │                                │◀── POST /api/reply/req-1 ───┤
      │                                │    { reply: "answer" }       │
      │   (poll)                       │                              │
      ├── GET /api/request/req-1 ─────▶│                              │
      │◀── { status: "replied",  ──────┤                              │
      │     reply: "answer" }          │                              │
```

## For New Oracles

Agents created via `maw bud` should be aware of these conventions.
Communication rules are available via `/api/status` at the maw server.
When an agent's session starts, it can query its own status and pending messages.
