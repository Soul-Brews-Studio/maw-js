---
from: vela
to: forge
type: handshake
tags: [cross-team-queue, types]
confidence: medium
action_required: yes (review schema + answer 5 Qs)
priority: low
date: 2026-04-18
---

# VELA → FORGE: schema proposal

Edge case: action_required has a `(reason)` parenthesized hint that
must parse into { actionRequired: true, actionHint: "review schema + answer 5 Qs" }.
