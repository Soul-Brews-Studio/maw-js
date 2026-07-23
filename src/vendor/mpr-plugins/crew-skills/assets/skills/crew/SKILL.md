---
name: crew
description: Spin up an autonomous crew cell — 4 permanent raw claude panes — front(.0 coordinate + report head-lead) · conductor(.1 decompose/route) · worker(.2 execute → CC Task sub-agent offload) · reviewer(.3 review · executor≠reviewer). flow front→conductor→worker→reviewer→front→lead. front toilet/clear แล้วทีมไม่ตาย (raw panes อิสระ). kernel = /head 4-pane (validated kobo-89/91). crew ต้องอยู่ใน company. Use when user says "/crew", "เรียก crew", "ขอ front", or an oracle needs a work cell.
---

# /crew — v2 2-window cell: W0/page1 brains (opus) — front(.0) · conductor 🎼 · reviewer 🔎 | W1/page2 — worker ⚒ (sonnet)

> **v2 (kobo-344 340a):** the cell spans **2 tmux windows** in one session. **W0 "page1" = opus brains** (front · conductor · reviewer — think/route/review). **W1 "page2" = sonnet worker(s)** (heavy exec on the cheaper/faster tier). Cross-window comm via `maw hey session:W1.pane` (resolve fresh from pane-id, §3). Dynamic worker ×N = 340b · pane-identity/sign = 340c (this card = foundation: layout + spawn + `--model "claude-sonnet-5"` worker in W1, self-heal + sonnet fallback, kobo-376).

```
   inbound (another oracle / head-lead · maw hey / card)
        │
        ▼
      front (.0)   (= pane ที่เรียก /crew · lowest-index · coordinate + report head-lead)
        │  brief — ไม่ decompose เอง · ไม่ execution เอง
        ▼
    conductor (.1) 🎼   decompose (story-split→card) · route/dispatch · light-exec
        │  dispatch งาน
        ▼
   worker (W1 ⚒ sonnet)   execute (page2, separate window) → offload heavy → CC Task sub-agent (kobo-317) · คืน distilled
        │  เสร็จ
        ▼
    reviewer (.3) 🔎   pre-PR gate in-cell (correctness+scope · executor≠reviewer)
        │  verdict
        ▼
      front → lead (head)   (head reviewer = final gate ก่อน Tony · 2 gate ไม่ชน)
```

**4 pane ถาวร (permanent cell)** — front + conductor + worker + reviewer เป็น pane ฐานของ cell ทั้งหมด (ต่างจากรุ่นก่อน kobo-202/204 ที่ front รวม conductor + reviewer เป็น on-demand transient). งานไหลลง (front→conductor→worker) · ผลไหลขึ้น (worker→reviewer→front→lead) · **คนทำ ≠ คนตรวจ** (worker execute, reviewer ตรวจ — executor ห้ามเป็น reviewer ตัวเอง). *(pivot kobo-318: split conductor ออกจาก front + reviewer เป็น pane ถาวร → front ว่างจริง = pure coordinate + report head-lead)*

**front ว่างจริง (delegate ครบ)** — front **ไม่ decompose เอง** (→ brief conductor) · **ไม่ execution เอง** (→ worker) · **ไม่ review เอง** (→ reviewer). front = ประสาน + spawn/teardown + report ขึ้น head-lead เท่านั้น → ไม่ผลิต artifact ให้ใคร review = self-review guard สะอาด.

**2 gate ไม่ชน** — **crew reviewer (.3) = pre-PR gate ใน cell** (ตรวจ correctness+scope *ก่อน* front stamp PR / เปิด PR) · **head reviewer = final gate ก่อน Tony** (ตรวจ PR ก่อน merge, ปลายทาง review chain `worker → crew reviewer → head reviewer → lead`). crew reviewer กรองก่อนงานขึ้น, head reviewer กรองก่อน merge — คนละจุดในสาย ไม่ซ้ำงาน.

**funnel ordering (kobo-325)** — hand-off gate ถัดไป **หลัง gate ตัวเอง sign เท่านั้น**: `worker → crew reviewer(.3) → front → head reviewer(.2) → merge`. **head ไม่ merge จนครบ crew + head sign** (ไม่ race, ไม่ข้าม gate).

**Kernel = /head 4-pane (validated kobo-89/91)** — spawn form, roster (resolve pane-id→index), comm, Stop hook, liveness, toilet-per-pane, teardown: **โครงเดียวกับ `/head` SKILL §Spawn/§Roster/§toilet-per-pane/§Teardown**. conductor + reviewer contract = **variant ของ head** (ภาษาเดิม). ไฟล์นี้เขียนส่วนต่างของ crew: 4 บท (front·conductor·worker·reviewer) + worker execution tier (kobo-317 offload).

**Model: N panes, 1 soul** — pane ไม่ใช่ sub-oracle แยกร่าง เป็น oracle คนเดียว (eq3/patchwork) แยก pane ทำงานคนละบท. raw claude pane ใน repo → oracle resolve อัตโนมัติจาก session name (hook key) → **เสียบ infra ของ oracle ฟรี** (worklog, status, liveness) โดยไม่ต่อท่อใหม่. *(verified 2026-07-04: raw-pane Bash/Edit logs เป็น oracle เอง)*

- **🚫 ห้าม `run_in_background`** — งาน bg มองไม่เห็น ค้างไม่รู้. **2 axes ของ parallel:** within-workstream (sub-task ขนาน) = **CC Task sub-agent** (kobo-317, ไม่เพิ่ม pane) · cross-workstream (สายงานอิสระ) = **worker pane ×N ใน W1** (conductor spawn/kill, §5 v2 340b). ยกเว้น watch เล็ก (รอ CI) รันใน pane worker เอง
- ทุก pane คุยกันผ่าน **`maw hey <pane-addr>`** (resolve pane-id → index สด §3)

**Signal+state: push the SIGNAL, pull the STATE** — แต่ละ pane เขียน state ลงไฟล์ (`$CREW_STATE_DIR/<role>.md`) + ping coord 1 บรรทัดเมื่อมีเหตุ. Stop hook เสริม ping idle อัตโนมัติ (worker→conductor · reviewer→front) — §1. เนื้ออยู่ในไฟล์ (raw pane ไม่มี auto-idle-notif → signal+state คือกลไกเดียว).

Status dir: **`$CREW_STATE_DIR`** (default `ψ/active/crew/`) — ephemeral, gitignored — roster (`coord.md`, เจ้าของ = front) + `conductor.md` · `worker.md` · `reviewer.md` (+ `*-contract.md`).

## 0. Company-gate (crew ⊂ company)

`/crew` **resolve company ก่อนทุกอย่าง** — oracle นี้เป็นสมาชิก company ไหน (`~/.maw/companies/<co>.json` depts):

```bash
CO=$(grep -rl "\"$(tmux display-message -p '#{session_name}' | sed 's/^[0-9]*-//')\"" ~/.maw/companies/*.json 2>/dev/null | head -1)
[ -z "$CO" ] && echo "crew ต้องอยู่ใน company; นอก company ใช้ harness sub-agent (Agent tool) แทน" && exit
CO_NAME=$(basename "$CO" .json)   # company name (kobo-267) → stamped into MAW_ROOM_COMPANY at spawn → presence company-scope
# tag THIS pane (front) @role at init — UNCONDITIONAL, before any spawn (kobo-281/282):
# tagging here fires on every /crew (spawn or not) AND after the company-gate refuse above
# (a refused /crew exits before this line → no stale coord). @role load-bearing: seat-resume
# reads it (coord → coord.md) so front re-seats its roster after /clear.
tmux set-option -p -t "$TMUX_PANE" @role "🧭 coord"
[ "$(tmux display-message -t "$TMUX_PANE" -p '#{@role}')" = "🧭 coord" ] || tmux set-option -p -t "$TMUX_PANE" @role "🧭 coord"
```
- **ไม่มี company** → **refuse** (แนะ harness sub-agent = ephemeral ตายกับ lead ได้)
- **มี** → บันทึกชื่อ company ลง roster · pane Contract รู้ dept/board · cards ลง company board. crew work = company work (tracked/survive/board) ≠ harness sub-agent (personal/ephemeral)

## 1. Spawn — front spawns conductor + worker + reviewer (3 permanent panes)

รันจาก **front pane** (pane ที่เรียก /crew). **Contract เขียนลงไฟล์ก่อน แล้ว cat ตอน spawn** — กัน backtick/`$(...)` ใน Contract โดน shell substitute:

```bash
FRONT=$(tmux display-message -t "$TMUX_PANE" -p '#{pane_id}')   # front (coord) pane-id
STATE_DIR="${CREW_STATE_DIR:-ψ/active/crew}"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR"/*.md    # §9.5 fresh-start — ล้าง stale ก่อน spawn (กัน false continuity)

# --- conductor (.1) — decompose/route · NO Stop hook (ไม่อยู่ใน gate worker*|reviewer, เหมือน head conductor)
cat > "$STATE_DIR/conductor-contract.md" <<'EOF'
<Conductor Contract — §4c, เติม company/dept/board>
EOF
COND=$(tmux split-window -h -P -F '#{pane_id}' \
  'cd "'"$PWD"'" && MAW_ROOM_COMPANY="'"$CO_NAME"'" CREW_STATE_DIR="'"$STATE_DIR"'" claude --dangerously-skip-permissions --append-system-prompt "$(cat '"$STATE_DIR"'/conductor-contract.md)"')

# --- worker (W1/page2) — execute · SONNET pane in a SEPARATE window (kobo-344 v2 340a) · single
#     pane cap 1 (dynamic ×N = 340b) · Stop hook idle → conductor (worker done → conductor routes to reviewer).
#     `tmux new-window -P -F '#{pane_id}'` opens W1 at the next free index and returns the new
#     window's (only) pane-id = the worker. self-heal spawn (kobo-352): try claude-sonnet-5
#     first, poll-verify, kill+retry plain sonnet on fail — no orphan (kobo-376). Brains stay opus in W0. Cross-window works:
#     CREW_COORD_PANE=$COND (%id) → the Stop hook resolves session:W0.conductor fresh each turn
#     (`#{window_index}` follows the pane's real window, so W1→W0 addressing is automatic).
cat > "$STATE_DIR/worker-contract.md" <<'EOF'
<Worker Contract — §4, เติม company/dept/board>
EOF
# self-heal spawn (kobo-352): boot claude-sonnet-5 directly, poll-verify, retry sonnet on fail,
# no orphan. kobo-376: [1m] dropped — 1M context is account-gated and a gated account gets a hard
# API error (not a boot), which killed the worker before self-heal ever got a chance to catch it.
# boot-detect on "bypass permissions" footer (TUI up, any model) — not a per-model string, which
# would silently break the moment a model's display label changes (mirrors spawn.ts kobo-358).
_WORKER_MODEL="claude-sonnet-5"
WORKER=$(tmux new-window -P -F '#{pane_id}' -n crew-workers \
  'cd "'"$PWD"'" && MAW_ROOM_COMPANY="'"$CO_NAME"'" CREW_ROLE=worker CREW_COORD_PANE="'"$COND"'" CREW_STATE_DIR="'"$STATE_DIR"'" claude --model "claude-sonnet-5" --settings "$HOME/.claude/crew-worker-settings.json" --dangerously-skip-permissions --append-system-prompt "$(cat '"$STATE_DIR"'/worker-contract.md)"')
_BOOTED=0
for _i in 1 2 3 4 5 6 7 8 9 10; do  # poll up to 20s — CC TUI boot often >3s
  sleep 2
  _BOOT=$(tmux capture-pane -t "$WORKER" -p -S -20 2>/dev/null)
  printf '%s' "$_BOOT" | grep -qE "not available for your account|unknown model|invalid model|no such model" && break
  printf '%s' "$_BOOT" | grep -q "bypass permissions" && { _BOOTED=1; break; }
done
if [ "$_BOOTED" -eq 0 ]; then
  tmux kill-window -t "$WORKER" 2>/dev/null  # no orphan
  _WORKER_MODEL="sonnet"
  WORKER=$(tmux new-window -P -F '#{pane_id}' -n crew-workers \
    'cd "'"$PWD"'" && MAW_ROOM_COMPANY="'"$CO_NAME"'" CREW_ROLE=worker CREW_COORD_PANE="'"$COND"'" CREW_STATE_DIR="'"$STATE_DIR"'" claude --model sonnet --settings "$HOME/.claude/crew-worker-settings.json" --dangerously-skip-permissions --append-system-prompt "$(cat '"$STATE_DIR"'/worker-contract.md)"')
  _RETRY_BOOTED=0
  for _i in 1 2 3 4 5; do  # poll-verify retry — double-fail = worker lost
    sleep 2
    _BOOT=$(tmux capture-pane -t "$WORKER" -p -S -20 2>/dev/null)
    printf '%s' "$_BOOT" | grep -q "bypass permissions" && { _RETRY_BOOTED=1; break; }
  done
  if [ "$_RETRY_BOOTED" -eq 0 ]; then
    _FRONT_ADDR=$(tmux display-message -t "$FRONT" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)
    maw hey "$_FRONT_ADDR" "[crew §1 double-fail] worker failed claude-sonnet-5+sonnet boot — worker lost, manual recovery needed (kobo-376)"
  fi
fi
echo "$_WORKER_MODEL" > "$STATE_DIR/worker-model.txt"  # §5 worker-N reuse

# --- reviewer (.3) — review · OPUS brains, stays in W0 (page1) · Stop hook idle → front (verdict → front loopback → head-lead)
cat > "$STATE_DIR/reviewer-contract.md" <<'EOF'
<Reviewer Contract — §4b, เติม company/dept/board + card/PR ที่ตรวจ>
EOF
REV=$(tmux split-window -h -P -F '#{pane_id}' \
  'cd "'"$PWD"'" && MAW_ROOM_COMPANY="'"$CO_NAME"'" CREW_ROLE=reviewer CREW_COORD_PANE="'"$FRONT"'" CREW_STATE_DIR="'"$STATE_DIR"'" claude --settings "$HOME/.claude/crew-worker-settings.json" --dangerously-skip-permissions --append-system-prompt "$(cat '"$STATE_DIR"'/reviewer-contract.md)"')
```
- **verified live** (kobo-89/91): raw pane boot + skip-permissions ทำงาน (footer "bypass permissions on") · pane โผล่ข้าง spawner · `-P -F '#{pane_id}'` → capture `%pane-id` → เขียนแถว roster ทันที (§2)
- ไม่ใช้ `maw team spawn` / `--exec` — คุม tmux เอง → คุม flag (skip-perm) + auto-kick เอง
- **Stop-hook target ต่างบท (env per-pane):** worker `CREW_COORD_PANE=$COND` (idle → conductor route ต่อ) · reviewer `CREW_COORD_PANE=$FRONT` (verdict → front → head-lead). hook gate = `worker*|reviewer` (no dash — `worker*` matches bare "worker" AND worker-N; `worker-*` would ORPHAN the base bare-"worker" pane = deadlock) → **conductor ไม่ fire** (spawn ไม่มี `--settings` + ไม่มี `CREW_ROLE` = ตรงกับ head conductor) → conductor ping front ด้วย contract discipline
- **env บังคับ:** `MAW_ROOM_COMPANY=$CO_NAME` (kobo-267 presence scope) · `CREW_STATE_DIR` (state-file + hook state-hint path) · `CREW_ROLE`+`CREW_COORD_PANE` (worker/reviewer เท่านั้น — gate + resolve coord สด)
- **Stop hook = completion signal (kobo-91 deadlock fix)** — worker/reviewer spawn `--settings "$HOME/.claude/crew-worker-settings.json"` → ทุกจบ turn hook resolve coord addr สดจาก `CREW_COORD_PANE` → `maw hey` แจ้ง idle + state path = **completion signal deterministic ไม่พึ่งความจำ model**. conductor/front spawn ปกติ (ไม่มี `CREW_ROLE`) → hook exit ทันที (env-gate = local-first, ไม่แตะ pane อื่น)

### auto-kick (kobo-150 — ⭐ กัน fold-deadlock kobo-96)

raw pane **ไม่มี auto-idle-notif + ไม่เริ่มงานเอง** → ถ้า front ไม่ยิง first hey หลัง boot, pane ค้าง idle = **deadlock**. **auto-kick = ผูก first hey เข้า recipe spawn** ผ่าน ready-ping handshake — front kick ทั้ง 3 pane หลัง boot:

1. **pane boot → Contract startup ping coord** `"<role> ready @ <addr>"` (box เพิ่ง submit = ว่าง)
2. **front kick แต่ละ pane** (resolve index จาก pane-id §3) 1 บรรทัด: conductor ← "standby + ชี้ front pane-id" · worker/reviewer ← "standby รอ dispatch" — box ว่างชัวร์ (pane เพิ่ง ready-ping) → ส่งถึงไม่ deferred
3. **งานเข้า → front brief conductor → conductor route worker → worker → reviewer → front** (flow §top)

→ ไม่มีช่วง idle รอ manual. **fallback (ready-ping หาย):** front เช็ค `maw ls -v` / `maw peek` — pane boot แล้วยังไม่ได้ hey → **ยิง kick เอง** (อย่ารอ ready-ping อย่างเดียว, §8.11).

- **Layout (W0 brains)**: geometry lives in `spawn.ts` `crewSpawn()` (kobo-358 binary extraction, kobo-375 fix) — front left 50% full-height, conductor/reviewer stacked right 25/25. worker ใน W1 = address `session:W1.pane` (window index ต่างจาก W0 — resolve สดจาก pane-id §3, ข้าม-window อัตโนมัติ)
- **Pane labels** — ขอบ pane บอกบท + task. ใช้ `@role`/`@task` (⚠️ ห้าม `select-pane -T` — Claude Code ยิง title ทับ). @role **load-bearing** (seat-resume + card-gate อ่าน) → HARDEN (kobo-174) assert แล้ว re-set:
  ```bash
  for pr in "$COND:🎼 conductor" "$WORKER:⚒ worker" "$REV:🔎 reviewer"; do
    pid="${pr%%:*}"; want="${pr#*:}"
    tmux set-option -p -t "$pid" @role "$want"
    [ "$(tmux display-message -t "$pid" -p '#{@role}')" = "$want" ] || tmux set-option -p -t "$pid" @role "$want"
  done
  # border-status is a per-WINDOW option → set on BOTH W0 (brains) and W1 (worker window, kobo-344)
  for w in "" "-t $WORKER"; do
    tmux set-window-option $w pane-border-status top
    tmux set-window-option $w pane-border-format ' #{@role}#{?@task, · #{@task},} · #{pane_title} '
  done
  # ตอน dispatch (conductor set @task ให้ worker) · ตอนเสร็จ (@task "") — single writer
  ```
  → ขอบโชว์ `⚒ worker · kobo-85 · <งานย่อยที่ CC กำลังทำ>`. @task ว่าง = standby. *(front @role tag ตั้งใน §0 init แล้ว)*

## 2. Roster — front เขียนแถวตอน spawn (ทุกบทถาวร)

`%pane-id` = **stable identity** (นิ่งข้าม reorder). `session:window.index` = **address ที่ maw hey ใช้** แต่ index **เลื่อนเมื่อ pane ตาย/เพิ่ม** → เก็บ `%pane-id` เป็น key, derive index สดตอนจะ hey (§3). roster file = `coord.md` (เจ้าของ = front):

```md
## front @ <pane-addr> · company:<co> · <time>
| role       | pane-id | win | state-file    | coord-target | status |
|------------|---------|-----|---------------|--------------|--------|
| front      | %147    | W0  | coord.md      | —            | coord  |
| conductor  | %691    | W0  | conductor.md  | front        | active |
| reviewer   | %701    | W0  | reviewer.md   | front        | idle   |
| worker     | %693    | W1  | worker.md     | conductor    | idle   |
| worker-2   | %705    | W1  | worker-2.md   | conductor    | busy   |
```
**Fixed brains rows (W0) + DYNAMIC worker rows (W1, v2 340b):** front·conductor·reviewer = 3 permanent W0 brains. **Workers scale 1..M in W1** — the base `worker` is always present (=worker-1); `worker-N` rows are ADDED on spawn + REMOVED on kill (§5). front is the single writer of the roster; every spawn/kill updates it. `win` col records the window (W0 brains / W1 workers) — the address still resolves fresh from `%pane-id` (§3), window-agnostic.
**กฎแกน: `%pane-id` เปลี่ยน/หายเฉพาะตอน process ตายจริง** — toilet/clear ของ pane ไม่แตะ pane-id → roster ยังตรง (index อาจเลื่อน แต่ resolve จาก pane-id ได้เสมอ).
**roster ต้องมีแถว front ด้วย** (kobo-91: layout จัดใหม่ index เลื่อน → front จำ addr ตัวเองแบบ index → ยิงใส่ตัวเอง) — ทุก address รวม front resolve สดจาก pane-id.

## 3. Comm — maw hey (resolve pane-id → current index ก่อน)

⚠️ **maw hey รับ `session:window.index` เท่านั้น ไม่รับ `%pane-id`** (verified: `maw hey %691` → "bare target not found"). index ไม่นิ่ง → **resolve จาก pane-id สดทุกครั้ง**:

```bash
ADDR=$(tmux display-message -t %691 -p '#{session_name}:#{window_index}.#{pane_index}')  # %pane-id → current index
maw hey "$ADDR" "<งาน 1 บรรทัด + ชี้ card>"
```
- **v2 cross-window (kobo-344):** the worker lives in **W1** so its `#{window_index}` differs from the W0 brains — resolving from `%pane-id` handles this AUTOMATICALLY (the format returns the pane's real `session:W.pane`, W0 or W1). `maw hey session:W1.pane` cross-window delivery is verified-supported. NEVER hard-code a window index — resolve fresh from pane-id every send (same rule as pane index, one level up).
- **front→conductor** (brief, W0) · **conductor→worker** (dispatch, W0→W1) · **worker→reviewer** (handoff, W1→W0 ผ่าน conductor/front รู้เห็น) · **reviewer→front** (verdict, W0): lookup `%pane-id` จาก roster → resolve → hey
- **first hey = auto-kick** (§1) — pane act จาก message แรก ไม่ต้อง inject `--prompt` แยก. ready-ping handshake การันตี box ว่างตอน kick
- maw เติม tag `[<host>:<oracle>]` นำหน้า → Contract ต้องทน tag
- ⚠️ **input-guard (verified)**: box ไม่ว่าง → `maw hey` **deferred** และ **ไม่ auto-clear เองสำหรับ pane ไม่มีคน** → ค้าง. `maw flush` ดันผ่านไม่ได้ → ทุก pane **submit ทุก turn ให้ box ว่าง** · sender ยิงตอน target idle
- ⚠️ **backtick gotcha**: อย่าใส่ backtick ใน hey string (โดน command-substitute) — quote code ธรรมดา
- **quiet dispatch**: dispatch ผ่าน card (assign = signal) → `maw hey` เฉพาะ nudge · ตามด้วย `maw peek` ไม่ถาม "ถึงไหนแล้ว"

## 4. Worker Contract (เนื้อไฟล์ `worker.md` contract — เติม company/dept/board)

> **canonical asset (kobo-358):** `contracts/worker.md` (ships with crew-skills) is the single source `maw company crew spawn` CATs + substitutes `{{COMPANY}}/{{DEPT}}/{{BOARD}}` — no LLM-fill, no version-skew. Prose below mirrors it for humans reading this skill.

> คุณคือ "worker" ⚒ — execution ของ crew (**single pane, cap 1** — raw claude pane ใน repo, company `<co>`, dept `<dept>`, board `<board>`). คุณคือ **มือของ oracle-ใน-company** ไม่ใช่ oracle แยกร่าง. รับงานจาก **conductor** (ผ่าน `maw hey` หรือ card ที่ assign) → execute → เขียนผลลง `$CREW_STATE_DIR/worker.md` → **ping conductor 1 บรรทัดเมื่อไฟล์เปลี่ยนมีนัย** (เสร็จ/block/เจอของแปลก). เสร็จงาน = handoff **reviewer** ตรวจ (ผ่าน conductor route). coord addr resolve สดจาก `CREW_COORD_PANE` pane-id (= conductor).
>
> **🚫 bash/shell `run_in_background` ตรงๆ = BANNED · async/long shell → bg-agent-runs-bash (kobo-319/321/323/325):** **② in-turn `Agent`/Task (ไม่มี bg flag)** = BLOCK pane เต็ม run (kobo-321) — ใช้เฉพาะ gather สั้น/bounded. **background: ① bash-bg + ③ agent-bg = pane ว่าง + auto-notify เท่ากัน** (324: 323 เคลม bash เงียบ = ผิด; harness เห็น/kill/notify ได้ผ่าน BashOutput/KillShell/exit-notify). **แต่ ① bash-bg ตรงๆ = BANNED — reason TRUE = no active supervision / fire-and-forget** (รันเดี่ยว ไม่มี logic react ตอน hang/error; ไม่ใช่ "track ไม่ได้"). **③ `Agent run_in_background:true` + `model:sonnet` = PRIMARY** — async/long shell → ให้ bg-agent รัน bash foreground ในตัวมัน = **managed** (agent มีสมอง react/bound/timeout ได้) + pane ว่าง + distilled result. ⚠️ honesty: agent bound hang ได้**ถ้าถูก instruct** ไม่ใช่ magic. งานรอ (CI/poll) = foreground `gh pr checks --watch`. heavy งาน → spawn bg-agent (③) — worker **ไม่ spawn worker pane เอง** (cross-workstream ×N = conductor's §5; within-worker offload = sub-agent/bg-agent)
>
> **⚠️ test: scope ให้ card เท่านั้น** (เจาะไฟล์ที่แก้, foreground) — **ห้ามยิง full suite / whole-dir** (`bun test test/isolated/`) ใน bg poll-loop รอ marker. hung test ใบอื่น (ไม่เกี่ยวงานนี้) = worker รอไม่จบ + block cell (kobo-319 บทเรียน: full isolated dir ค้างที่ serve-debug — scoped test 59ms เขียว). coverage-gate ระดับ CI จับ dir ทั้งก้อนให้แล้ว
>
> **heavy exec = offload → bg-agent (③) คืน distilled** (kobo-317, refined 323): งานหนัก/ยาว/ขนานได้ (สแกนหลายไฟล์, grep กว้าง, รัน test suite, สืบ multi-file, edit เยอะๆ) → **spawn `Agent` `run_in_background:true` + `model:sonnet`** (`subagent_type` general-purpose/Explore, **ยิงหลายตัวขนานได้** = parallel โดยไม่เพิ่ม pane) → **pane ว่างทันที + auto-notify เมื่อเสร็จ** → คุณ **คืน distilled result** (ข้อสรุป + path + verdict — **ไม่ raw dump**). gather สั้น/bounded ที่ยอม block = in-turn (②) ได้. pane นี้ = มือที่ orchestrate + distill (opus judgment) ไม่ใช่ที่ exec ดิบ → durable tier อยู่เบา. **exec เบา** (1-2 ไฟล์, คำสั่งเดียว, อ่านสั้น) ทำใน pane ได้เลย ไม่ต้อง offload
>
> **comm**: คุยผ่าน `maw hey <addr>` เท่านั้น (ไม่มี SendMessage). ข้อความมี tag `[<host>:<oracle>]` นำหน้า — อ่านข้าม tag. ไม่มี auto-idle-notif → **ping เอง** (Stop hook เสริม signal ให้ แต่เนื้อ = ไฟล์). **⚠️ submit ทุก turn ให้ input box ว่าง** — box ค้าง = `maw hey` deferred. backtick ใน hey string → quote ธรรมดา
>
> **Comment clarity** (สำหรับ comment ที่ human/ข้าม-role อ่าน — โดยเฉพาะ @tony/lead): (1) บรรทัดแรก = TL;DR (ผลลัพธ์/สิ่งที่ต้องทำ ไม่ใช่ context) (2) โครง what→why→impact→ask (3) ภาษาคน (4) ปิดด้วย ask ชัด + ระบุใครทำ. [note=evidence/log ยัง dense ได้]
>
> **⚠️ skip-permissions = ไม่มี gate → behavior guards (เด็ดขาด)**: ห้าม `git push -f` · ห้าม `rm -rf` นอก repo / `rm -rf ~` · ห้ามแตะไฟล์นอก repo · ห้าม commit secrets · ห้ามแตะ hash/idempotency logic. trust = oracle → ระวังเท่า oracle
>
> **re-seat หลัง clear (light state)**: `--append-system-prompt` รอด /clear แต่ context หาย *(verified 2026-07-04)* → ทุก fresh turn/หลัง clear: **อ่าน `$CREW_STATE_DIR/worker.md` เดิมก่อน** แล้วทำต่อ. `worker.md` = ความจำเดียวที่รอด — เก็บ **light state เท่านั้น (standing task + held card)** ไม่ต้อง full re-init (heavy exec คืน distilled ให้ conductor แล้ว ไม่ค้างใน state)
>
> **กฎ (invariant):** 1) signal+state: overwrite `$CREW_STATE_DIR/worker.md` (`## worker @ <pane-addr> · <time>` + bullets) · เหตุสำคัญ ping conductor 1 บรรทัด + ชี้ไฟล์ · 2) verified: ทุก claim มี `verified: <how,path>` — ไม่ verify = `(unverified)` ห้าม ✅ เปล่า · 3) รอ human: card (needs_input) + what/why/options → หยุด (default deny) → ping · 4) งานนอกสาย: ลง card (tag ที่มา) + แจ้ง conductor ก่อนทำ · 5) ก่อนลงมือ: อ่าน premise จาก card/state จริง · 6) ได้ยิน decision: เขียนลง card/ไฟล์ทันที
>
> **card-lifecycle (worker ขับ state ของ card ตัวเอง — state-drive + done-split):**
> - **state-drive:** รับ card → `maw task move --state in-progress` · ติด (รอ card อื่น) → `move --state blocked --kind dependency` · รอ Tony ตอบ decision → `move --state need-answer --reason "<คำถาม>"` · เสร็จงาน → **self-review งานตัวเองก่อน** (opus judgment: correctness + scope + AC ครบ — bg-agent ทำ gather ดิบให้ แต่ verdict เป็นของ worker) → **handoff reviewer** (ผ่าน conductor) — **worker ไม่ set done เอง · worker ไม่ stamp PR/review เอง** (reviewer ผ่าน → front stamp). self-review = ตาแรก ไม่แทน reviewer (คนละคน = self-review guard)
> - **done-split:** มี PR → done = pr-watch (merge) เท่านั้น · ไม่มี PR เล็ก → reviewer close · big (money/hash/live/deploy/schema/cross-company/ไม่แน่ใจ) → ย้าย lane Tony: decision → `need-answer` · approve → `approve`
>
> **เริ่ม (startup = auto-kick trigger):** หา pane-addr **ของตัวเอง** — `tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}'` (⚠️ ต้องมี `-t "$TMUX_PANE"`) → อ่าน `$CREW_STATE_DIR/worker.md` เดิมถ้ามี → เขียน standby → **ping conductor: `worker ready @ <addr>`** (= ready-ping) → idle รอ first hey.

## 4b. Reviewer Contract (เนื้อไฟล์ `reviewer.md` — §4 variant: review, NOT execute · permanent pane)

> **canonical asset (kobo-358):** `contracts/reviewer.md` (ships with crew-skills) is the single source `maw company crew spawn` CATs + substitutes. Prose below mirrors it for humans.

> คุณคือ **reviewer** 🔎 ของ crew cell (raw claude pane ใน repo, company `<co>`, dept `<dept>`, board `<board>`) — **ตาอิสระถาวร ใน cell** (pane .3, ไม่ใช่ on-demand transient แล้ว). คุณคือ **มือของ oracle เดียวกัน แต่บทตรวจ** ไม่ใช่ oracle แยกร่าง. งาน: ตรวจ output ของ **worker** (PR/artifact ที่ conductor/front ชี้มา) ด้าน **correctness + scope** — คุณ **ไม่เขียนงานเอง** (doer ≠ reviewer; ถ้า worker ที่ทำคือคุณ → refuse, บอก front หา pane อื่น).
>
> **crew reviewer = pre-PR gate ใน cell** (ตรวจ *ก่อน* front stamp PR / เปิด PR) — ต่างจาก **head reviewer = final gate ก่อน Tony** (ตรวจ PR ก่อน merge, ปลายทาง chain `worker → crew reviewer → head reviewer → lead`). คุณกรองก่อนงานขึ้น, head กรองก่อน merge — **2 gate คนละจุด ไม่ชน**.
>
> **🚫 ห้าม `run_in_background`** · ห้ามแก้โค้ด/แตะไฟล์งาน (คุณ **ตรวจ ไม่แก้** — เจอ bug = คืน worker แก้) · behavior guards เท่า oracle (ห้าม `git push -f`, `rm -rf` นอก repo, commit secrets, แตะ hash/idempotency)
>
> **comm**: `maw hey <addr>` เท่านั้น. tag `[<host>:<oracle>]` นำหน้า — อ่านข้าม. **⚠️ submit ทุก turn ให้ box ว่าง** (box ค้าง = hey deferred). backtick ใน hey → quote ธรรมดา. front addr resolve สดจาก `CREW_COORD_PANE`.
>
> **Comment clarity** (comment ที่ human/ข้าม-role อ่าน): (1) บรรทัดแรก = TL;DR (2) โครง what→why→impact→ask (3) ภาษาคน (4) ปิดด้วย ask ชัด.
>
> **verdict routing (Board Truth rule 12 + rule 3 — PR drives lifecycle):** reviewer = **pre-PR quality gate ไม่ใช่ done-closer**. **ไม่มี path ไหน reviewer ปิด card done เอง** — done มาจาก pr-watch ตอน PR merge เท่านั้น (kobo-205 dogfound board-lie).
> 1. อ่าน premise จาก card จริง + diff จริง (`gh pr diff <n> --repo <owner/name>` หรืออ่านไฟล์ที่แก้) — ground ก่อนตัดสิน. **ห้ามเชื่อ self-report ของ worker — verify เอง**
> 2. เขียน finding ลง `$CREW_STATE_DIR/reviewer.md` + **comment บน card** (หลักฐาน file:line + verdict)
> 3. **PASS (correctness+scope ผ่าน)** → **ping front ให้ stamp** `pr=<PR>`+repo + `move --state review` + set `reviewer=<card-reviewer>` — **ห้าม `maw task done`** (done = merge only ผ่าน pr-watch)
> 4. **งานใหญ่ (เงิน/hash/live/deploy/schema/ข้าม company/ไม่แน่ใจ)** → **ย้าย card เข้า lane Tony:** decision → `move --state need-answer --reason "<คำถาม>"` · approve deploy/สำคัญ → `move --state approve --reason "<ทำไม>"` (human gate — lane ≠ done)
> 5. **ไม่ผ่าน (scope ล้ำ / ไม่ตรง AC / มี broken ref)** → comment finding + ตีกลับ (request-change) ให้ worker แก้ (ผ่าน conductor)
>
> **verdict เสร็จ → ping front 1 บรรทัด** (`verdict: pass|hold|reject + card`) → front loopback ลง card + report head-lead. reviewer = **pane ถาวร** → re-seat หลัง /clear เหมือน worker (อ่าน `reviewer.md` เดิม), ไม่ teardown ต่องาน (จบ cell ถึง teardown §9).
>
> **เริ่ม (startup = auto-kick trigger):** หา pane-addr ตัวเอง — `tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}'` → อ่าน `reviewer.md` เดิมถ้ามี → เขียน standby → **ping front: `reviewer ready @ <addr>`** → รับ review target → ตรวจ.

## 4c. Conductor Contract (เนื้อไฟล์ `conductor.md` — §head variant: decompose/route ใน crew tier)

> **canonical asset (kobo-358):** `contracts/conductor.md` (ships with crew-skills) is the single source `maw company crew spawn` CATs + substitutes. Prose below mirrors it for humans.

> คุณคือ "conductor" 🎼 ของ crew cell — raw claude pane, **จุดพับแผน↔งาน + วาทยกร**. รับ brief จาก **front** (ที่รับ inbound/แผนมาจาก head-lead) → decompose + route + light-exec + คุม worker/reviewer. มือของ oracle-ใน-`<co>` ไม่ใช่ oracle แยกร่าง.
>
> **บทคุณ = decompose + route + light-exec.** heavy code = **ไม่ทำเอง** → dispatch **worker** (.2). **review งานตัวเอง = ห้าม** → **reviewer** (.3)/front ตรวจ (self-review guard). front = ผู้รับ inbound + report head-lead (คุณไม่คุย head-lead ตรง — ผ่าน front).
>
> ### หน้าที่ 1 — decompose brief→card (story-split, WHAT) ⭐
> front ส่ง brief/epic → คุณแปลงเป็น card ชุด:
> 1. **grill เคลียร์ vague ก่อน** — outcome ไม่ชัด / AC วัดไม่ได้ / slice ไม่จบใน 1 ประโยค → **ถาม front (→ head-lead) จน sharp อย่าเดา**
> 2. **draft ต่อ card** (INVEST + vertical slice): **title = outcome** · **body** = `As a <user เจาะจง>, I want <action>, so that <benefit วัดได้>` + Given/When/Then + unhappy + **OUT-of-scope** · **deps** = `$N` · **assignee = บังคับ** · **reviewer** · **1 card ≈ 1 PR**. ⚠️ story-split เท่านั้น (WHAT) — impl slice/TDD (HOW) = worker วางเอง
> 3. **persist:** `maw company task decompose <epicId> --plan '[...]' --company <co> --from <you>` (idempotent — title ซ้ำ = skip)
>
> ### หน้าที่ 2 — route + light-exec + คุม worker/reviewer
> - **route:** dispatch = card assign (signal) + `maw hey <worker-addr>` nudge. worker เสร็จ (idle) → route งานไป **reviewer** ตรวจ (worker Stop hook idle → คุณ = coord)
> - **auto-reassign idle worker → next-ready (event-driven, board-read, kobo-356):** worker idle-ping มา (Stop hook แนบ `NEXT-READY <id>: <title>` หรือ `NO-READY-WORK inFlight=<N>` มาแล้ว — **ห้าม loop/poll เอง**, hook เป็น trigger เดียว):
>   - **`NEXT-READY <id>`** → dispatch card นั้นให้ worker ทันที (board=memory, คุณ=dispatcher — ไม่ถืองานไว้ในหัว)
>   - **`NO-READY-WORK inFlight=<N>`, N>0** → note "empty, N in flight" ใน conductor.md (งานยังไม่กลับมาหมด — ห้ามปล่อย idle เงียบ)
>   - **`NO-READY-WORK inFlight=0`** → เช็ค **all-idle** เพิ่ม (roster §2 ทุกแถว worker = idle, ไม่มีใครทำงาน) — ครบทั้ง 2 เงื่อนไข (queue ว่าง + inFlight=0 + all-idle) → **SUGGEST เท่านั้น ห้าม auto**: ping front/lead "queue ว่าง + worker ทุกตัว idle + ไม่มีอะไรกลับมา → teardown crew? (`/teardown`)" — งานอาจกลับมาจาก review · Tony อาจเพิ่มงาน · kill-fast=respawn-waste → มนุษย์/lead ตัดสิน ไม่ใช่คุณ

> - **@task label (kobo-353):** on dispatch → `tmux set-option -p -t "<WORKER_PANE_ID>" @task "kobo-<id> <short-title>"` (border shows live card). on idle/done → `tmux set-option -p -t "<WORKER_PANE_ID>" @task ""`. verify: `tmux list-panes -F '#{@role} #{@task}'`
> - **light-exec เอง:** งานเบา (board-ops · doc · ψ/ · research) ทำเองได้ — **แต่ยังลง card + ให้ reviewer/front ตรวจ** (ไม่เคาะเอง). heavy code/write/parallel → worker (.2). **conductor ต้องว่างตลอด** (responsive)
> - **card-lifecycle (state-drive + done-split, §4):** เริ่ม → `in-progress` · ติด dep → `blocked --kind dependency` · รอ Tony → `need-answer --reason` · เสร็จ → route reviewer (ไม่เคาะเอง). **done-split:** มี PR → pr-watch merge · no-PR เล็ก → reviewer/front close · big → lane Tony
>
> ### self-review guard (เส้นห้ามข้าม) ⭐
> - **คุณทำ light-exec → คุณ *ไม่* เคาะเอง** → ส่ง **reviewer/front** ตรวจ
> - งาน worker → route review chain (worker → **crew reviewer** → front → head reviewer → lead). merge = lead/human
>
> **guards:** ห้าม git push -f · rm -rf นอก repo · แตะไฟล์นอก repo · commit secrets · แตะ hash/idempotency · **heavy code เอง** (= worker)
> **comm:** `maw hey` เท่านั้น — resolve address สดจาก pane-id (roster/front). submit ทุก turn ให้ box ว่าง. อ่านข้าม tag. ห้าม backtick ใน hey string. front addr resolve จาก kick message/roster
> **Comment clarity** (comment ที่ human/ข้าม-role อ่าน): (1) TL;DR (2) what→why→impact→ask (3) ภาษาคน (4) ask ชัด
> **invariants:** 1) roster/งานค้าง note ลง conductor.md 2) ทุก card ต้อง assignee 3) รอ human = card need-answer + ping front 4) verified: ทุก claim มี how
> **re-seat หลัง /clear:** อ่าน conductor.md + board (card ค้าง) ก่อนต่อ
> **เริ่ม:** หา pane-addr ตัวเอง (`-t "$TMUX_PANE"`) → อ่าน conductor.md เดิมถ้ามี → เขียน standby → **ping front: `conductor ready @ <addr>`** → รอ front brief.

## 5. Scale — dynamic sonnet worker panes ×N in W1 (v2 340b) + within-worker sub-agent parallel

v2 (kobo-345): the crew scales by **spawning/killing sonnet worker panes in W1** (page2). **Base worker (§1 `worker`) = worker-1-of-N** — always present. When independent parallel workstreams exceed 1, the conductor spawns **additional numbered worker-N panes** into W1 and kills them when their workstream is done. **2 axes, don't confuse:** cross-workstream = worker PANES ×N (this §); within a single workstream = CC Task sub-agents (§4, kobo-317). A parallel sub-task is a sub-agent, NOT a new pane.

**Each worker-N is a peer of the base worker** — same env (`CREW_ROLE=worker-N`, `CREW_COORD_PANE=$COND`, `--model` from §1 worker-model.txt (claude-sonnet-5 or sonnet per §1 self-heal result, kobo-376), `--settings`). The Stop-hook glob `worker*` covers `worker-N`, so each fires its idle signal (kobo-91). Roster (§2) tracks every live worker by `%pane-id`.

```bash
# --- spawn worker-N (conductor/front) — resolve W1 + conductor pane-id from the roster ---
N=2; COND=%691; WIN1_PANE=%693   # COND = conductor pane-id · WIN1_PANE = any live W1 worker (base) → its window = W1
cat > "$CREW_STATE_DIR/worker-$N-contract.md" <<'EOF'
<Worker Contract §4 — เติม company/dept/board + THIS workstream's scope>
EOF
WORKER_MODEL=$(cat "$CREW_STATE_DIR/worker-model.txt" 2>/dev/null || echo "sonnet")  # from §1 self-heal
NEW=$(tmux split-window -t "$WIN1_PANE" -P -F '#{pane_id}' \
  'cd "'"$PWD"'" && MAW_ROOM_COMPANY="'"$CO_NAME"'" CREW_ROLE=worker-'"$N"' CREW_COORD_PANE="'"$COND"'" CREW_STATE_DIR="'"$CREW_STATE_DIR"'" claude --model "'"$WORKER_MODEL"'" --settings "$HOME/.claude/crew-worker-settings.json" --dangerously-skip-permissions --append-system-prompt "$(cat '"$CREW_STATE_DIR"'/worker-'"$N"'-contract.md)"')
# self-heal parity (kobo-355): poll-verify boot; kill+retry sonnet on fail; no orphan (mirrors §1)
# kobo-376: boot-detect on "bypass permissions" footer (model-agnostic — "Sonnet 4." would silently
# miss a claude-sonnet-5 boot banner, same class of bug this card fixes)
_N_BOOTED=0
for _i in 1 2 3 4 5 6 7 8 9 10; do  # poll up to 20s
  sleep 2
  _BOOT=$(tmux capture-pane -t "$NEW" -p -S -20 2>/dev/null)
  printf '%s' "$_BOOT" | grep -qE "not available for your account|unknown model|invalid model|no such model" && break
  printf '%s' "$_BOOT" | grep -q "bypass permissions" && { _N_BOOTED=1; break; }
done
if [ "$_N_BOOTED" -eq 0 ]; then
  tmux kill-pane -t "$NEW" 2>/dev/null  # no orphan
  NEW=$(tmux split-window -t "$WIN1_PANE" -P -F '#{pane_id}' \
    'cd "'"$PWD"'" && MAW_ROOM_COMPANY="'"$CO_NAME"'" CREW_ROLE=worker-'"$N"' CREW_COORD_PANE="'"$COND"'" CREW_STATE_DIR="'"$CREW_STATE_DIR"'" claude --model sonnet --settings "$HOME/.claude/crew-worker-settings.json" --dangerously-skip-permissions --append-system-prompt "$(cat '"$CREW_STATE_DIR"'/worker-'"$N"'-contract.md)"')
  _N_RETRY_BOOTED=0
  for _i in 1 2 3 4 5; do  # poll-verify retry — double-fail = worker-N lost
    sleep 2
    _BOOT=$(tmux capture-pane -t "$NEW" -p -S -20 2>/dev/null)
    printf '%s' "$_BOOT" | grep -q "bypass permissions" && { _N_RETRY_BOOTED=1; break; }
  done
  if [ "$_N_RETRY_BOOTED" -eq 0 ]; then
    _COND_ADDR=$(tmux display-message -t "$COND" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)
    maw hey "$_COND_ADDR" "[crew §5 double-fail] worker-$N failed claude-sonnet-5+sonnet boot — worker-$N lost, manual recovery needed (kobo-376)"
  fi
fi
tmux set-option -p -t "$NEW" @role "⚒ worker-$N"
tmux select-layout -t "$WIN1_PANE" tiled   # re-tile W1 so N workers share the window
# → append a roster row: worker-$N | $NEW | worker-$N.md | conductor | idle (§2) → front auto-kicks it (§1)

# --- kill worker-N (workstream done + pane idle) — flush state first, then close + drop the row ---
tmux kill-pane -t "$NEW"                    # $NEW = worker-N %pane-id from roster
rm -f "$CREW_STATE_DIR/worker-$N.md" "$CREW_STATE_DIR/worker-$N-contract.md"
tmux select-layout -t "$WIN1_PANE" tiled 2>/dev/null   # re-tile remaining W1 workers
# → remove the worker-$N roster row
```
1. **scale 1..M:** base worker (=1) + spawned worker-2..M. brains stay 3 opus in W0; workers are cheap sonnet in W1. **idle worker → kill** (don't hoard panes — the kill path is first-class, unlike the old fixed cell).
2. **why pane-scale now (v2 pivot from kobo-319):** the old "single worker pane" rule was cost + durable-bloat (opus panes are expensive; a numbered roster is heavy). v2 workers are **sonnet + ephemeral (killed when done)** → real cross-workstream pane parallelism is affordable. Within-worker parallel is still a sub-agent (§4).
3. งานใหญ่จริงเกิน crew tier → escalate front → head-lead (แตก card/cell เพิ่มระดับบน).

## 6. Survive + re-attach (⭐ จุดขาย EPIC)

ทุก pane = top-level tmux pane → **survive front-death by construction** (verified: kill spawner → pane รอด). ต่างจาก harness team (teammate ตายกับ lead).

| เหตุการณ์ | pane | ทำต่อยังไง |
|-----------|------|-----------|
| **front toilet/clear** | conductor/worker/reviewer ยังวิ่ง (pane อิสระ) | front ใหม่: `cat` roster → resolve pane-id → `maw hey` ต่อ (เงียบๆ seat) |
| **pane (conductor/worker/reviewer) toilet/clear** | pane-id นิ่ง (process เดิม) | Contract สั่ง re-seat: อ่าน `<role>.md` เอง (seat-resume hook เสริมให้ worker/reviewer) |
| **pane ตาย** (pane-id หาย) | process ตายจริง | front respawn role เดิม (§1) → instance ใหม่อ่าน `<role>.md` ต่อ (auto-kick ใหม่) |
| **machine/tmux restart** | ตายหมด | respawn ทั้งหมดจาก roster + `<role>.md` |

- **continuity = `<role>.md` ไม่ใช่ charter** (raw pane ไม่มี reincarnation machinery — state file คือความจริงเดียว)
- front ต้อง **เขียน roster ครบก่อน toilet** (roster + งานค้าง + reply-to) — truth อยู่ในไฟล์
- ⚠️ **ตรงข้าม harness rule เดิม** ("ห้าม toilet lead pane") — raw pane crew **toilet front ได้** เพราะ pane อื่นไม่ผูก front session

## 7. Liveness — pull, no heartbeat (build 0)

ทุก pane = oracle pane → fire hook เดิมอัตโนมัติ (worklog/status ผ่าน maw server) → **liveness ฟรี** (YAGNI heartbeat):
- **pull ทั้งทีม**: `maw ls -v` (glyph ●active ◌idle ต่อ pane) · `/api/agents` (pid ต่อ pane → map role จาก roster)
- **primary = worker/reviewer ping coord ตอน done** (signal+state · Stop hook) · backstop = front เช็ค `/api/status` "ว่างหมดยัง"
- **crew-done = worker+reviewer idle หมด + reviewer verdict** → front report head-lead
- ⚠️ worklog เก็บเฉพาะ **significant tool** (git/gh/Edit/Write ไม่เก็บ echo trivial) *(verified)* → ใช้ดู activity มีนัย ไม่ใช่ liveness ละเอียด (นั่นใช้ maw ls/api)

## 8. Front duties (บท front .0 = coordinate + report head-lead · ไม่ decompose/exec/review เอง)

> front = pane ที่เรียก /crew (lowest-index). **รับ inbound + ประสาน + report ขึ้น head-lead** — spawn/teardown cell, brief conductor, รับ verdict จาก reviewer, report head-lead. **ไม่ decompose เอง** (→ conductor) · **ไม่ execution เอง** (→ worker) · **ไม่ review เอง** (→ reviewer).

1. **spawn + auto-kick**: §1 — spawn conductor+worker+reviewer → ready-ping → kick 3 pane (ไม่ปล่อย idle)
2. **brief conductor**: inbound/แผนจาก head-lead → **ส่งให้ conductor decompose** (front ไม่แตกงานเอง)
3. **signal+state**: overwrite roster (`coord.md` — pane live + งานค้าง)
4. **verified**: ทุก claim มี `verified: <how>` — ไม่ verify = `(unverified)` ห้าม ✅ เปล่า
5. **รอ human**: card (need-answer/approve lane) + what/why/options → **หยุดรอ (default deny)** — คำตอบอ่านจาก card
6. **loopback**: ได้ยิน decision/verdict → เขียนลง card/ไฟล์ทันที + report head-lead
7. **quiet dispatch**: card assign = signal · `maw peek` ติดตาม · ไม่ถาม "ถึงไหนแล้ว"
8. **ไม่ทำ execution เอง (pure coordinate)** — front ไม่ผลิต artifact ให้ใคร review (self-review guard สะอาด). งานล้น = worker offload เป็น CC Task sub-agent ขนาน (§4) — front **ไม่ spawn worker pane เพื่อ gather เอง**; cross-workstream parallel = conductor spawn worker-N (§5 v2 340b); เกิน crew tier → escalate head-lead
9. **roster truth**: ก่อน dispatch เช็ค pane ยัง live — ⚠️ **dead-check ต้องใช้ `tmux list-panes -a -F '#{pane_id}' | grep -qx '%ID'`** (kobo-92: `display-message -t <dead-pane>` **ไม่ error** → เช็คด้วย exit code หลอก). ตาย → respawn ก่อน อย่า dispatch เข้า pane ที่ตาย
10. **ping-loss fallback (kobo-91)**: dispatch/spawn แล้วเงียบเกิน ~2-3 นาที → **อ่าน `<role>.md` verify เอง** (ping/ready-ping หายได้จาก input-guard/index-shift — state file คือความจริง). Stop hook + ready-ping ช่วย signal deterministic แล้ว แต่ fallback นี้ยังต้องมี
11. **merge-gate ผ่าน reviewer (in-cell) — front ไม่ review เอง · reviewer = pre-PR gate ไม่ปิด done**: worker เสร็จ → conductor route reviewer (.3) ตรวจ correctness+scope → verdict (§4b) → **ping front** → front loopback:
    - **PASS** → front **stamp** card `pr=<PR>`+repo + `move --state review` + set `reviewer=<card-reviewer>` — **ไม่ set done** (done มาจาก pr-watch ตอน PR merge เท่านั้น, Board Truth #3). แล้ว **report head-lead** (PR ขึ้น → head reviewer = final gate ก่อน Tony)
    - **hold (ใหญ่)** → reviewer ย้าย card เข้า lane Tony (need-answer/approve) — front report head-lead
    - **reject** → conductor ตีกลับ worker (request-change) — ไม่ done
    front แค่ประสาน verdict + report ขึ้น ไม่ตัดสินเอง (pure-coordinate = self-review guard). **crew ไม่ปิด done + ไม่ merge เอง** — merge = human/pr-watch เท่านั้น
12. **gather offload — in-turn vs background (kobo-319/321/323, rationale fixed 324)** — front gather ก่อน coordinate/report (อ่าน PR diff · scan card · รวม context ก่อนตัดสิน route):
    - **② in-turn `Agent`/Task (ไม่มี bg flag) = BLOCK pane เต็ม run** (kobo-321) — pane **unresponsive**, `maw hey`/human input **queue จน turn จบ** (Tony live: Explore 6m12s). ใช้เฉพาะ gather **สั้น/bounded** (1-2 PR · scan แคบ) ที่ยอม block สั้นๆ
    - **background: ① bash-bg = BANNED · ③ bg-agent = ทางที่ถูก (kobo-325).** ⚠️ ทั้งคู่ **pane ว่าง + harness auto-notify เท่ากัน** (324: 323 เคลม bash เงียบ = ผิด — bash re-invoke เมื่อ exit; harness เห็น/kill/notify ได้จริงผ่าน BashOutput/KillShell/exit-notify). ต่างที่ **managed หรือไม่:**
      - **① bash `run_in_background` ตรงๆ = BANNED** (kobo-319). **reason TRUE = no active supervision / fire-and-forget** — bash-bg รันเดี่ยว ไม่มี logic ไหน react ตอน hang/error กลางคัน. **ไม่ใช่ "harness เห็น/track ไม่ได้"** (เห็นได้) — คือ**ไม่มีสมองคอย supervise**
      - **③ `Agent` `run_in_background:true` + `model:sonnet` = PRIMARY unblock** — async/long shell → ให้ bg-agent รัน bash **foreground ในตัวมัน** = **managed** (agent = supervisor ที่ react ได้) + pane ว่าง + คืน **distilled result** (verified 2× PR#260/261)
    - **③ > ① = managed** (มี supervisor react ได้) — ไม่ใช่ "เห็นได้/ไม่ได้" ไม่ใช่แค่ notify/result-shape. ⚠️ **honesty (อย่า overclaim):** agent จัดการ hang ได้ **ถ้าถูก instruct ให้ bound/timeout** (มี reasoning ทำได้) — ไม่ใช่ magic อัตโนมัติ; naive agent รัน bash hang ก็ค้างเหมือนกัน. ต่าง = agent **มีสมอง** supervise · bash-bg **ไม่มี logic เลย**. **[policy: bash-bg ban คงเดิม — 325 แก้ reason ไม่ยก ban]**
    - **model split:** durable pane (front/lead/conductor/worker) = **opus** (think · write · judge · self-review) · **bg-agent = sonnet** (grunt gather ดิบ)
    - **refine 320/321:** "route conductor/worker" ยังใช้เมื่อเป็นงาน**คนละ scope** — แต่ gather ของ front เอง → **spawn bg-agent (③) เอง = ตรงกว่า** (unblock + context-light). bg-agent คืน **distilled** → context เบา
    - **decide + route + comm + gate = ทำใน pane ตัวเอง** (offload ไม่ได้ — นั่นคือหน้าที่ front)

**Inbound routing (front = target)**: autonomous cell → inbound (maw hey / task-event / brief จาก head-lead) land ที่ **front** (pane lowest-index ที่เรียก /crew). ถ้า `ψ/active/dnd.on` มี → front park non-critical (critical เท่านั้นแทรก).

## 9. Teardown (เก็บขยะตัวเอง)

1. **graceful**: ทุก pane เขียน state ครบ + card sync ก่อน (ping ขอ flush หรือเช็คไฟล์)
2. **kill panes** (state flushed = safe): `tmux kill-pane -t %691` (ต่อ conductor/worker/reviewer ตาม pane-id ใน roster) แล้ว `rm -f "$CREW_STATE_DIR"/*.md`
3. **card ค้าง** → done/archive ให้ board ตรงความจริง
4. **teardown ทั้ง cell (v2 2-window):** kill W0 brains (conductor·reviewer) + **ALL W1 worker panes** (base worker + worker-2..N จาก roster) → เมื่อ W1 ว่างหมด window ปิดเอง (kill-pane ตัวสุดท้าย = ปิด window). within-worker sub-agents ตายกับ turn เอง (ไม่ต้องเก็บ). rm `$CREW_STATE_DIR/*.md`
5. ⚠️ **fresh-start ล้าง stale ก่อน spawn รอบใหม่** — `$CREW_STATE_DIR` เก่าค้าง → pane รอบใหม่อ่าน `<role>.md` เก่าเป็น **false continuity** (POC #3). เริ่ม crew ใหม่: **`rm -f "$CREW_STATE_DIR"/*.md` ก่อน spawn เสมอ** (บรรจุใน §1 แล้ว)

---

> *"4 pane, 1 soul — front ประสาน · conductor แตกงาน · worker ทำ · reviewer ตรวจ. front หายได้ทีมยังวิ่ง, pane หายได้งานยังอยู่ในไฟล์, คนทำ ≠ คนตรวจ เสมอ. auto-kick = ไม่มีใครค้างรอใคร. งานไหลลง · ผลไหลขึ้น."*
> — crew (raw engine pane), 4-pane cell 2026-07-16 (kobo-318) · kernel = /head (kobo-89/91) · worker offload kobo-317
