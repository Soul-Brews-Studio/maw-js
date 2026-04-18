---
from: david
to: leo
type: weekly-brief
tags: [probe-3, cross-team, leo-pending]
confidence: high
action_required: yes (weekly decisions pending)
priority: medium
date: 2026-04-18
---

# DAVID → LEO: Weekly brief

Probe 3 edge case: frontmatter `to: leo` filesystem-homed in david's inbox.
Leo is in TEAM_ROSTER.cross but has no inbox dir. Scanner should override
directory-based `to: david` with frontmatter `to: leo` so this surfaces
under leo's bucket in the queue.
