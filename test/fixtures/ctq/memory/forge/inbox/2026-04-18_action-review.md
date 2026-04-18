---
from: nexus
to: forge
type: review-request
tags: [probe-2, unusual-action-value]
confidence: high
action_required: review
priority: medium
date: 2026-04-18
---

# NEXUS → FORGE: review request

Probe 2 edge case: action_required value is `review` (not yes/no).
Parser should surface as actionRequired=true with actionHint="review"
per Principle 2 (never silently drop).
