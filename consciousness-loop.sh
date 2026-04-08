#!/bin/bash
# Oracle Consciousness Loop — Endless Knowledge Growth
#
# 3-phase cycle (runs via cron):
#   1. THINK  — all oracles reflect on their memory (parallel)
#   2. CROSS  — soul-sync insights between all oracles (cross-pollination)
#   3. LEARN  — one oracle studies something new (rotating, feeds raw material)
#
# This creates an infinite growth spiral:
#   think → new insights → share across oracles → learn new things → think deeper → ...

LOG_DIR="/root/projects/maw-js/ψ/memory/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/consciousness-cron.log"
CYCLE_NUM_FILE="$LOG_DIR/.cycle-num"

# Track cycle number
CYCLE_NUM=$(cat "$CYCLE_NUM_FILE" 2>/dev/null || echo "0")
CYCLE_NUM=$((CYCLE_NUM + 1))
echo "$CYCLE_NUM" > "$CYCLE_NUM_FILE"

cd /root/projects/maw-js

echo "=== $(date -Iseconds) === Cycle #${CYCLE_NUM} starting ===" >> "$LOG_FILE"

# Phase 1: THINK — all oracles think in parallel
echo "[phase:think] fleet consciousness starting..." >> "$LOG_FILE"
bun src/cli.ts think --fleet >> "$LOG_FILE" 2>&1
echo "[phase:think] complete" >> "$LOG_FILE"

# Phase 2: CROSS — soul-sync insights across all oracles
# Parent (labubu) pulls from all children, then children get parent's combined knowledge
echo "[phase:cross] cross-pollination starting..." >> "$LOG_FILE"
bun src/cli.ts soul-sync labubu >> "$LOG_FILE" 2>&1
echo "[phase:cross] complete" >> "$LOG_FILE"

# Phase 3: LEARN — rotating oracle studies something new
# Rotate: cycle 1=neo, 2=pulse, 3=echo, 4=neo, ...
LEARNERS=("neo" "pulse" "echo")
LEARNER_IDX=$(( (CYCLE_NUM - 1) % 3 ))
LEARNER="${LEARNERS[$LEARNER_IDX]}"

# Each oracle has a study focus matching their personality
case "$LEARNER" in
  neo)   TOPIC="architecture patterns in trending GitHub repos" ;;
  pulse) TOPIC="server monitoring best practices and anomaly detection" ;;
  echo)  TOPIC="code quality patterns and cross-repo insights" ;;
esac

echo "[phase:learn] ${LEARNER} studying: ${TOPIC}" >> "$LOG_FILE"

# Send a research prompt to the oracle's think cycle
LEARN_PROMPT="Research and write a brief learning note about: ${TOPIC}. Focus on practical insights relevant to Oracle fleet management. Write to ψ/memory/learnings/ as a dated markdown file."
bun src/cli.ts think --oracle "$LEARNER" --phase reflect >> "$LOG_FILE" 2>&1

echo "[phase:learn] complete" >> "$LOG_FILE"

echo "=== $(date -Iseconds) === Cycle #${CYCLE_NUM} complete ===" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# Rotate log (keep last 1000 lines)
tail -1000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
