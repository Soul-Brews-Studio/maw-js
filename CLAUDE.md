# MAW-JS — Multi-Agent Workspace

## Project
MAW-JS is the backend server for the Oracle fleet dashboard. It manages tmux sessions, WebSocket streaming, PTY terminals, federation, and the REST API that powers the ARRA Office frontend (maw-ui).

## Key Paths
- **Backend**: `/home/lfz/Code/github.com/evilelfza/maw-js/src/` (Bun + Hono)
- **Frontend (maw-ui)**: `/home/lfz/Code/github.com/evilelfza/maw-ui/` (React + Vite)
- **Oracle v3 core**: `/home/lfz/Code/github.com/evilelfza/arra-oracle-v3/`

## Running
- Server: `bun run src/server.ts` (port 3456)
- Frontend dev: `cd ../maw-ui && bun dev` (port 5173, proxies API to 3456)
- Build frontend: `cd ../maw-ui && npx vite build`

## Conventions
- Dev work should go to **Blade** (01-blade) — not Sofia
- Always restart server after backend changes (Bun doesn't hot-reload)
- Upload files go to `/tmp/maw-uploads/` (auto-cleanup after 24h)
- File uploads send **path only** to agents — agent reads via Read tool (not raw file data)
- body limit: 1MB for most API, 11MB for /api/upload*
- UI build creates hashed filenames — old assets are stale, only index.html references matter
- Federation auth (HMAC) protects API from remote peers

## Architecture
```
Frontend (maw-ui :5173) <-> WebSocket/REST <-> Backend (maw-js :3456) <-> tmux sessions (Oracle agents)
```
