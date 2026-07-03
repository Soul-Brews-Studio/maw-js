---
name: crew
description: Spin up a crew — pane .0 = coordinator (session นี้) + worker panes 1-3 = raw claude panes (tmux split + --dangerously-skip-permissions). Worker = pane อิสระ → lead toilet/clear แล้ว worker ยังวิ่ง → lead ใหม่ cat coord.md → hey ต่อ. crew ต้องอยู่ใน company. Use when user says "/crew", "เรียก crew", "ขอ coordinator", or an oracle needs a work team.
---

# /crew — coordinator | worker ×N (raw engine pane)

```
┌────────────────┬────────────────┐
│ .0 coordinator │ .1 worker-1    │   ← tmux split 'claude --dangerously-skip-permissions --append-system-prompt "$(cat contract)"'
│ (session นี้)   ├────────────────┤
│ company ch. +  │ .2 worker-2    │   ← spawn เพิ่มเมื่องาน parallel
│ dispatch       ├────────────────┤
│                │ .3 worker-3    │   ← max 3 workers
└────────────────┴────────────────┘
```

**Model: N hands, 1 soul** — worker **ไม่ใช่ sub-oracle แยกร่าง** เป็น **eq3 คนเดียว แยก pane ทำงานขนาน**. worker = raw claude pane ใน repo eq3 → oracle resolve เป็น `eq3` อัตโนมัติ (hook key ด้วย session name) → **เสียบ infra ของ eq3 ฟรี** (worklog, status, liveness) โดยไม่ต่อท่อใหม่. *(verified 2026-07-04: raw-pane Bash/Edit logs เป็น oracle=eq3 เอง)*

- `.0 coordinator` = **session นี้เอง** (lead) — ถือช่องคุย company/federation (maw inbox/hey/board), แตกงาน, dispatch, spawn/ปลด worker, คุย human. **ไม่ทำ execution เอง**
- `.1–.3 worker-N` = execution — raw claude pane, 1 worker ต่อ 1 งาน. งาน parallel = spawn เพิ่ม (max 3)
- **🚫 ห้าม `run_in_background`** — งาน bg มองไม่เห็น ค้างไม่รู้. parallel = worker pane เพิ่ม (เห็นบน tmux). ยกเว้น watch เล็ก (รอ CI) รันใน pane ของ worker ที่ถืองานนั้น
- coord↔worker + worker↔worker คุยผ่าน **`maw hey <pane-addr>`**

**Signal+state: push the SIGNAL, pull the STATE** — worker เขียน state ลงไฟล์ + ping coordinator 1 บรรทัดเมื่อมีเหตุ. เนื้ออยู่ในไฟล์ (raw pane ไม่มี auto-idle-notif → signal+state คือกลไกเดียว).

Status dir: `ψ/active/crew/` (ephemeral, gitignored) — `coord.md` (roster) + `worker-1.md`, `worker-1-contract.md`, ...

## 0. Company-gate (crew ⊂ company)

`/crew` **resolve company ก่อนทุกอย่าง** — oracle นี้เป็นสมาชิก company ไหน (`~/.maw/companies/<co>.json` depts):

```bash
CO=$(grep -rl "\"$(tmux display-message -p '#{session_name}' | sed 's/^[0-9]*-//')\"" ~/.maw/companies/*.json 2>/dev/null | head -1)
[ -z "$CO" ] && echo "crew ต้องอยู่ใน company; นอก company ใช้ harness sub-agent (Agent tool) แทน" && exit
```
- **ไม่มี company** → **refuse** (แนะ harness sub-agent = ephemeral ตายกับ lead ได้)
- **มี** → บันทึกชื่อ company ลง coord.md · worker Contract รู้ dept/board · cards ลง company board. crew work = company work (tracked/survive/board) ≠ harness sub-agent (personal/ephemeral)

## 1. Spawn — raw tmux + claude (จาก coordinator pane)

รันจาก **coordinator pane นี้เอง** (worker split ข้างๆ). **Contract เขียนลงไฟล์ก่อน แล้ว cat ในตอน spawn** — กัน backtick/`$(...)` ใน Contract โดน shell substitute (M2):

```bash
mkdir -p ψ/active/crew
# 1) เขียน Contract ลงไฟล์ — heredoc delimiter 'EOF' (quoted) = ไม่ expand อะไรเลย
cat > ψ/active/crew/worker-1-contract.md <<'EOF'
<Worker Contract — ดู §4, แทน <N> ด้วย 1, เติม company/dept/board>
EOF
# 2) spawn — $(cat) รันใน shell ของ pane ใหม่ (single-quote outer) → Contract เป็น literal ไม่ถูก re-parse
#    COORD = pane-id ของ coordinator (tmux display-message -t "$TMUX_PANE" -p '#{pane_id}')
PANE=$(tmux split-window -h -P -F '#{pane_id}' \
  'cd "'"$PWD"'" && CREW_ROLE=worker-1 CREW_COORD_PANE="'"$COORD"'" claude --settings "$HOME/.claude/crew-worker-settings.json" --dangerously-skip-permissions --append-system-prompt "$(cat ψ/active/crew/worker-1-contract.md)"')
```
- **verified live**: raw pane boot + skip-permissions ทำงาน (footer "bypass permissions on") + รัน Bash ไม่ค้าง prompt · pane โผล่ข้าง spawner
- `-P -F '#{pane_id}'` → capture `%pane-id` → **เขียนแถว coord.md ทันที** (§2)
- ไม่ใช้ `maw team spawn` / `--exec` — คุม tmux เอง → คุม flag (skip-perm) + kick เอง (hey แรก)
- **Stop hook = completion signal (kobo-91 TEST2 deadlock fix)** — worker เท่านั้น spawn ด้วย `--settings "$HOME/.claude/crew-worker-settings.json"` (มี Stop hook `crew-worker-stop.sh` — global copy ติดตั้งโดย `maw crew-skills sync`) + env `CREW_ROLE=worker-N` `CREW_COORD_PANE=<coord pane-id>` → ทุกจบ turn hook resolve coord addr สดจาก pane-id → `maw hey` แจ้ง "worker-N idle" = **completion signal deterministic ไม่พึ่งความจำ model** (ping หาย → ทุกคน idle รอกันเป็นวง = deadlock ที่เจอจริง). coord/lead spawn ปกติ → hook ไม่โดนเลย (แยก settings > env-gate ใน shared)
- **Layout (canonical — Tony approved 2026-07-04)**: coordinator ซ้าย 50% เต็มสูง, workers stack แนวนอนขวา. รันหลัง pane ครบ (และรันซ้ำได้ทุกครั้งที่ spawn เพิ่ม):
  ```bash
  tmux swap-pane -s <coord-pane-id> -t "$(tmux display-message -p '#{session_name}:#{window_index}.0')" -d 2>/dev/null  # coord → main slot (ถ้ายังไม่ใช่ .0)
  tmux set-window-option main-pane-width 50%
  tmux select-layout main-vertical
  ```
  ⚠️ swap เปลี่ยน index แต่ **pane-id นิ่ง** → roster ไม่พัง (comm resolve index สดจาก pane-id อยู่แล้ว §3)
- **Pane labels (Tony approved 2026-07-04)** — ขอบ pane บอก **บท + task ที่กำลังทำ**. ใช้ `@role`/`@task` user options (⚠️ ห้ามใช้ `select-pane -T` — Claude Code ยิง title ทับตลอด):
  ```bash
  # ตอน spawn (ครั้งเดียวต่อ pane):
  tmux set-option -p -t "$PANE" @role "⚒ worker-1"
  tmux set-window-option pane-border-status top
  tmux set-window-option pane-border-format ' #{@role}#{?@task, · #{@task},} · #{pane_title} '
  # ตอน dispatch (coordinator set — single writer เดียวกับ roster):
  tmux set-option -p -t "$PANE" @task "kobo-85"
  # ตอนงานเสร็จ (coord รับ hook idle + verify แล้ว):
  tmux set-option -p -t "$PANE" @task ""
  ```
  → ขอบโชว์ `⚒ worker-1 · kobo-85 · <งานย่อยที่ CC กำลังทำ>` — เห็นทั้งบท/card/กิจกรรมสด. @task ว่าง = standby

## 2. Roster — coord.md (เขียนแถวตอน spawn)

`%pane-id` = **stable identity** (นิ่งข้าม reorder). `session:window.index` = **address ที่ maw hey ใช้** แต่ index **เลื่อนเมื่อ pane ตาย/เพิ่ม** → เก็บ `%pane-id` เป็น key, derive index สดตอนจะ hey (§3):

```md
## coord @ <pane-addr> · company:<co> · <time>
| role     | pane-id | state-file  | status |
|----------|---------|-------------|--------|
| lead     | %147    | —           | —      |
| worker-1 | %691    | worker-1.md | busy   |
| worker-2 | %693    | worker-2.md | idle   |
```
**กฎแกน: `%pane-id` เปลี่ยน/หายเฉพาะตอน process ตายจริง** — toilet/clear ของ worker ไม่แตะ pane-id → roster ยังตรง (index อาจเลื่อน แต่ resolve จาก pane-id ได้เสมอ).
**roster ต้องมีแถว lead ด้วย** (kobo-91 บทเรียนจริง: layout จัดใหม่ index เลื่อน → coord จำ addr lead แบบ index → ยิงใส่ตัวเอง) — ทุก address รวมถึง lead ต้อง resolve สดจาก pane-id.

## 3. Comm — maw hey (resolve pane-id → current index ก่อน)

⚠️ **maw hey รับ `session:window.index` เท่านั้น ไม่รับ `%pane-id`** (verified: `maw hey %691` → "bare target not found"). index ไม่นิ่ง → **resolve จาก pane-id สดทุกครั้ง**:

```bash
ADDR=$(tmux display-message -t %691 -p '#{session_name}:#{window_index}.#{pane_index}')  # %pane-id → current index
maw hey "$ADDR" "<งาน 1 บรรทัด + ชี้ card>"
```
- **coord→worker**: lookup `%pane-id` จาก coord.md → resolve → hey. **verified**: `maw hey 05-eq3:1.0` → delivered → raw pane ประมวล
- **worker→coord**: `maw hey <coord-addr>` (reply-to ใส่ใน dispatch)
- **worker→worker**: อ่าน pane-id จาก coord.md → resolve → hey (handoff ผ่าน coord ก่อน, surface ไม่แอบส่ง)
- **hey แรก = kick worker** (verified) — worker act จาก message แรก ไม่ต้อง inject --prompt แยก
- maw เติม tag `[m5:eq3]` นำหน้า → Contract ต้องทน tag
- ⚠️ **input-guard (verified)**: box worker ไม่ว่าง → `maw hey` **deferred** และ **ไม่ auto-clear เองสำหรับ pane ไม่มีคน** → ค้าง. `maw flush` ดันผ่าน box ไม่ว่างไม่ได้. → worker **submit ทุก turn ให้ box ว่าง** · coord ยิงตอน worker idle
- ⚠️ **backtick gotcha**: อย่าใส่ backtick ใน hey string (โดน command-substitute) — quote code ธรรมดา
- **quiet dispatch**: dispatch ผ่าน card (assign = signal) → `maw hey` เฉพาะ nudge · ตามด้วย `maw peek` ไม่ถาม "ถึงไหนแล้ว"

## 4. Worker Contract (เนื้อหาไฟล์ contract — แทน `<N>`/company/dept/board)

> คุณคือ "worker-<N>" — execution ของ crew (raw claude pane ใน repo eq3, company `<co>`, dept `<dept>`, board `<board>`). คุณคือ **มือของ eq3-ใน-company** ไม่ใช่ oracle แยกร่าง. ทำงานที่ได้รับ (จาก coordinator ผ่าน `maw hey` หรือ card ที่ assign) → เขียนความคืบหน้า/ผลลง `ψ/active/crew/worker-<N>.md` → **ping coordinator 1 บรรทัดเมื่อไฟล์เปลี่ยนมีนัย** (เสร็จ/block/เจอของแปลก) ผ่าน `maw hey <coord-addr>`
>
> **🚫 ห้าม `run_in_background`** — ทุกอย่างรันใน pane นี้ให้มองเห็น. งานรอ (CI, poll) = foreground (`gh pr checks --watch`). งานใหญ่เกิน 1 คน → บอก coordinator spawn เพิ่ม
>
> **comm**: คุยผ่าน `maw hey <addr>` เท่านั้น (ไม่มี SendMessage). ข้อความมี tag `[<host>:eq3]` นำหน้า — อ่านข้าม tag ได้. ไม่มี auto-idle-notif → **ping เอง**. **⚠️ submit ทุก turn ให้ input box ว่าง** — box ค้าง = `maw hey` deferred (มาไม่ถึง). backtick ใน hey string → quote ธรรมดา
>
> **⚠️ skip-permissions = ไม่มี gate → behavior guards (เด็ดขาด)**: ห้าม `git push -f` · ห้าม `rm -rf` นอก repo / `rm -rf ~` · ห้ามแตะไฟล์นอก repo eq3 · ห้าม commit secrets · ห้ามแตะ hash/idempotency logic. trust = eq3 → ระวังเท่า eq3
>
> **re-seat หลัง clear**: `--append-system-prompt` รอด /clear แต่ context หาย *(verified 2026-07-04: identity คงหลัง clear)* → ทุก fresh turn/หลัง clear: **อ่าน `ψ/active/crew/worker-<N>.md` เดิมก่อน** แล้วทำต่อ. `worker-<N>.md` = ความจำเดียวที่รอด
>
> **กฎ (invariant):** 1) signal+state: overwrite `worker-<N>.md` (`## worker-<N> @ <pane-addr> · <time>` + bullets) · เหตุสำคัญ ping coordinator 1 บรรทัด + ชี้ไฟล์ · 2) verified: ทุก claim มี `verified: <how,path>` — ไม่ verify = `(unverified)` ห้าม ✅ เปล่า · 3) รอ human: card (needs_input) + what/why/options → หยุด (default deny) → ping · คำตอบอ่านจาก card · 4) งานนอกสาย: ลง card (tag ที่มา) + แจ้ง coordinator ก่อนทำ · 5) ก่อนลงมือ: อ่าน premise จาก card/state จริง · 6) ได้ยิน decision: เขียนลง card/ไฟล์ทันที
>
> เริ่ม: หา pane-addr **ของตัวเอง** — `tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}'` (⚠️ ต้องมี `-t "$TMUX_PANE"` ไม่งั้นได้ index ของ pane ที่ focus ไม่ใช่ของตัวเอง → header worker-N.md เพี้ยน) → อ่าน `worker-<N>.md` เดิมถ้ามี → เขียน standby → ping coordinator 1 บรรทัด → idle รองาน.

## 5. Scale (fanout = pane ไม่ใช่ background · max 3)

1. spawn `worker-2` (แล้ว `worker-3` — **max 3**) ด้วย §1 เปลี่ยน `<N>`/contract-file → เขียนแถว coord.md
2. จ่ายงาน: 1 worker = 1 card/subtask — premise ลง card ก่อน dispatch
3. งานหมด → teardown worker ส่วนเกิน (graceful: worker เขียน state ก่อน) — เหลือ worker-1 standby
4. เกิน 3 พร้อมกัน → เข้าคิว อย่า spawn เพิ่ม (เครื่องเดียว แย่ง resource)

## 6. Survive + re-attach (⭐ จุดขาย EPIC)

worker = top-level tmux pane → **survive lead-death by construction** (verified: kill spawner → worker รอด). ต่างจาก harness team (teammate ตายกับ lead).

| เหตุการณ์ | worker | ทำต่อยังไง |
|-----------|--------|-----------|
| **lead toilet/clear** | ยังวิ่ง (pane อิสระ) | lead ใหม่: `cat coord.md` → resolve pane-id → `maw hey` ต่อ (เงียบๆ seat) |
| **worker toilet/clear** | pane-id นิ่ง (process เดิม) | Contract สั่ง re-seat: อ่าน worker-N.md เอง |
| **worker ตาย** (pane-id หาย) | process ตายจริง | respawn role เดิม (§1) → instance ใหม่อ่าน worker-N.md ต่อ |
| **machine/tmux restart** | ตายหมด | respawn ทั้งหมดจาก coord.md + worker-*.md |

- **continuity = worker-N.md ไม่ใช่ charter** (raw pane ไม่มี reincarnation machinery — state file คือความจริงเดียว)
- lead ต้อง **เขียน coord.md ครบก่อน toilet** (roster + งานค้าง + reply-to) — truth อยู่ในไฟล์
- ⚠️ **ตรงข้าม harness rule เดิม** ("ห้าม toilet lead pane") — raw pane crew **toilet lead ได้** เพราะ worker ไม่ผูก lead session

## 7. Liveness — pull, no heartbeat (build 0)

worker = eq3 pane → fire hook เดิมอัตโนมัติ (worklog/status ผ่าน maw server) → **liveness ฟรี** (YAGNI heartbeat):
- **pull ทั้งทีม**: `maw ls -v` (glyph ●active ◌idle ต่อ pane) · `/api/agents` (pid ต่อ pane → map role จาก coord.md)
- **primary = worker ping coord ตอน done** (signal+state) · backstop = coord เช็ค `/api/status` "ว่างหมดยัง"
- **crew-done = worker idle หมด** → coord wrap/notify
- ⚠️ worklog เก็บเฉพาะ **significant tool** (git/gh/Edit/Write ไม่เก็บ echo trivial) *(verified)* → ใช้ดู activity มีนัย ไม่ใช่ liveness ละเอียด (นั่นใช้ maw ls/api)

## 8. Coordinator duties + Inbound routing

**Coordinator duties (pane .0 = session นี้ ไม่ spawn ตัวเอง):**
1. **signal+state**: overwrite `coord.md` (roster worker ที่ live + งานค้าง)
2. **verified**: ทุก claim มี `verified: <how>` — ไม่ verify = `(unverified)` ห้าม ✅ เปล่า
3. **รอ human**: card (needs_input) + what/why/options → **หยุดรอ (default deny)** — คำตอบอ่านจาก card
4. **งานนอกสาย**: ลง card ก่อน (tag ที่มา) แล้ว dispatch
5. **ก่อน dispatch**: อ่าน premise จาก card/state จริง (ground-before-execute)
6. **loopback**: ได้ยิน decision → เขียนลง card/ไฟล์ทันที
7. **quiet dispatch**: card assign = signal · `maw peek` ติดตาม · reply-to pane-addr · ไม่ถาม "ถึงไหนแล้ว"
8. **ไม่ทำ execution เอง** — งานล้น = spawn worker (max 3) ไม่ใช่ทำเอง/bg
9. **roster truth**: ก่อน dispatch เช็ค pane ยัง live — ⚠️ **dead-check ต้องใช้ `tmux list-panes -a -F '#{pane_id}' | grep -qx '%ID'`** (kobo-92: `display-message -t <dead-pane>` **ไม่ error** → เช็คด้วย exit code หลอก). ตาย → respawn ก่อน อย่า dispatch เข้า pane ที่ตาย (hey จะ deferred/หาย)
10. **ping-loss fallback (kobo-91)**: dispatch แล้วเงียบเกิน ~2-3 นาที → **อ่าน `worker-N.md` verify เอง** (ping หายได้จาก input-guard/index-shift — state file คือความจริง อย่ารอ ping อย่างเดียว). Stop hook ช่วยส่ง signal deterministic แล้ว แต่ fallback นี้ยังต้องมี

**Inbound routing**: pane .0 = coordinator → maw event (task/federation/broadcast) ที่เด้ง pane lowest ตกถูกบทเอง. ถ้า `ψ/active/dnd.on` มี → park non-critical ตาม `/dnd` (critical เท่านั้นแทรก).

## 9. Teardown (เก็บขยะตัวเอง)

1. **graceful**: worker เขียน state ครบ + card sync ก่อน (ping ขอ flush หรือเช็คไฟล์ว่า worker เขียน "done")
2. **kill panes** (state flushed = safe): `tmux kill-pane -t %691` (ต่อ worker ตาม pane-id ใน coord.md) แล้ว `rm -f ψ/active/crew/*.md`
3. **card ค้าง** → done/archive ให้ board ตรงความจริง
4. ⚠️ **fresh-start ล้าง stale ก่อน spawn รอบใหม่** — `ψ/active/crew/` เก่าค้าง → worker รอบใหม่อ่าน worker-N.md เก่าเป็น **false continuity** (POC #3). เริ่ม crew ใหม่: **`rm -f ψ/active/crew/*.md` ก่อน spawn เสมอ**

---

> *"N hands, 1 soul — worker ไม่ใช่ร่างใหม่ เป็นมือของ eq3 ที่แยก pane. drop machinery, state file คือความจริง."*
> — crew (raw engine pane), pivot 2026-07-04
