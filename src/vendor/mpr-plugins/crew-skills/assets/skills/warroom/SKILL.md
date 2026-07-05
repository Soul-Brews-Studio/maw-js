---
name: warroom
description: Spin up a 3-role warroom — human/lead .0 | coord (raw pane) | worker ×N (raw panes). ทุก teammate = raw claude pane อิสระ → lead toilet/clear ได้ ทีมไม่ตาย. kernel เดียวกับ /crew (validated kobo-89/91). Use when user says "/warroom", "เปิด warroom", "3 pane", or wants coord + worker beside the human pane.
---

# /warroom — human | coord / worker ×N (raw engine pane)

```
┌────────────────┬────────────────┐
│ .0 human/lead  │ coord          │   ← raw pane: company channel + aggregator + dispatch
│ (Tony ↔ eq3)   ├────────────────┤
│  ซ้าย 50%      │ worker-1       │   ← raw pane: execution (coord spawn/คุม)
│  เต็มสูง        │                │
└────────────────┴────────────────┘
```

**Default = worker 1 ตัว** (Tony 2026-07-04) — warroom คือโต๊ะทำงานประจำ ไม่ใช่ fanout farm. งาน parallel จริงๆ ค่อยให้ coord spawn เพิ่มชั่วคราว (max 3 ตาม crew) แล้ว teardown ส่วนเกินเมื่อจบ.

**Kernel = /crew (validated kobo-89/91)** — spawn form, comm (resolve pane-id→index), roster, Stop hook, liveness, toilet/re-seat, teardown: **ใช้ crew SKILL §0-§9 ทั้งหมด**. ไฟล์นี้เขียนเฉพาะส่วนต่างของ warroom.

**ต่างจาก /crew ตรงไหน:**
| | /crew | /warroom |
|--|-------|----------|
| coordinator | **session นี้เอง** (.0) | **raw pane แยก** — lead (.0) เป็น Tony↔eq3 ล้วนๆ ไม่ถือ dispatch |
| lead toilet | lead=coord → toilet แล้ว dispatch หยุด | **lead toilet ได้เต็มตัว** — coord+worker (raw panes) วิ่งต่อ ไม่มีอะไรหยุด ⭐ |
| status flow | worker → coord(=lead) ตรง | worker → coord → **digest.md** → lead อ่าน/ถูก ping เฉพาะเรื่องสำคัญ |

**Model: push the SIGNAL, pull the STATE** (เดิม) + **N hands 1 soul** (จาก crew) — coord/worker = มือของ eq3 แยก pane, เสียบ infra eq3 ฟรี.

## Lead Discipline (pane .0) ⭐ — lead ห้ามทัก peer ตรง

> lead (.0) = คุย **human ล้วน**. การคุย peer/federation (oracle อื่น) → **delegate coord**. เหตุผล (2026-07-05): lead ที่ทัก peer เองทำให้ reply เด้งกลับเข้า pane 0 = federation noise บนจอที่ควรเป็น human↔AI. รากไม่ใช่ routing bug — คือ lead ไม่ delegate.

- **routine peer comm** (progress · status · dispatch · coordinate · ไม่ด่วน) → **สั่ง coord ทัก** ห้าม `maw hey` peer ตรงจาก lead. coord จัดการ + escalate lead **สรุปพร้อม (conclusion-ready, ไม่ให้ human ไป ground ต่อ)**
- **ยกเว้น decision-gate** (ด่วน + human ต้องเห็น/ตัดสิน: round-trip verify · restart-green · merge relay · blocker-needs-human) → lead ทัก peer **ตรงได้** (เร็ว+แม่น ไม่ผ่าน relay)
- **default = delegate · gate = exception จงใจ**

(crew **ไม่ใช้**กฎนี้ — crew .0 = coord เอง คุย human + coordinate รวมกัน, ยอมรับ noise ตามโครงสร้าง. กฎนี้เฉพาะ warroom ที่แยก human/coord.)

Status dir: `ψ/active/warroom/` (ephemeral, gitignored) — `coord.md` (roster+state) · `digest.md` (coord รวมให้ lead) · `worker-N.md`

## Spawn (lead ทำครั้งเดียว — จากนั้น coord คุม)

1. **company-gate + fresh-start** — ตาม crew §0 + §9.4 (`rm -f ψ/active/warroom/*.md` ก่อนเสมอ)
2. **lead spawn coord** (raw pane, **ไม่ใส่ worker hook** — hook = worker เท่านั้น):
   ```bash
   LEAD=$(tmux display-message -t "$TMUX_PANE" -p '#{pane_id}')
   cat > ψ/active/warroom/coord-contract.md <<'EOF'
   <Coord Contract — ดูข้างล่าง>
   EOF
   COORD=$(tmux split-window -h -P -F '#{pane_id}' \
     'cd "'"$PWD"'" && claude --dangerously-skip-permissions --append-system-prompt "$(cat ψ/active/warroom/coord-contract.md)"')
   ```
3. **kick coord** — `maw hey` (resolve index จาก $COORD) 1 บรรทัด: ชี้ lead pane-id + สั่ง spawn worker-1 + เขียน roster
4. **coord spawn workers** — ตาม crew §1 เป๊ะ (contract-to-file + `--settings "$HOME/.claude/crew-worker-settings.json"` + `CREW_ROLE=worker-N CREW_COORD_PANE=$COORD CREW_STATE_DIR=ψ/active/warroom`) → Stop hook ยิง idle เข้า **coord** (ไม่ใช่ lead) พร้อม hint ชี้ `ψ/active/warroom/worker-N.md`
5. **layout (canonical — Tony approved 2026-07-04)** — **human/lead = main ซ้าย 50% เต็มสูง** · ขวา stack: **coord บน, worker ล่าง**:
   ```bash
   # lead pane ต้องอยู่ slot .0 ก่อน (ถ้าไม่ใช่ → swap ด้วย pane-id, roster ไม่พังเพราะ resolve สด)
   tmux set-window-option main-pane-width 50%
   tmux select-layout main-vertical
   ```
   (ต่างจาก /crew ที่ coordinator เป็น main — warroom main คือ **human**)
   **ตั้งชื่อ pane (warroom เท่านั้น — Tony approved)** — ⚠️ อย่าใช้ `select-pane -T` (Claude Code ยิง escape ตั้ง title ทับตลอด). ใช้ **`@role` user option** ที่ CC override ไม่ได้:
   ```bash
   tmux set-option -p -t "$LEAD"  @role "👤 human"
   tmux set-option -p -t "$COORD" @role "🎯 coord"
   tmux set-option -p -t "$W1"    @role "⚒ worker-1"
   tmux set-window-option pane-border-status top
   tmux set-window-option pane-border-format " #{@role} · #{pane_title} "   # role คงที่ + งานปัจจุบันของ CC ต่อท้าย
   ```
   (ตั้งซ้ำหลัง respawn — @role ผูก pane; pane ใหม่ = ตั้งใหม่)
6. **inbound routing** — coord register รับ task/federation event (re-run หลัง layout เปลี่ยน — route ผูก index):
   ```bash
   maw route set task-events <coord-index-ปัจจุบัน>
   ```

## Roster (coord.md — coord เป็นเจ้าของ)

ตาม crew §2 + **แถว lead บังคับ** (kobo-91 บทเรียน: address lead ต้อง resolve สดจาก pane-id):
```md
## coord @ <pane-addr> · company:<co> · <time>
| role     | pane-id | state-file  | status |
| lead     | %147    | —           | human  |
| coord    | %722    | coord.md    | active |
| worker-1 | %728    | worker-1.md | busy   |
```

## Coord Contract (--append-system-prompt ของ coord)

> คุณคือ "coord" ของ eq3 warroom — raw claude pane, company channel + aggregator + dispatcher. คุณคือมือของ eq3-ใน-<co> ไม่ใช่ oracle แยกร่าง. lead(.0) = Tony↔eq3 — รบกวนเฉพาะเรื่องที่ lead ต้องรู้/ตัดสิน.
>
> **หน้าที่:** (ก) จัดการ maw inbox/hey/board/worklog + cross-oracle ตามที่ lead delegate (ข) spawn/คุม worker (crew §1 form: contract-to-file + --settings "$HOME/.claude/crew-worker-settings.json" + CREW_ROLE/CREW_COORD_PANE=pane-id ของคุณ + CREW_STATE_DIR=ψ/active/warroom) + เขียน roster ลง coord.md ทันทีทุก spawn (ค) รับ `[hook] worker-N idle` → อ่าน worker-N.md → รวมเป็น `ψ/active/warroom/digest.md` (ง) ping lead 1 บรรทัดเฉพาะเรื่องสำคัญ (เสร็จก้อนใหญ่/block/ต้องตัดสิน)
>
> **comm:** maw hey เท่านั้น — ทุก address (รวม lead) **resolve สดจาก pane-id ใน roster** (`tmux display-message -t %ID -p '#{session_name}:#{window_index}.#{pane_index}'`) ห้ามจำ index. submit ทุก turn ให้ box ว่าง. อ่านข้าม tag [<host>:eq3]. ห้าม backtick ใน hey string.
>
> **ping-loss fallback:** dispatch แล้วเงียบเกิน ~2-3 นาที → อ่าน worker-N.md เอง (state file = ความจริง)
>
> **guards (skip-perm ไม่มี gate):** ห้าม git push -f · ห้าม rm -rf นอก repo · ห้ามแตะไฟล์นอก repo · ห้าม commit secrets · ห้ามแตะ hash/idempotency logic
>
> **invariants:** 1) state ล่าสุด overwrite coord.md (+roster) 2) ทุก claim มี verified: 3) รอ Tony = card needs_input + หยุด (default deny) — คำตอบอ่านจาก card, **ห้ามเชื่อคำเล่าต่อ** 4) งานนอกสาย = card ก่อน 5) ground-before-execute 6) decision → เขียนไฟล์ทันที 7) quiet dispatch (card=signal, maw peek, ไม่ถาม "ถึงไหนแล้ว") 8) ไม่ execution เอง — งานลงมือ = worker
>
> **re-seat หลัง /clear:** อ่าน coord.md + digest.md ก่อนทำต่อ (validated kobo-91: contract รอด clear, state file = ความจำ)
>
> เริ่ม: หา pane-addr ตัวเอง (`-t "$TMUX_PANE"` เสมอ) → อ่าน coord.md เดิมถ้ามี → เขียน standby → รอ lead kick

## Worker Contract

ใช้ของ crew §4 ตรงๆ (เปลี่ยน path เป็น `ψ/active/warroom/`) — ping ทุกอย่างชี้ **coord** ไม่ใช่ lead.

## lead-toilet-survive (⭐ จุดขายเต็มรูป)

crew พิสูจน์ worker+coord toilet แล้ว (kobo-91). warroom เพิ่มขั้นสุด: **lead (.0) toilet/clear/ปิด session → coord+worker (raw panes อิสระ) วิ่งต่อ ไม่หยุดแม้แต่ dispatch**:

```
lead toilet → coord ยัง dispatch/aggregate ต่อเอง (autonomous)
   ↓
lead ใหม่ (clock-in/seat): cat ψ/active/warroom/digest.md + coord.md
   → รู้ทันทีว่าเกิดอะไรระหว่างหายไป → hey coord (resolve จาก pane-id) → ทำงานต่อ
```
- lead ก่อน toilet: ไม่ต้องเตรียมอะไรพิเศษ — truth อยู่ที่ coord.md/digest.md ที่ coord maintain อยู่แล้ว (ต่างจาก crew ที่ lead=coord ต้องเขียนเอง)
- inbound route: lead ใหม่ re-run `maw route set task-events <coord-index>` (index อาจเลื่อน)

## Board = ความจำกลาง (เดิม)

อะไรที่ Tony/lead ต้องเห็นหรือตอบ → card บน board เท่านั้น (needs_input / done ผูก PR). status ยิบย่อย → digest/ไฟล์ ไม่ขึ้น board (1 card ≈ 1 งานจริง). ถ้า `ψ/active/dnd.on` มี → coord park non-critical ตาม /dnd.

## Human อ่าน status (pull)
- `cat ψ/active/warroom/digest.md` — สรุปจาก coord (หลัก)
- `cat ψ/active/warroom/coord.md worker-*.md` — ดิบ · หรือมอง tmux / `maw ls -v`

## Teardown
ตาม crew §9 (path warroom/): worker เขียน state → kill worker panes → kill coord pane → `rm -f ψ/active/warroom/*.md` → card ค้าง done/archive. **shutdown ≠ ต้อง delete อะไร** — spawn ใหม่รอบหน้าอ่าน state เก่าไม่ได้อยู่แล้ว (fresh-start ล้างก่อนเสมอ).

---

> *ทีมทั้งโต๊ะเป็น raw pane — ไม่มีใครผูกชีวิตกับใคร. lead หายได้ coord ยังเดิน, coord หายได้ state ยังอยู่, worker หายได้งานยังอยู่ในไฟล์.*
> — warroom (raw engine pane), 2026-07-04
