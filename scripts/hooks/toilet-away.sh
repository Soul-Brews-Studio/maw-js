#!/bin/bash
# UserPromptSubmit: when the prompt is /toilet, set presence away IMMEDIATELY —
# at harness submit-time, before the LLM turn boots the skill. Closes the window
# where hey injects during rrr/forward wrap. Skill step 0 still sets away as backup.
# ponytail: gate on the explicit /toilet command only — natural-language triggers
# fall back to the skill's step-0 away. Emits nothing (stdout would pollute the prompt).
python3 -c '
import json, sys
try:
    p = json.loads(sys.stdin.read()).get("prompt", "").strip()
    if p == "/toilet" or p.startswith("/toilet "):
        import subprocess
        subprocess.run(["maw", "presence", "away"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
except Exception:
    pass
'
