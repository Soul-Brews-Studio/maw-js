# maw discord

Discord fleet ops plugin — token audit + fleet status (v0.2). bind/pair/route/serve coming.

## Hybrid pattern

Tokens stay in **`pass`** (central, GPG-encrypted, shared via `laris-co/password-store`).
Per-bot non-secret state lives in **`<bot-repo>/.discord/`** (access.json, channel-map.json, config.json, .envrc).

See: `discord-oracle/ψ/outbox/ideas/2026-05-17_self-contained-bot-repo-gpg-pattern.md`

## Subcommands

### v0.1 — tokens

| Command | Purpose | Side effects |
|---|---|---|
| `maw discord` | help | none |
| `maw discord tokens ls` | list all tokens in `~/.password-store/discord/` (name + size + mtime) | none (no decrypt, no network) |
| `maw discord tokens check [bot]` | decrypt each token + ping Discord REST | network (HTTPS to discord.com) |

### v0.2 — status (NEW)

| Command | Purpose | Side effects |
|---|---|---|
| `maw discord status` | fleet inspection table — all bots × pass × legacy × hybrid × tmux × registry | none (filesystem only) |
| `maw discord status <bot>` | detailed card for one bot | none |
| `maw discord status --check` | + Discord REST per bot (slower) | network |
| `maw discord status --redact` | hide dates (screen-share safe — date drift can leak rotation patterns) | none |
| `maw discord status --json` | machine-readable output with severity for CI/alerting | none |

### v0.3 — planned

| Command | Purpose |
|---|---|
| `maw discord bind <bot>` | end-to-end onboard (ghq get + direnv allow + maw wake) |
| `maw discord pair <oracle> <channel>` | seed access.json + channel-map.json |
| `maw discord route <from> <to>` | rewire channel-map.json entry |
| `maw discord serve [--detach]` | daemon — heartbeat, presence, webhook receive (engine.serve pattern) |

## Severity model (status output)

| Severity | When | Action |
|---|---|---|
| `ok` ✓ | token + registered + (hybrid OR running locally) | no action |
| `warn` ○ | registered + has hybrid, not running locally | probably fine, just offline on this host |
| `info` · | legacy state-dir only, hybrid not applied | migration TODO |
| `error` ✗ | token-only (orphan in pass) OR registered-only (missing token) OR Discord REST failure | investigate |

Maps to syslog levels — pipe `--json` to log aggregator for free severity routing.

## Known v0.1+v0.2 caveats

- **`discord-token` (no -oracle suffix)** — legacy aggregate from early provisioning. Rotated away, returns 401. Safe to remove from pass.
- **`pulse-token` (no -oracle suffix)** — legacy duplicate of `pulse-oracle-token`. Same identity.
- **`timekeeper-oracle-token`** — known attribution issue documented in `discord-oracle/CLAUDE.md`.

Clean run baseline today: **18/20 green** via `tokens check`, **18 info / 2 error** via `status` (the 2 errors are the legacy tokens above).

## Security posture

- ✅ Tokens never printed (only username on successful Discord 200)
- ✅ Decrypt via `pass show` (caller must have GPG private key)
- ✅ `fetch()` calls use 5-second `AbortController` timeout
- ✅ Sequential REST calls (rate-limit polite, debug-friendly)
- ✅ `--redact` hides date metadata for screen-sharing (rotation cadence leak)
- ⚠️ No `--strict` mode yet — fail count goes to stdout but exit is `ok:true`. v0.3 backlog.

## Capabilities (plugin.json)

- `fs:read` — reads `~/.password-store/discord/*.gpg`, `~/.claude/channels/<bot>/`, `<bot-repo>/.discord/`, `discord-oracle/src/state-dirs.ts`
- `net` — outbound HTTPS to `discord.com/api/v10/users/@me` (--check only)

## state-dirs.ts parsing

v0.2 parses `discord-oracle/src/state-dirs.ts` via regex to find registered bots.
v0.3 should switch to a canonical `bun src/scripts/list-registered.ts --json` API in discord-oracle.
Issue filed against discord-oracle to ship that script.

If discord-oracle isn't cloned locally, registry column shows everything as not-registered (graceful degradation).

## Development

- Pattern reference: `maw-plugin-registry/plugins/team/index.ts` (mawjs-oracle's recommendation)
- SDK guide: shared by `[m5:homekeeper]` 2026-05-17
- engine.serve reference (v0.3): `maw-js/src/vendor/mpr-plugins/messages/` (per mawjs-oracle)
- Shared utilities in `lib.ts` — `tokens.ts` and `status.ts` both import; no duplication

## Layout

```
plugins/discord/
├── plugin.json     declares 'discord' top-level
├── README.md       (this file)
├── index.ts        subcommand dispatch (args[0]?.toLowerCase() pattern)
├── lib.ts          shared utilities (pass, GPG decrypt, REST ping, ghq path, state-dirs parse)
├── tokens.ts       tokens ls + tokens check
└── status.ts       status [bot] [--check] [--redact] [--json]
```

## History

- **2026-05-17** v0.1 shipped — tokens ls/check. Reviewed by [m5:homekeeper] (5 items applied).
- **2026-05-17** v0.2 shipped — status added. `lib.ts` extracted. Severity + --redact + --json baked in per homekeeper Q1-Q3 review.
- Pattern: build from real friction, ship narrow surface, refactor before adding side-effect verbs.
