# Runbook — `maw wake` with Channels (Discord/Telegram bots)

How `maw wake <oracle>` auto-configures Claude Code for channel-enabled oracles
(Discord bots, Telegram bots, etc.) with `--continue`, `--channels`, and
`--dangerously-skip-permissions`.

Validated end-to-end during /loop session 2026-05-04 → 05.

## TL;DR

If an oracle has a channel config at `~/.claude/channels/<oracle>/config.json`,
`maw wake <oracle>` automatically launches Claude with:

```bash
DISCORD_STATE_DIR=~/.claude/channels/<oracle> \
  claude --dangerously-skip-permissions --continue \
         --channels plugin:discord@claude-plugins-official
```

No flags needed. Just `maw wake mybot`. Done.

## Why these flags together

| Flag | What | Why |
|---|---|---|
| `--channels plugin:discord@claude-plugins-official` | Loads the Discord channel plugin | Connects to Discord API, listens for messages |
| `--dangerously-skip-permissions` | Bypass permission prompts | Bot runs autonomous; permission dialog would freeze it |
| `--continue` | Resume previous Claude session | Bot retains context across restarts (history, identity, work-in-progress) |

Without these three, the bot either prompts for permission (hangs forever),
loses context every restart, or doesn't connect to Discord. They go together.

## How auto-injection works

`buildCommand()` in `src/config/command.ts` checks:

```typescript
if (opts.channels?.length) {
  cmd += " --channels " + opts.channels.join(" ");
  if (!cmd.includes("--dangerously-skip-permissions")) {
    cmd += " --dangerously-skip-permissions";
  }
  if (!cmd.includes("--continue") && !cmd.includes("--resume")) {
    cmd += " --continue";
  }
}
```

`maw wake` reads channel config via `getChannelPluginIds(oracle)` and passes
them to `buildCommand`. If the oracle has channels → all three flags injected.

## Setting up a new Discord-enabled oracle

### 1. Create the channel state dir
```bash
mkdir -p ~/.claude/channels/mybot
```

### 2. Add the bot token (.env)
```bash
echo 'DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN' > ~/.claude/channels/mybot/.env
```

### 3. Configure access (access.json)
```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<your-discord-user-id>"],
  "groups": {
    "<channel-id>": {
      "requireMention": false,
      "allowFrom": ["<your-discord-user-id>"]
    }
  },
  "pending": {}
}
```

### 4. Register the channel (config.json)
```json
{
  "plugins": [
    {
      "id": "plugin:discord@claude-plugins-official",
      "env": {
        "DISCORD_STATE_DIR": "~/.claude/channels/mybot"
      }
    }
  ]
}
```

Or use `maw channel add mybot discord` — same result, less typing.

### 5. Wake
```bash
maw wake mybot
```

That's it. Bot is online with full context across restarts.

## Multiple bots, one host

Each oracle gets its own `DISCORD_STATE_DIR`. Bots don't collide because
state (access.json, pairing tokens, message queues) lives per-oracle:

```
~/.claude/channels/
├── mawjs-oracle/         → MawJS Oracle bot
├── mother-oracle/        → Mother Oracle bot
├── timekeeper-oracle/    → TimeKeeper Oracle bot
├── metis-oracle/         → Metis Oracle bot
├── hermes-discord/       → Hermes Discord bot
└── discord-oracle/       → Oracle Fleet Admin bot
```

`maw wake <oracle>` injects the right `DISCORD_STATE_DIR` for each.

## Channel-per-oracle access semantics

Within `access.json` groups, each channel has:
- `requireMention: true` — bot only responds when @tagged
- `requireMention: false` — bot responds to any message in channel

Tune per channel. Useful pattern: `#general` is loud (no mention), `#dev` is quiet (mention required).

## Restart preserves context

Because `--continue` is auto-added, a `maw kill <bot>` + `maw wake <bot>`
restarts cleanly without losing:
- Past conversation history
- Identity context (CLAUDE.md is loaded fresh, history is recovered)
- Mid-task state (the bot resumes where it left off)

Verified during the /loop: discord-oracle was killed and re-woken several times,
context survived each cycle.

## What NOT to do

- ❌ `claude --channels ...` directly without `--dangerously-skip-permissions` —
  bot hangs at first permission prompt
- ❌ Manually mounting the same `DISCORD_STATE_DIR` for two bots —
  state collision, both bots will fight over message queues
- ❌ Setting `requireMention: true` everywhere — bot becomes invisible
- ❌ `claude` without `--continue` — bot loses context every restart

## Origin

The pattern was identified during the /loop session iterations 5-8:
- Iter 5: `maw wake mother` was hanging on permission prompt
- Iter 7: Made channel-enabled bots auto-add `--dangerously-skip-permissions`
- Iter 8: Added `--continue` so restarts preserve context

Filed as #1108. Shipped in v26.5.4-alpha.2155.

## Related

- `maw channel ls` — list configured channels per oracle
- `maw channel add <oracle> <plugin>` — register channel plugin
- `maw channel rm <oracle> <plugin>` — unregister
- See `ψ/memory/learnings/2026-05-03_*.md` for Discord fleet build-out
- See `docs/docker-runbook.md` for containerized version
