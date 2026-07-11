#!/bin/bash
# UserPromptSubmit: when the prompt is /seat, clear presence away IMMEDIATELY —
# at harness submit-time, deterministically. This is the PAIR of toilet-away.sh
# (kobo-289): /toilet sets away, /seat clears it. Without a fleet-wide back-hook,
# an oracle that ran /toilet stays sticky-away (kobo-287) forever when the /seat
# skill's LLM-driven back step is skipped — a board-lie. The skill's step 2.5
# `maw presence back` stays as backup; this hook guarantees it fires.
# ponytail: gate on the explicit /seat command only — same discipline as toilet-away.
# Emits nothing (stdout would pollute the prompt).
python3 -c '
import json, sys
try:
    p = json.loads(sys.stdin.read()).get("prompt", "").strip()
    if p == "/seat" or p.startswith("/seat "):
        import subprocess
        subprocess.run(["maw", "presence", "back"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
except Exception:
    pass
'
