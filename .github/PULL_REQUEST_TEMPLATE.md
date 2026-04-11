# PR Review Checklist — NUCHULA/maw-js

> audit 📋 reviews every PR against this checklist before merge.
> Check each item. If N/A, mark `- [x] N/A:` with reason.

---

## Mandatory (every PR)

- [ ] No secrets/credentials committed (`.env`, tokens, API keys)
- [ ] `bun test` passes
- [ ] UI accessible: `curl -sf http://127.0.0.1:3456/` returns HTML
- [ ] Server binds `0.0.0.0` (LAN accessible) — not `127.0.0.1` only
- [ ] No `any` types introduced (upstream spent effort eliminating them)
- [ ] SHARED-RULES compliance:
  - [ ] Changes in NUCHULA fork only (not Soul-Brews-Studio)
  - [ ] Deploy + verify loop completed (`systemctl restart maw-js` + `post-deploy-verify.sh`)
  - [ ] If stuck, asked back — did not finish silently

## Upstream Merge PRs (additional — check when merging from Soul-Brews-Studio)

- [ ] NUCHULA patches preserved:
  - [ ] `src/config.ts` — `CONFIG_DIR` customization
  - [ ] `src/deprecated.ts` — `/maw-log` endpoint
- [ ] No breaking changes to CLI: `maw hey`, `maw wake`, `maw team`
- [ ] Teams CRUD works: `curl -sf http://127.0.0.1:3456/api/teams`
- [ ] Views registered in `src/views/index.ts` — no silent removal

## Code Quality

- [ ] No leftover `console.log` / debug artifacts
- [ ] Errors not swallowed silently (`catch` blocks must log or re-throw)
- [ ] Tests added for new functionality
- [ ] Commit messages follow convention: `feat:` / `fix:` / `chore:` / `refactor:`

---

## Post-Deploy Verification

After merge + deploy, run:

```bash
bash /data/workspace/scripts/post-deploy-verify.sh
```

Expected: 8/8 checks pass (systemd, port, bind, UI, assets, API sessions, API teams, LAN).

## Review Flow

```
Developer creates PR
  → audit 📋 reviews checklist
  → proof ✅ runs test suite
  → both pass → forge 🔥 approves merge
  → deploy + verify (post-deploy-verify.sh)
```

---

*Created by audit 📋 — 2026-04-11*
*Reference: /data/workspace/SHARED-RULES.md*
