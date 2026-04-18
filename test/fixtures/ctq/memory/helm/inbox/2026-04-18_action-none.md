---
from: forge
to: helm
type: fyi
tags: [probe-2, word-boundary]
confidence: medium
action_required: none
priority: low
date: 2026-04-18
---

# FORGE → HELM: FYI

Probe 2 word-boundary case: `none` must NOT be mis-parsed as `no` prefix.
Expected: actionRequired=true with actionHint="none" (unknown value).
