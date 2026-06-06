# feat: Agent Status & Message Broker

## Summary

- Agent status tracking (busy/ready/idle) via Claude Code hooks + in-memory store with 120s TTL
- Busy guard on `maw hey` / `talk-to` / `/api/send` — queues messages instead of injecting into busy agents
- Message queue with auto-delivery (DispatchEngine) when agent transitions busy→ready
- Request-reply API for external clients (correlationId-based polling + callback)
- `maw reply` CLI command for oracles to respond to requests
- Deploy scripts for hooks + protocol to existing oracles
- Protocol baked into `maw bud` template for new oracles

## New API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/status` | All agent statuses + summary |
| GET | `/api/status/:oracle` | Single agent status |
| POST | `/api/status` | Report status change |
| GET | `/api/queue` | All queued messages |
| GET/POST | `/api/queue/:oracle` | Queue per oracle |
| POST | `/api/request` | Submit request → correlationId |
| GET | `/api/request/:id` | Poll for reply |
| POST | `/api/reply/:id` | Oracle submits reply |
| GET | `/api/requests` | List all requests |

## Architecture

```
Claude Code hooks ──POST──▶ /api/feed ──▶ AgentStatusStore (in-memory)
                                                │
                                          onChange(busy→ready)
                                                │
                                          DispatchEngine
                                                │
                                          auto sendKeys
```

## Commits

| Hash | Description |
|------|-------------|
| 655c934c | Phase 1 — Agent Status API with in-memory store and TTL-based idle detection |
| b91b0001 | Phase 2 — busy guard for hey/talk-to/api-send |
| 839c844d | Phase 3 — Message Queue + Dispatch Engine |
| 22be5f10 | Phase 4 — Communication Convention docs + SessionStart integration |
| 9633d656 | Phase 5 — Request-Reply with correlationId + external client API |
| 5011a78e | Deploy hooks script for oracle status-reporter integration |
| 00cd5453 | Fix: busy guard queries server API so CLI detects live agent status |
| 864a68c9 | `maw reply` command + bake protocol into bud template |

## Files Changed

29 files, +1,818 lines

### Core Modules (new)

| File | Purpose |
|------|---------|
| `src/core/agent-status.ts` | In-memory status store + TTL idle detection (120s) |
| `src/core/agent-status-guard.ts` | Busy guard — check status before sendKeys, query server API from CLI |
| `src/core/message-queue.ts` | In-memory message queue (pending/delivering/delivered/failed) |
| `src/core/dispatch-engine.ts` | Auto-deliver when busy→ready |
| `src/core/request-reply.ts` | correlationId-based request-reply store |

### API (new)

| File | Endpoints |
|------|-----------|
| `src/api/status.ts` | GET/POST `/api/status`, GET `/api/queue`, POST `/api/queue` |
| `src/api/request-reply.ts` | POST `/api/request`, GET `/api/request/:id`, POST `/api/reply/:id`, GET `/api/requests` |

### Plugin (new)

| File | Purpose |
|------|---------|
| `src/vendor/mpr-plugins/reply/` | `maw reply <id> <msg>` + `maw reply --list` |

### Integration (modified)

| File | Change |
|------|--------|
| `src/commands/shared/comm-send.ts` | Busy guard before sendKeys |
| `src/api/sessions.ts` | Busy guard in /api/send |
| `src/vendor/mpr-plugins/talk-to/impl.ts` | Busy guard |
| `src/core/server.ts` | Start DispatchEngine at boot |
| `src/engine/index.ts` | Wire feed → AgentStatusStore |
| `src/core/runtime/trigger-listener.ts` | SessionStart → report status |
| `src/vendor/mpr-plugins/bud/bud-init.ts` | Request-Reply Protocol in bud template |
| `src/api/index.ts` | Mount statusApi + requestReplyApi |

### Scripts & Docs

| File | Purpose |
|------|---------|
| `scripts/deploy-hooks.ts` | Deploy status-reporter hooks → 9 oracles |
| `scripts/deploy-reply-protocol.ts` | Deploy protocol section → oracles' CLAUDE.md |
| `docs/communication-convention.md` | Protocol spec |
| `docs/plan-agent-status-broker.md` | Design doc |

### Tests

| File | Tests |
|------|-------|
| `test/isolated/agent-status-store.test.ts` | Status store + TTL + onChange |
| `test/isolated/agent-status-guard.test.ts` | Busy guard + oracle name extraction |
| `test/isolated/api-status.test.ts` | Status API endpoints |
| `test/isolated/message-queue.test.ts` | Queue lifecycle |
| `test/isolated/dispatch-engine.test.ts` | Auto-delivery on status change |
| `test/isolated/request-reply.test.ts` | Request-reply store |
| `test/isolated/api-request-reply.test.ts` | Request-reply API endpoints |

55+ tests, all passing.

## Test Plan

- [x] 55+ unit tests across 7 test files
- [x] E2E: hook → status API → busy guard → queue → auto-deliver
- [x] E2E: `maw reply` command + request-reply flow
- [x] PM2 persistent server on port 3456
- [x] Hooks deployed to 9 oracles
- [x] Protocol deployed to 8 oracles' CLAUDE.md

Closes #1
