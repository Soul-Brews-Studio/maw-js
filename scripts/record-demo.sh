#!/usr/bin/env bash
# Records the 90-second maw demo to docs/demo.cast (asciinema format).
#
# Why this script exists: the `maw demo` command is fully deterministic and
# runs inside tmux. Wrapping it in asciinema gives us a reproducible recording
# we can re-run on every ship without re-scripting the narrative.
#
# Prerequisites
#   - asciinema     (brew install asciinema | pip install asciinema | apt install asciinema)
#   - tmux          (maw demo splits panes; asciinema launches a fresh tmux session)
#   - maw           (on PATH — `maw --version` should succeed)
#   - svg-term-cli  (optional, for SVG output) — `npm install -g svg-term-cli`
#
# Terminal
#   Resize to 100x30 before recording. Bigger is fine, smaller will clip the
#   split-pane layout.
#
# Run
#   bash scripts/record-demo.sh
#
# After recording
#   Upload to asciinema.org for the hosted player:
#     asciinema upload docs/demo.cast
#   OR render to SVG for embedding directly in README:
#     svg-term --in docs/demo.cast --out docs/demo.svg --window
#
# Then paste the snippet from scripts/README-demo-snippet.md into README.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAST_PATH="$REPO_ROOT/docs/demo.cast"

# ---- sanity checks ---------------------------------------------------------

if ! command -v asciinema >/dev/null 2>&1; then
  echo "error: asciinema is not installed." >&2
  echo "  install: brew install asciinema   (or: pip install asciinema)" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux is not installed — maw demo requires tmux for pane splits." >&2
  exit 1
fi

if ! command -v maw >/dev/null 2>&1; then
  echo "error: maw is not on PATH. Run 'bun link' or install globally first." >&2
  exit 1
fi

# ---- prep ------------------------------------------------------------------

mkdir -p "$REPO_ROOT/docs"

if [[ -f "$CAST_PATH" ]]; then
  echo "warn: $CAST_PATH already exists — will be overwritten."
fi

cat <<'INTRO'

maw demo asciinema recorder
---------------------------
About to record ~90 seconds of `maw demo` into docs/demo.cast.

Checklist before you press Enter:
  [ ] Terminal resized to 100x30 (or larger)
  [ ] Shell prompt is short/clean (consider `PS1='$ '` for the recording shell)
  [ ] Nothing else scheduled to print to this terminal
  [ ] You will NOT type during the recording — maw demo runs itself

Press Enter to start recording. Ctrl-C to cancel.
INTRO

read -r

# ---- record ----------------------------------------------------------------
#
# Launch asciinema with a wrapped tmux session. maw demo guards on $TMUX, so
# we create a fresh tmux session inside the recording and run `maw demo`
# as its first command. When maw demo exits, tmux exits, asciinema exits.

asciinema rec "$CAST_PATH" \
  --title "maw — multi-agent in 90 seconds" \
  --idle-time-limit 2 \
  --command "tmux new-session -A -s mawdemo 'maw demo'"

# ---- next steps ------------------------------------------------------------

cat <<NEXT

Recording saved: $CAST_PATH

Next steps:
  1. Play it back locally to verify:
       asciinema play $CAST_PATH

  2. Upload to asciinema.org for a hosted player URL:
       asciinema upload $CAST_PATH
     (copy the returned URL and the cast id into README)

  3. OR render SVG for inline README embed:
       svg-term --in $CAST_PATH --out $REPO_ROOT/docs/demo.svg --window

  4. Paste the embed snippet from scripts/README-demo-snippet.md into README.md.
NEXT
