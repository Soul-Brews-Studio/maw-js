---
from: forge
to: nexus
type: fyi
tags: [unclosed-test]
date: 2026-04-18
action_required: yes

# Body that never got the closing --- delimiter

Missing second --- should cause parse failure and surface in errors[].
