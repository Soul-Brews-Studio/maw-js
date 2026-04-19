# maw — 90-second asciinema demo script

> Purpose: exact command sequence for the README asciinema recording. See
> [#453](https://github.com/Soul-Brews-Studio/maw-js/issues/453). This file is
> the **plan**; the recording itself is produced by running
> [`scripts/record-demo.sh`](../scripts/record-demo.sh) (canned path) or by
> following the **real-commands tour** below (the 15-step script).

## Two recording paths

| Path | Script | What it shows | Pros | Cons |
|------|--------|---------------|------|------|
| **Canned** | `maw demo` (wrapped by `scripts/record-demo.sh`) | Two simulated agents, no API key | Reproducible, zero setup, zero $ | Doesn't show federation / peers / scan |
| **Real-commands tour** | This doc, recorded manually | Real CLI against a prepared fleet | Shows federation, peers, scan, find | Needs a populated env; one-off recording |

The README should link to the canned recording for cold visitors; the tour lives
here as a reference for the next time we re-record a deeper demo.

---

## Setup (before pressing record)

Prepare a clean-looking shell on a node that already has one real oracle
running (`maw wake` needs tmux + a live session to be visually interesting).

```bash
# 1. Terminal
resize -s 30 100                           # 100x30 is the target canvas
export PS1='$ '                            # short prompt for clean frames

# 2. Fresh asciinema session
asciinema rec docs/demo.cast \
  --title "maw — multi-agent in 90 seconds" \
  --idle-time-limit 2 \
  --cols 100 --rows 30

# 3. Inside the recording, first verify env is sane (off-camera seconds)
maw --version                              # v26.4.x-alpha.N (any recent cut)
tmux list-sessions 2>/dev/null | head -3   # confirm at least 1 oracle running
```

Recording oracle name used below: **`myproject`** (replace with whatever exists
on the recording host — `neo`, `mawjs`, etc.). Keep the name short so it fits
in 100-col frames.

---

## The 15-command tour (target: ~90s)

Timings are **upper bounds** — some commands complete in <1s, some stream for
4–5s. The `# ~Xs` annotation is the budget, not a required pause.

| # | Command | Budget | Shows |
|---|---------|-------:|-------|
| 1 | `maw --version` | 1s | install present |
| 2 | `maw ls` | 4s | fleet overview |
| 3 | `maw health` | 4s | tmux + server + peers |
| 4 | `maw wake myproject` | 6s | spawn an oracle |
| 5 | `maw hey myproject "summarize what you see"` | 5s | send a task |
| 6 | `maw peek myproject` | 5s | watch output |
| 7 | `maw panes` | 3s | tmux layout |
| 8 | `maw fleet ls` | 5s | full fleet table |
| 9 | `maw oracle scan` | 7s | cross-node census |
| 10 | `maw peers list` | 3s | registered nodes |
| 11 | `maw peers probe white` | 5s | live handshake |
| 12 | `maw contacts` | 5s | who's who |
| 13 | `maw find "asciinema"` | 5s | cross-oracle memory search |
| 14 | `maw costs` | 5s | dollar figure |
| 15 | `maw ui` | 2s | browser URL |

Budget total: **65s** of commands + ~25s of narrator-style pauses / typing
between commands = **~90s**.

### Per-command expected output fragment

These are **output shape assertions** — used by the recording operator to
abort-and-retry if a command prints something unexpected (e.g. an error trail
from a stale peer). They are NOT byte-exact regressions.

```text
# 1. maw --version
maw v26.4.xx-alpha.NN

# 2. maw ls            (header shows sessions; color-coded dots for windows)
loaded config: … plugins, N peers
100-boonkeeper
  ● 0: boonkeeper-oracle
101-mawjs
  ● 0: mawjs-oracle
  ● 1: mawjs-hello
…

# 3. maw health
maw health
  ● tmux server        running (N sessions)
  ● maw server         online (:3456, N sessions)
  ● disk /tmp          XXG free
  ● memory             XXMB available
  ● pm2 maw            online (pid NNNNNN)
  ● peer <alias>       …

# 4. maw wake myproject
# spawns/attaches a tmux session; on-screen: "waking myproject" + spinner;
# session count in (2) increments by one if new.

# 5. maw hey myproject "summarize what you see"
# → sent (N bytes) to myproject:0

# 6. maw peek myproject
# last ~20 lines of the pane; ends with the prompt of the agent.

# 7. maw panes
# tabular list: index / size / command / title

# 8. maw fleet ls
  Fleet Configs (N active, M disabled)
  #    Session              Win   Status
  ──── ──────────────────── ───── ────────────────────
  100  100-boonkeeper       1     stopped
  101  101-mawjs            1     running
  …

# 9. maw oracle scan
  ⏳ scanning ghq root: <path>
    fleet lineage: N entries from …/fleet
    + <org>/<repo-oracle> [ψ fleet -oracle]
  ⏳ <org>: X repos, Y oracles
  ✓ N oracles locally (no change) in 0.Xs

# 10. maw peers list
# tabular list of registered peers (alias / url / lastSeen)

# 11. maw peers probe white
# → { node: "white", status: "ok", version: "…", latencyMs: … }
# (JSON one-liner; loud on failure)

# 12. maw contacts
CONTACTS (N):
  <name>  maw: <node>:<oracle>   thread: channel:<name>   "<note>"
  …

# 13. maw find "asciinema"
  🔍 Searching — "asciinema"
  ● <oracle> — <path>:<line>: …   (N matches)
  ○ no matches found across N oracle(s)   [if none]

# 14. maw costs
  (either a dollar-figure table, or "cannot reach maw server" if serve is down;
   prefer recording on a host where `maw serve` is up — the dollar figure is
   the payoff line.)

# 15. maw ui
  serving federation lens at http://localhost:3456/federation_2d.html
```

### Short script version (if 15 feels long)

If the recording overshoots 90s, drop steps **7, 10, 15** (kept the
federation-heavy ones: 9, 11, 12, 13). That leaves 12 commands and lands closer
to 75s.

If the recording overshoots again, fall back to the canned path
(`scripts/record-demo.sh`) and ship that instead — it's ~90s by construction.

---

## Recording

```bash
# Inside a 100x30 terminal with a clean prompt:
asciinema rec docs/demo.cast \
  --title "maw — multi-agent in 90 seconds" \
  --idle-time-limit 2 \
  --cols 100 --rows 30

# …run the 15 commands above, then Ctrl-D to stop…

# Verify playback:
asciinema play docs/demo.cast

# Upload to asciinema.org for hosted player:
asciinema upload docs/demo.cast
# → copy the returned cast id (e.g. 702134)

# OR render to an inline SVG:
npm install -g svg-term-cli
svg-term --in docs/demo.cast --out docs/demo.svg --window
```

Commit **both** `docs/demo.cast` and `docs/demo.svg` — the cast lets us
re-render at a different size later without re-recording.

---

## README embed (after recording lands)

The snippets are already written — see
[`scripts/README-demo-snippet.md`](../scripts/README-demo-snippet.md). Use
**Option C** (both SVG inline + asciinema.org link):

```markdown
[![maw demo](docs/demo.svg)](https://asciinema.org/a/<CAST_ID>)

> _Click the recording to play interactively on asciinema.org._
```

Paste between the title/tagline block and the `## Install` heading in
`README.md`. The `<!-- TODO -->` comment at `README.md:12` marks the exact
spot.

---

## Notes for future re-recording

- The tour intentionally avoids `maw bud --from-repo` (#588 scaffold-only —
  ship not yet complete) and `maw serve` bind subtleties (#616 in flight).
  Once both land, add them as **step 16/17** (`maw bud --from-repo <path>
  --stem <stem>` + `maw serve --seed`).
- `maw demo` itself is a good candidate for step 0/intro — "here's the
  zero-config path" — but it runs for ~30s of its own, so only include if
  targeting a **2-minute** recording rather than 90s.
- If the recording host has no real peer to probe, step 11 will print an
  error. Either set up a transient peer (`maw peers add local
  http://localhost:3456 --node self`) or drop step 11 from the tour.

## Status

- Script: **ready** (this doc).
- Recording: **not yet produced** — blocks on Nat running `asciinema rec` on a
  host with a populated fleet.
- README embed: **staged** (TODO comment at `README.md:12`, snippets in
  `scripts/README-demo-snippet.md`).
- Issue [#453](https://github.com/Soul-Brews-Studio/maw-js/issues/453) stays
  **open** until the `.cast` / `.svg` are committed and the TODO is replaced
  by the actual embed.
