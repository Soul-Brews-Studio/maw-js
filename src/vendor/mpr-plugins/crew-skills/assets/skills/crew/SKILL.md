---
name: crew
description: Spin up an autonomous crew cell — front pane + worker ×N (raw claude panes, max 3). front = pane ที่เรียก /crew (lowest-index) — orchestrator เดียวที่รับ inbound + plan + split + spawn + route + merge-gate (รวม comm+conductor, ไม่มี pane แยก, ไม่ execution เอง). worker = raw pane อิสระ (tmux split + --dangerously-skip-permissions) → front toilet/clear แล้ว worker ยังวิ่ง. spawn = auto-kick (worker boot → รับ first hey อัตโนมัติ ไม่ค้าง idle รอ manual). crew ต้องอยู่ใน company. Use when user says "/crew", "เรียก crew", "ขอ front", or an oracle needs a work team.
---

# /crew — autonomous cell: front + worker ×N (raw engine panes)

```
   inbound (another oracle · maw hey / card)
        │
        ▼
      front   (= pane ที่เรียก /crew · lowest-index · autonomous orchestrator)
        │  relay + plan + split + spawn + route + merge-gate — ไม่ execution เอง · ไม่มี comm pane แยก
   ┌────┼───────────┬──────────────┐
 .N worker-1  .N worker-2 …    .N reviewer     ← raw claude panes
 1 งาน/pane   parallel=spawn เพิ่ม (max 3)   on-demand ตาอิสระ (Card B)
              --settings crew-worker (Stop hook idle→front)
```

**front = orchestrator pane ของ cell** (pane ที่เรียก /crew, lowest-index). autonomous cell → front **รับ inbound เอง** + plan→split→spawn→route→merge-gate ใน pane เดียว — **ไม่มี comm pane แยก** (autonomous ไม่มีคนอยู่ข้าง → ไม่มี federation-noise ต้อง shield) และ **ไม่ execution เอง** (pure orchestrate → ไม่ผลิต artifact ให้ review = self-review guard สะอาด). worker = มือ; reviewer (Card B) = ตาอิสระ on-demand. *(pivot kobo-202/203: รวม comm+conductor เป็น front pane เดียว — cell autonomous ไม่ผูก caller เป็น coordinator ที่ toilet ไม่ได้. ก่อนหน้า kobo-150 แยก Conductor เหนือแถว worker + comm pane shield; ตอนนี้ front คือ pane ใน cell เอง.)*
**Model: N hands, 1 soul** — worker **ไม่ใช่ sub-oracle แยกร่าง** เป็น oracle คนเดียว (eq3/patchwork) แยก pane ทำงานขนาน. worker = raw claude pane ใน repo → oracle resolve อัตโนมัติจาก session name (hook key) → **เสียบ infra ของ oracle ฟรี** (worklog, status, liveness) โดยไม่ต่อท่อใหม่. *(verified 2026-07-04: raw-pane Bash/Edit logs เป็น oracle เอง)*

- **front** = รับ inbound + ถือช่อง board/dispatch, plan/split, spawn/auto-kick/ปลด worker+reviewer, รวมผล, merge-gate. **ไม่ทำ execution เอง**. duties เต็ม §8. *(ใน warroom บทนี้ = Conductor, contract เต็ม kobo-151 — SKILL นี้ไม่เขียนล้ำ; ที่นี่พูดเฉพาะบท front ของ cell)*
- **worker-N** = execution — raw claude pane, 1 worker ต่อ 1 งาน. งาน parallel = spawn เพิ่ม (**max 3**)
- **🚫 ห้าม `run_in_background`** — งาน bg มองไม่เห็น ค้างไม่รู้. parallel = worker pane เพิ่ม (เห็นบน tmux). ยกเว้น watch เล็ก (รอ CI) รันใน pane ของ worker ที่ถืองานนั้น
- front↔worker + worker↔worker คุยผ่าน **`maw hey <pane-addr>`**

**Signal+state: push the SIGNAL, pull the STATE** — worker เขียน state ลงไฟล์ (`$CREW_STATE_DIR/worker-N.md`) + ping front 1 บรรทัดเมื่อมีเหตุ. Stop hook เสริม ping idle อัตโนมัติ (§1). เนื้ออยู่ในไฟล์ (raw pane ไม่มี auto-idle-notif → signal+state คือกลไกเดียว).

Status dir: **`$CREW_STATE_DIR`** (default `ψ/active/crew/`, warroom ตั้ง `ψ/active/warroom/`) — ephemeral, gitignored — roster (`coord.md` standalone / `conductor.md` ใน warroom, เจ้าของ = front) + `worker-1.md`, `worker-1-contract.md`, ...

## 0. Company-gate (crew ⊂ company)

`/crew` **resolve company ก่อนทุกอย่าง** — oracle นี้เป็นสมาชิก company ไหน (`~/.maw/companies/<co>.json` depts):

```bash
CO=$(grep -rl "\"$(tmux display-message -p '#{session_name}' | sed 's/^[0-9]*-//')\"" ~/.maw/companies/*.json 2>/dev/null | head -1)
[ -z "$CO" ] && echo "crew ต้องอยู่ใน company; นอก company ใช้ harness sub-agent (Agent tool) แทน" && exit
```
- **ไม่มี company** → **refuse** (แนะ harness sub-agent = ephemeral ตายกับ lead ได้)
- **มี** → บันทึกชื่อ company ลง roster · worker Contract รู้ dept/board · cards ลง company board. crew work = company work (tracked/survive/board) ≠ harness sub-agent (personal/ephemeral)

## 1. Spawn + auto-kick — raw tmux + claude (จาก front pane)

รันจาก **front pane** (Conductor). **Contract เขียนลงไฟล์ก่อน แล้ว cat ตอน spawn** — กัน backtick/`$(...)` ใน Contract โดน shell substitute (M2):

```bash
COORD=$(tmux display-message -t "$TMUX_PANE" -p '#{pane_id}')   # front (Conductor) pane-id
STATE_DIR="${CREW_STATE_DIR:-ψ/active/crew}"
mkdir -p "$STATE_DIR"
# 1) เขียน Contract ลงไฟล์ — heredoc delimiter 'EOF' (quoted) = ไม่ expand อะไรเลย
cat > "$STATE_DIR/worker-1-contract.md" <<'EOF'
<Worker Contract — ดู §4, แทน <N> ด้วย 1, เติม company/dept/board>
EOF
# 2) spawn — env 3 ตัวบังคับ + $(cat) รันใน shell ของ pane ใหม่ (single-quote outer) → Contract เป็น literal ไม่ถูก re-parse
PANE=$(tmux split-window -h -P -F '#{pane_id}' \
  'cd "'"$PWD"'" && CREW_ROLE=worker-1 CREW_COORD_PANE="'"$COORD"'" CREW_STATE_DIR="'"$STATE_DIR"'" claude --settings "$HOME/.claude/crew-worker-settings.json" --dangerously-skip-permissions --append-system-prompt "$(cat '"$STATE_DIR"'/worker-1-contract.md)"')
```
- **verified live**: raw pane boot + skip-permissions ทำงาน (footer "bypass permissions on") + รัน Bash ไม่ค้าง prompt · pane โผล่ข้าง spawner
- `-P -F '#{pane_id}'` → capture `%pane-id` → **เขียนแถว roster ทันที** (§2)
- ไม่ใช้ `maw team spawn` / `--exec` — คุม tmux เอง → คุม flag (skip-perm) + auto-kick เอง
- **env 3 ตัวบังคับ (AC):**
  - `CREW_ROLE=worker-N` — gate ให้ Stop hook fire เฉพาะ worker pane
  - `CREW_COORD_PANE=<front pane-id>` — Stop hook resolve addr **สด**จากตัวนี้ → ping **front (Conductor)** ไม่ใช่ lead
  - `CREW_STATE_DIR=<dir>` — worker เขียน `worker-N.md` + hook รายงาน state path จากตัวนี้ (warroom ตั้ง `ψ/active/warroom` → hook + worker ใช้ dir เดียวกันอัตโนมัติ)
- **Stop hook = completion signal (kobo-91 TEST2 deadlock fix)** — worker เท่านั้น spawn ด้วย `--settings "$HOME/.claude/crew-worker-settings.json"` (Stop hook `crew-worker-stop.sh` — global copy ติดตั้งโดย `maw crew-skills sync`). ทุกจบ turn hook resolve Conductor addr สดจาก `CREW_COORD_PANE` → `maw hey` แจ้ง "worker-N idle" + state path (`${CREW_STATE_DIR:-ψ/active/crew}/worker-N.md`) = **completion signal deterministic ไม่พึ่งความจำ model** (ping หาย → ทุกคน idle รอกันเป็นวง = deadlock ที่เจอจริง). front/lead spawn ปกติ (ไม่มี `CREW_ROLE`) → hook exit ทันที (env-gate = local-first, ไม่แตะ pane อื่น)

### auto-kick (kobo-150 — ⭐ กัน fold-deadlock kobo-96)

raw pane **ไม่มี auto-idle-notif + ไม่เริ่มงานเอง** → ถ้า front ไม่ยิง first hey หลัง boot, worker ค้าง idle ขณะ front รอ worker ขยับ = **deadlock** (kobo-96 fold). spawn form เดิม kick แยกมือ (§3) = ช่องโหว่นี้. **auto-kick = ผูก first hey เข้า recipe spawn เอง** ผ่าน ready-ping handshake:

1. **worker boot → Contract startup ping front** `"worker-N ready @ <addr>"` (box เพิ่ง submit = ว่าง) — §4 startup
2. **front รับ ready-ping → ยิง first task ทันที**: `maw hey <worker-addr> "<card + งานแรก>"` — box ว่างชัวร์ (worker เพิ่ง ping) → ส่งถึงไม่ deferred
3. **worker act จาก first hey** → เข้างาน

→ ไม่มีช่วง idle รอ manual: **ready-ping = trigger, first hey = อัตโนมัติ**. (spawn worker แบบ standby ไม่มีงานรออยู่ → front ไม่ยิง first task, worker idle จนถูก dispatch — ตั้งใจ ไม่ใช่ deadlock)

**fallback (ready-ping หาย — input-guard/index-shift):** front หลัง spawn ควรเช็ค `maw ls -v` (glyph worker) / `maw peek` — worker boot แล้วแต่ยังไม่ได้ hey → **ยิง first hey เอง** (อย่ารอ ready-ping อย่างเดียว). ต่อยอด §8.10 ping-loss fallback (worker-N.md = ความจริง).

- **Layout (canonical — Tony approved 2026-07-04)**: front ซ้าย 50% เต็มสูง, workers stack แนวนอนขวา. รันหลัง pane ครบ (รันซ้ำได้ทุกครั้งที่ spawn เพิ่ม). *(ใน warroom, layout เป็นของ warroom §5 — crew standalone ใช้บล็อกนี้)*:
  ```bash
  tmux swap-pane -s <front-pane-id> -t "$(tmux display-message -p '#{session_name}:#{window_index}.0')" -d 2>/dev/null  # front → main slot (ถ้ายังไม่ใช่ .0)
  tmux set-window-option main-pane-width 50%
  tmux select-layout main-vertical
  ```
  ⚠️ swap เปลี่ยน index แต่ **pane-id นิ่ง** → roster ไม่พัง (resolve index สดจาก pane-id §3)
- **Pane labels (Tony approved 2026-07-04)** — ขอบ pane บอก **บท + task**. ใช้ `@role`/`@task` user options (⚠️ ห้ามใช้ `select-pane -T` — Claude Code ยิง title ทับตลอด):
  ```bash
  # ตอน spawn (ครั้งเดียวต่อ pane):
  tmux set-option -p -t "$PANE" @role "⚒ worker-1"
  # HARDEN (kobo-174) — @role load-bearing (card-gate reads it); assert it stuck, re-set if not:
  [ "$(tmux display-message -t "$PANE" -p '#{@role}')" = "⚒ worker-1" ] || tmux set-option -p -t "$PANE" @role "⚒ worker-1"
  tmux set-window-option pane-border-status top
  tmux set-window-option pane-border-format ' #{@role}#{?@task, · #{@task},} · #{pane_title} '
  # ตอน dispatch (front set — single writer เดียวกับ roster):
  tmux set-option -p -t "$PANE" @task "kobo-85"
  # ตอนงานเสร็จ (front รับ hook idle + verify แล้ว):
  tmux set-option -p -t "$PANE" @task ""
  ```
  → ขอบโชว์ `⚒ worker-1 · kobo-85 · <งานย่อยที่ CC กำลังทำ>`. @task ว่าง = standby

### reviewer spawn (kobo-204 — on-demand, ตาอิสระ)

reviewer = **recipe เดียวกับ worker** เป๊ะ — เปลี่ยนแค่ 3 จุด → **ไม่มีท่อ spawn ใหม่**:
- `CREW_ROLE=reviewer` (แทน `worker-N`) → Stop hook gate จับ (`worker-*|reviewer`) → idle signal เข้า front เหมือนกัน
- contract-file = `$STATE_DIR/reviewer-contract.md` (เนื้อ = **§4b Reviewer Contract**, ไม่ใช่ §4 worker)
- `@role "🔎 reviewer"` (แทน `⚒ worker-N`)

front spawn reviewer **ตอน worker เสร็จ** (idle+PR) เท่านั้น — **on-demand, ไม่ standing** (ไม่ใช่ pane ฐานของ cell). doer ≠ reviewer (worker ที่ทำงานนั้น **ห้าม** เป็น reviewer ของตัวเอง) → front เลือก pane อื่น/spawn ใหม่. verdict เสร็จ → teardown (§9).

## 2. Roster — front เขียนแถวตอน spawn

`%pane-id` = **stable identity** (นิ่งข้าม reorder). `session:window.index` = **address ที่ maw hey ใช้** แต่ index **เลื่อนเมื่อ pane ตาย/เพิ่ม** → เก็บ `%pane-id` เป็น key, derive index สดตอนจะ hey (§3). roster file = `coord.md` (standalone) / `conductor.md` (warroom, เจ้าของ = Conductor):

```md
## front @ <pane-addr> · company:<co> · <time>
| role        | pane-id | state-file  | status         |
|-------------|---------|-------------|----------------|
| front       | %147    | —           | —              |
| worker-1    | %691    | worker-1.md | busy           |
| worker-2    | %693    | worker-2.md | idle           |
| reviewer    | %701    | reviewer.md | transient      |
```
reviewer row = **transient** — เพิ่มตอน front spawn (worker เสร็จ), ลบทันทีหลัง verdict+teardown (§9). ไม่ค้างใน roster ระหว่าง cell idle (on-demand ไม่ standing).
**กฎแกน: `%pane-id` เปลี่ยน/หายเฉพาะตอน process ตายจริง** — toilet/clear ของ worker ไม่แตะ pane-id → roster ยังตรง (index อาจเลื่อน แต่ resolve จาก pane-id ได้เสมอ).
**roster ต้องมีแถว front ด้วย** (kobo-91 บทเรียนจริง: layout จัดใหม่ index เลื่อน → front จำ addr ตัวเองแบบ index → ยิงใส่ตัวเอง) — ทุก address รวม front ต้อง resolve สดจาก pane-id.

## 3. Comm — maw hey (resolve pane-id → current index ก่อน)

⚠️ **maw hey รับ `session:window.index` เท่านั้น ไม่รับ `%pane-id`** (verified: `maw hey %691` → "bare target not found"). index ไม่นิ่ง → **resolve จาก pane-id สดทุกครั้ง**:

```bash
ADDR=$(tmux display-message -t %691 -p '#{session_name}:#{window_index}.#{pane_index}')  # %pane-id → current index
maw hey "$ADDR" "<งาน 1 บรรทัด + ชี้ card>"
```
- **front→worker**: lookup `%pane-id` จาก roster → resolve → hey. **verified**: `maw hey 05-eq3:1.0` → delivered → raw pane ประมวล
- **worker→front**: `maw hey <front-addr>` (reply-to = front pane-id ใน dispatch)
- **worker→worker**: อ่าน pane-id จาก roster → resolve → hey (handoff ผ่าน front ก่อน, surface ไม่แอบส่ง)
- **first hey = auto-kick** (§1) — worker act จาก message แรก ไม่ต้อง inject `--prompt` แยก. ready-ping handshake การันตี box ว่างตอน kick
- maw เติม tag `[<host>:<oracle>]` นำหน้า → Contract ต้องทน tag
- ⚠️ **input-guard (verified)**: box worker ไม่ว่าง → `maw hey` **deferred** และ **ไม่ auto-clear เองสำหรับ pane ไม่มีคน** → ค้าง. `maw flush` ดันผ่าน box ไม่ว่างไม่ได้ → worker **submit ทุก turn ให้ box ว่าง** · front ยิงตอน worker idle
- ⚠️ **backtick gotcha**: อย่าใส่ backtick ใน hey string (โดน command-substitute) — quote code ธรรมดา
- **quiet dispatch**: dispatch ผ่าน card (assign = signal) → `maw hey` เฉพาะ nudge · ตามด้วย `maw peek` ไม่ถาม "ถึงไหนแล้ว"

## 4. Worker Contract (เนื้อหาไฟล์ contract — แทน `<N>`/company/dept/board)

> คุณคือ "worker-<N>" — execution ของ crew (raw claude pane ใน repo, company `<co>`, dept `<dept>`, board `<board>`). คุณคือ **มือของ oracle-ใน-company** ไม่ใช่ oracle แยกร่าง. ทำงานที่ได้รับ (จาก **front (Conductor)** ผ่าน `maw hey` หรือ card ที่ assign) → เขียนความคืบหน้า/ผลลง `$CREW_STATE_DIR/worker-<N>.md` → **ping front 1 บรรทัดเมื่อไฟล์เปลี่ยนมีนัย** (เสร็จ/block/เจอของแปลก) ผ่าน `maw hey <front-addr>`. front addr resolve สดจาก `CREW_COORD_PANE` pane-id.
>
> **🚫 ห้าม `run_in_background`** — ทุกอย่างรันใน pane นี้ให้มองเห็น. งานรอ (CI, poll) = foreground (`gh pr checks --watch`). งานใหญ่เกิน 1 คน → บอก front spawn เพิ่ม
>
> **comm**: คุยผ่าน `maw hey <addr>` เท่านั้น (ไม่มี SendMessage). ข้อความมี tag `[<host>:<oracle>]` นำหน้า — อ่านข้าม tag ได้. ไม่มี auto-idle-notif → **ping เอง** (Stop hook เสริม signal ให้ แต่เนื้อ = ไฟล์). **⚠️ submit ทุก turn ให้ input box ว่าง** — box ค้าง = `maw hey` deferred (มาไม่ถึง). backtick ใน hey string → quote ธรรมดา
>
> **⚠️ skip-permissions = ไม่มี gate → behavior guards (เด็ดขาด)**: ห้าม `git push -f` · ห้าม `rm -rf` นอก repo / `rm -rf ~` · ห้ามแตะไฟล์นอก repo · ห้าม commit secrets · ห้ามแตะ hash/idempotency logic. trust = oracle → ระวังเท่า oracle
>
> **re-seat หลัง clear**: `--append-system-prompt` รอด /clear แต่ context หาย *(verified 2026-07-04: identity คงหลัง clear)* → ทุก fresh turn/หลัง clear: **อ่าน `$CREW_STATE_DIR/worker-<N>.md` เดิมก่อน** แล้วทำต่อ. `worker-<N>.md` = ความจำเดียวที่รอด
>
> **กฎ (invariant):** 1) signal+state: overwrite `$CREW_STATE_DIR/worker-<N>.md` (`## worker-<N> @ <pane-addr> · <time>` + bullets) · เหตุสำคัญ ping front 1 บรรทัด + ชี้ไฟล์ · 2) verified: ทุก claim มี `verified: <how,path>` — ไม่ verify = `(unverified)` ห้าม ✅ เปล่า · 3) รอ human: card (needs_input) + what/why/options → หยุด (default deny) → ping · คำตอบอ่านจาก card · 4) งานนอกสาย: ลง card (tag ที่มา) + แจ้ง front ก่อนทำ · 5) ก่อนลงมือ: อ่าน premise จาก card/state จริง · 6) ได้ยิน decision: เขียนลง card/ไฟล์ทันที
>
> **เริ่ม (startup = auto-kick trigger):** หา pane-addr **ของตัวเอง** — `tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}'` (⚠️ ต้องมี `-t "$TMUX_PANE"` ไม่งั้นได้ index ของ pane ที่ focus ไม่ใช่ของตัวเอง → header เพี้ยน) → อ่าน `$CREW_STATE_DIR/worker-<N>.md` เดิมถ้ามี → เขียน standby → **ping front 1 บรรทัด: `worker-<N> ready @ <addr>`** (= ready-ping; box ว่างหลัง submit → front ยิง first task เข้าได้ทันที = auto-kick) → idle รอ first hey.

## 4b. Reviewer Contract (kobo-204 — §4 variant: review, NOT execute)

> เนื้อไฟล์ `reviewer-contract.md` — spawn ด้วย recipe §1 (`CREW_ROLE=reviewer`). แทน `<co>`/`<dept>`/`<board>` + ระบุ **card/PR ที่ต้องรีวิว** ตอน spawn.

> คุณคือ **reviewer** ของ crew cell (raw claude pane ใน repo, company `<co>`, dept `<dept>`, board `<board>`) — **ตาอิสระ on-demand**. คุณคือ **มือของ oracle เดียวกัน แต่บทตรวจ** ไม่ใช่ oracle แยกร่าง. งาน: ตรวจ output ของ **worker หนึ่งคน** (PR/artifact ที่ front ชี้มา) ด้าน **correctness + scope** — คุณ **ไม่เขียนงานเอง** (doer ≠ reviewer; ถ้า worker ที่ทำคือคุณ → refuse, บอก front หา pane อื่น).
>
> **🚫 ห้าม `run_in_background`** · ห้ามแก้โค้ด/แตะไฟล์งาน (คุณ **ตรวจ ไม่แก้**) · behavior guards เท่า oracle (ห้าม `git push -f`, `rm -rf` นอก repo, commit secrets, แตะ hash/idempotency)
>
> **comm**: `maw hey <addr>` เท่านั้น. tag `[<host>:<oracle>]` นำหน้า — อ่านข้าม. **⚠️ submit ทุก turn ให้ box ว่าง** (box ค้าง = hey deferred). backtick ใน hey → quote ธรรมดา. front addr resolve สดจาก `CREW_COORD_PANE`.
>
> **verdict routing (Board Truth rule 12 + rule 3 — PR drives lifecycle):** reviewer = **pre-PR quality gate ไม่ใช่ done-closer**. **ไม่มี path ไหน reviewer ปิด card done เอง** — done มาจาก pr-watch ตอน PR merge เท่านั้น (kobo-205 dogfound board-lie: reviewer ปิด done ขณะ PR ยัง open + unstamped = board โกหก).
> 1. อ่าน premise จาก card จริง + diff จริง (`gh pr diff <n> --repo <owner/name>`) — ground ก่อนตัดสิน
> 2. เขียน finding ลง `$CREW_STATE_DIR/reviewer.md` + **comment บน card** (หลักฐาน + verdict)
> 3. **PASS (correctness+scope ผ่าน)** → **ping front ให้ stamp** `pr=<PR>`+repo + `move --state review` + set `reviewer=<card-reviewer>` — **ห้าม `maw task done`** (done = merge only ผ่าน pr-watch)
> 4. **งานใหญ่ (เงิน/hash/live/deploy/schema/ข้าม company/ไม่แน่ใจ)** → **`maw task hold` + comment `@tony`** (human gate — hold ≠ done)
> 5. **ไม่ผ่าน (scope ล้ำ / ไม่ตรง AC / มี broken ref)** → comment finding + ตีกลับ (request-change) ให้ worker แก้
>
> **verdict เสร็จ → ping front 1 บรรทัด** (`verdict: pass|hold|reject + card`) → front loopback + teardown pane นี้ (§9). reviewer = **transient ไม่ re-seat** (จบ verdict = จบชีวิต pane; ไม่มี state ต่อเนื่องข้าม /clear แบบ worker)
>
> **เริ่ม (startup = auto-kick trigger):** หา pane-addr ตัวเอง — `tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}'` → **ping front: `reviewer ready @ <addr>`** (box ว่างหลัง submit → front ยิง review target ทันที) → รับ card/PR → ตรวจ.

## 5. Scale (fanout = pane ไม่ใช่ background · max 3)

1. spawn `worker-2` (แล้ว `worker-3` — **max 3**) ด้วย §1 เปลี่ยน `<N>`/contract-file → เขียนแถว roster → auto-kick เข้างานทันที
2. จ่ายงาน: 1 worker = 1 card/subtask — premise ลง card ก่อน dispatch
3. งานหมด → teardown worker ส่วนเกิน (graceful: worker เขียน state ก่อน) — เหลือ worker-1 standby
4. เกิน 3 พร้อมกัน → เข้าคิว อย่า spawn เพิ่ม (เครื่องเดียว แย่ง resource)

## 6. Survive + re-attach (⭐ จุดขาย EPIC)

worker = top-level tmux pane → **survive front-death by construction** (verified: kill spawner → worker รอด). ต่างจาก harness team (teammate ตายกับ lead).

| เหตุการณ์ | worker | ทำต่อยังไง |
|-----------|--------|-----------|
| **front (Conductor) toilet/clear** | ยังวิ่ง (pane อิสระ) | front ใหม่: `cat` roster → resolve pane-id → `maw hey` ต่อ (เงียบๆ seat) |
| **worker toilet/clear** | pane-id นิ่ง (process เดิม) | Contract สั่ง re-seat: อ่าน worker-N.md เอง |
| **worker ตาย** (pane-id หาย) | process ตายจริง | respawn role เดิม (§1) → instance ใหม่อ่าน worker-N.md ต่อ (auto-kick ใหม่) |
| **machine/tmux restart** | ตายหมด | respawn ทั้งหมดจาก roster + worker-*.md |

- **continuity = worker-N.md ไม่ใช่ charter** (raw pane ไม่มี reincarnation machinery — state file คือความจริงเดียว)
- front ต้อง **เขียน roster ครบก่อน toilet** (roster + งานค้าง + reply-to) — truth อยู่ในไฟล์
- ⚠️ **ตรงข้าม harness rule เดิม** ("ห้าม toilet lead pane") — raw pane crew **toilet front ได้** เพราะ worker ไม่ผูก front session

## 7. Liveness — pull, no heartbeat (build 0)

worker = oracle pane → fire hook เดิมอัตโนมัติ (worklog/status ผ่าน maw server) → **liveness ฟรี** (YAGNI heartbeat):
- **pull ทั้งทีม**: `maw ls -v` (glyph ●active ◌idle ต่อ pane) · `/api/agents` (pid ต่อ pane → map role จาก roster)
- **primary = worker ping front ตอน done** (signal+state) · backstop = front เช็ค `/api/status` "ว่างหมดยัง"
- **crew-done = worker idle หมด** → front wrap/notify
- ⚠️ worklog เก็บเฉพาะ **significant tool** (git/gh/Edit/Write ไม่เก็บ echo trivial) *(verified)* → ใช้ดู activity มีนัย ไม่ใช่ liveness ละเอียด (นั่นใช้ maw ls/api)

## 8. Front duties (บท front = orchestrator ของ cell · ใน warroom = Conductor)

> front = pane ที่เรียก /crew (lowest-index). **รับ inbound เอง + orchestrate** — spawn worker/reviewer แต่ไม่ใช่ worker, ไม่มี comm pane แยก.

1. **spawn + auto-kick**: §1 — worker boot → ready-ping → ยิง first task ทันที (ไม่ปล่อย idle)
2. **signal+state**: overwrite roster (worker ที่ live + งานค้าง)
3. **verified**: ทุก claim มี `verified: <how>` — ไม่ verify = `(unverified)` ห้าม ✅ เปล่า
4. **รอ human**: card (needs_input) + what/why/options → **หยุดรอ (default deny)** — คำตอบอ่านจาก card
5. **งานนอกสาย**: ลง card ก่อน (tag ที่มา) แล้ว dispatch
6. **ก่อน dispatch**: อ่าน premise จาก card/state จริง (ground-before-execute)
7. **loopback**: ได้ยิน decision → เขียนลง card/ไฟล์ทันที
8. **quiet dispatch**: card assign = signal · `maw peek` ติดตาม · reply-to pane-addr · ไม่ถาม "ถึงไหนแล้ว"
9. **ไม่ทำ execution เอง (pure orchestrate — ไม่มี light-exec)** — front ไม่ผลิต artifact ให้ใคร review (self-review guard สะอาด). งานล้น = spawn worker (max 3) ไม่ใช่ทำเอง/bg
10. **roster truth**: ก่อน dispatch เช็ค pane ยัง live — ⚠️ **dead-check ต้องใช้ `tmux list-panes -a -F '#{pane_id}' | grep -qx '%ID'`** (kobo-92: `display-message -t <dead-pane>` **ไม่ error** → เช็คด้วย exit code หลอก). ตาย → respawn ก่อน อย่า dispatch เข้า pane ที่ตาย (hey จะ deferred/หาย)
11. **ping-loss fallback (kobo-91)**: dispatch/spawn แล้วเงียบเกิน ~2-3 นาที → **อ่าน `worker-N.md` verify เอง** (ping/ready-ping หายได้จาก input-guard/index-shift — state file คือความจริง อย่ารอ ping อย่างเดียว). Stop hook + ready-ping ช่วยส่ง signal deterministic แล้ว แต่ fallback นี้ยังต้องมี
12. **merge-gate ผ่าน reviewer (kobo-204) — front ไม่ review เอง · reviewer = pre-PR gate ไม่ปิด done**: worker เสร็จ (idle+PR) → front **spawn reviewer on-demand** (§1 recipe, `CREW_ROLE=reviewer`, doer ≠ reviewer) → reviewer ตรวจ correctness+scope → verdict (§4b) → **ping front** → front loopback:
    - **PASS** → front **stamp** card `pr=<PR>`+repo + `move --state review` + set `reviewer=<card-reviewer>` — **ไม่ set done** (kobo-205 dogfound board-lie: card done ขณะ PR ยัง open = board โกหก). **done มาจาก pr-watch ตอน PR merge เท่านั้น** (Board Truth #3: PR drives lifecycle)
    - **hold (ใหญ่)** → front คง card review/blocked + `@tony` (human gate) — ไม่ done
    - **reject** → front ตีกลับ worker (request-change) — ไม่ done
    - แล้ว **teardown reviewer** (§9). front แค่ orchestrate verdict ไม่ตัดสินเอง (pure-orchestrate = self-review guard). **crew/reviewer ไม่ปิด done + ไม่ merge เอง** — merge = human/pr-watch เท่านั้น

**Inbound routing (front = target)**: autonomous cell → inbound (maw hey / task-event) land ที่ **front** โดยตรง (pane lowest-index ที่เรียก /crew) — ไม่มี comm pane รับแทน. ใน warroom, task-events route เข้า Conductor (kobo-152). ถ้า `ψ/active/dnd.on` มี → front park non-critical ตาม `/dnd` (critical เท่านั้นแทรก).

## 9. Teardown (เก็บขยะตัวเอง)

1. **graceful**: worker เขียน state ครบ + card sync ก่อน (ping ขอ flush หรือเช็คไฟล์ว่า worker เขียน "done")
2. **kill panes** (state flushed = safe): `tmux kill-pane -t %691` (ต่อ worker ตาม pane-id ใน roster) แล้ว `rm -f "$CREW_STATE_DIR"/*.md`
3. **card ค้าง** → done/archive ให้ board ตรงความจริง
4. **reviewer = kill-after-verdict (kobo-204)**: reviewer transient → front รับ verdict + loopback ลง card เสร็จ → **kill pane reviewer ทันที** (`tmux kill-pane -t <reviewer-pane-id>` + `rm -f "$CREW_STATE_DIR/reviewer.md"` + ลบ roster row) ไม่รอ teardown ทั้ง cell. reviewer ไม่ standing → ไม่เหลือค้างระหว่าง cell idle
5. ⚠️ **fresh-start ล้าง stale ก่อน spawn รอบใหม่** — `$CREW_STATE_DIR` เก่าค้าง → worker รอบใหม่อ่าน worker-N.md เก่าเป็น **false continuity** (POC #3). เริ่ม crew ใหม่: **`rm -f "$CREW_STATE_DIR"/*.md` ก่อน spawn เสมอ**

---

> *"N hands, 1 soul — worker ไม่ใช่ร่างใหม่ เป็นมือที่แยก pane ใต้Conductor. coordinator หายได้ worker ยังวิ่ง, worker หายได้งานยังอยู่ในไฟล์. auto-kick = ไม่มีใครค้างรอใคร."*
> — crew (raw engine pane), pivot 2026-07-04 · worker×N ใต้Conductor + auto-kick 2026-07-06 (kobo-150)
