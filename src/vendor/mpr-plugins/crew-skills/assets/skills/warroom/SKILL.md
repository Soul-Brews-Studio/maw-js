---
name: warroom
description: Spin up a warroom — 3 บทหัว (raw claude panes) ข้าง human/lead .0 — lead(opus,human) · comm(sonnet,peer/federation) · บานพับ(opus,decompose→route→review + crew-coordinator). ทุก teammate = raw pane อิสระ → lead toilet/clear ได้ ทีมไม่ตาย. kernel เดียวกับ /crew (validated kobo-89/91). Use when user says "/warroom", "เปิด warroom", "3 pane", or wants comm + บานพับ beside the human pane.
---

# /warroom — lead(.0) | comm | บานพับ (raw engine panes)

```
┌────────────────┬────────────────┐
│ .0 lead        │ comm           │   ← sonnet · peer/federation chatter (relay ให้ lead)
│ (human · opus) ├────────────────┤
│  ซ้าย 50%      │ บานพับ          │   ← opus · decompose→card→route→review + crew-coordinator
│  เต็มสูง        │ (└ worker ×N ใต้บานพับ — /crew) │
└────────────────┴────────────────┘
```

**บท = ของ pane ไม่ใช่ 2 team** (grill 2026-07-06, kobo-148). warroom = **หัว 3 บท**: lead คิด/ตัดสิน · comm สื่อสาร peer · บานพับ แปลงแผน→งาน→คุมช่าง. **มือ (worker ×N)** เกิดใต้บานพับ ผ่าน /crew (kobo-150) — ไม่ใช่ pane ของ warroom โดยตรง.

**Kernel = /crew (validated kobo-89/91)** — spawn form, comm (resolve pane-id→index), roster, Stop hook, liveness, toilet/re-seat, teardown: **ใช้ crew SKILL §0-§9 ทั้งหมด**. ไฟล์นี้เขียนเฉพาะส่วนต่างของ warroom (3-head + model tier).

**Model tier (Tony grill 2026-07-06)** — ตั้งผ่าน `claude --model <alias>` ตอน spawn (verified: CLI รับ alias `opus`/`sonnet` per pane):
| บท | model | ทำไม |
|----|-------|------|
| lead (.0) | opus | judgment สูงสุด — คิด/ตัดสิน/คุย human |
| comm | **sonnet** | relay/aggregate ปริมาณมาก judgment ต่ำ → คุ้มกว่า |
| บานพับ | opus | decompose/route/review = judgment งาน |

**Model: push the SIGNAL, pull the STATE** + **N hands 1 soul** — comm/บานพับ/worker = มือของ eq3 แยก pane, เสียบ infra eq3 ฟรี (worklog/status/liveness).

## Lead Discipline (pane .0) ⭐ — lead ห้ามทัก peer ตรง

> lead (.0) = คุย **human ล้วน**. การคุย peer/federation (oracle อื่น) → **delegate comm**. เหตุผล (2026-07-05): lead ที่ทัก peer เองทำให้ reply เด้งกลับเข้า pane 0 = federation noise บนจอที่ควรเป็น human↔AI. รากไม่ใช่ routing bug — คือ lead ไม่ delegate.

- **routine peer comm** (progress · status · coordinate · ไม่ด่วน) → **สั่ง comm ทัก** ห้าม `maw hey` peer ตรงจาก lead. comm จัดการ + escalate lead **สรุปพร้อม (conclusion-ready, ไม่ให้ human ไป ground ต่อ)**
- **ยกเว้น decision-gate** (ด่วน + human ต้องเห็น/ตัดสิน: round-trip verify · restart-green · merge relay · blocker-needs-human) → lead ทัก peer **ตรงได้** (เร็ว+แม่น ไม่ผ่าน relay)
- **default = delegate · gate = exception จงใจ**
- **งาน (dispatch/decompose/review)** → บานพับ ไม่ใช่ comm. comm = สื่อสาร, บานพับ = งาน.

(crew **ไม่ใช้**กฎนี้ — crew = worker pane ล้วนใต้บานพับ ไม่มี human seat แยก.)

Status dir: `ψ/active/warroom/` (ephemeral, gitignored) — `comm.md` · `banphab.md` (roster+state) · `digest.md` (บานพับ รวมให้ lead) · `worker-N.md`

## Spawn (lead ทำครั้งเดียว — จากนั้น comm+บานพับ คุมกันเอง)

1. **company-gate + fresh-start** — ตาม crew §0 + §9.4 (`rm -f ψ/active/warroom/*.md` ก่อนเสมอ — spawn ซ้ำ = ล้างก่อน)
2. **lead spawn comm + บานพับ** (raw panes, **ไม่ใส่ worker hook** — hook = worker เท่านั้น; ใส่ `--model` ตาม tier):
   ```bash
   LEAD=$(tmux display-message -t "$TMUX_PANE" -p '#{pane_id}')
   # comm — sonnet
   cat > ψ/active/warroom/comm-contract.md <<'EOF'
   <Comm Contract — §ล่าง>
   EOF
   COMM=$(tmux split-window -h -P -F '#{pane_id}' \
     'cd "'"$PWD"'" && claude --model sonnet --dangerously-skip-permissions --append-system-prompt "$(cat ψ/active/warroom/comm-contract.md)"')
   # บานพับ — opus
   cat > ψ/active/warroom/banphab-contract.md <<'EOF'
   <บานพับ Contract — kobo-151 เขียนเต็ม; ตอนนี้ stub §ล่าง>
   EOF
   BANPHAB=$(tmux split-window -h -P -F '#{pane_id}' \
     'cd "'"$PWD"'" && claude --model opus --dangerously-skip-permissions --append-system-prompt "$(cat ψ/active/warroom/banphab-contract.md)"')
   ```
3. **kick comm + บานพับ** — `maw hey` (resolve index จาก $COMM/$BANPHAB) 1 บรรทัดต่อ pane: ชี้ lead pane-id + สั่งเขียน roster + standby. (kick แรก = act จาก message แรก, ตาม crew)
4. **worker ใต้บานพับ** — บานพับ spawn worker เอง ตาม **/crew (kobo-150)**: contract-to-file + `--settings "$HOME/.claude/crew-worker-settings.json"` + `CREW_ROLE=worker-N CREW_COORD_PANE=$BANPHAB CREW_STATE_DIR=ψ/active/warroom` → Stop hook ยิง idle เข้า **บานพับ**. (warroom ไม่ spawn worker เอง — นั่นงานบานพับ)
5. **layout (canonical — Tony approved 2026-07-04)** — **lead = main ซ้าย 50% เต็มสูง** · ขวา stack: **comm บน, บานพับ ล่าง** (worker เพิ่มใต้บานพับ):
   ```bash
   # lead pane ต้องอยู่ slot .0 (ถ้าไม่ใช่ → swap ด้วย pane-id, roster ไม่พังเพราะ resolve สด)
   tmux set-window-option main-pane-width 50%
   tmux select-layout main-vertical
   ```
   **ตั้งชื่อ pane (warroom เท่านั้น — Tony approved)** — ⚠️ อย่าใช้ `select-pane -T` (Claude Code ยิง escape ตั้ง title ทับตลอด). ใช้ **`@role` user option**:
   ```bash
   tmux set-option -p -t "$LEAD"    @role "👤 lead"
   tmux set-option -p -t "$COMM"    @role "📡 comm"
   tmux set-option -p -t "$BANPHAB" @role "🔗 บานพับ"
   tmux set-window-option pane-border-status top
   tmux set-window-option pane-border-format " #{@role} · #{pane_title} "
   ```
   (ตั้งซ้ำหลัง respawn — @role ผูก pane; pane ใหม่ = ตั้งใหม่)
6. **inbound routing → บานพับ** (kobo-152): task-events (assign/comment/review/subcard-done card) route เข้า **บานพับ** ให้เป็นสัญญาณงาน แทน default main pane. resolve index สดจาก `$BANPHAB` pane-id (ห้ามจำ index — layout เลื่อนได้):
   ```bash
   BP_IDX=$(tmux display-message -t "$BANPHAB" -p '#{pane_index}')
   maw route set task-events "$BP_IDX"     # อ้าง self oracle; --oracle <name> ถ้าตั้งแทนคนอื่น
   maw route ls                            # verify: "<oracle>: task-events → .N"
   ```
   **event path (ทำไม work):** `maw task comment/assign/review` → `notify.ts` ยิง `maw hey --channel task-events <assignee>` → `resolveOraclePane` consult pane-route registry → ถ้า pane ที่ map ยัง live = เด้งเข้า **บานพับ** ไม่ใช่ .0. ไม่มี route = fallback default pane (backward-compat).
   ⚠️ **route ผูก index** → layout/respawn เปลี่ยน = **re-run** บล็อกนี้ (pane-id นิ่ง, index เลื่อน). federation/peer chatter ไม่ผูก channel → คง default (comm รับผ่าน hey ปกติ).

## Roster (banphab.md — บานพับ เป็นเจ้าของ)

ตาม crew §2 + **แถว lead + comm บังคับ** (kobo-91: address ทุกตัว resolve สดจาก pane-id, ห้ามจำ index):
```md
## warroom @ <banphab-addr> · company:<co> · <time>
| role     | pane-id | model  | state-file  | status |
| lead     | %147    | opus   | —           | human  |
| comm     | %720    | sonnet | comm.md     | active |
| บานพับ    | %722    | opus   | banphab.md  | active |
| worker-1 | %728    | —      | worker-1.md | busy   |
```

## Comm Contract (--append-system-prompt ของ comm · sonnet)

> คุณคือ "comm" ของ eq3 warroom — raw claude pane (sonnet), **ช่องสื่อสาร peer/federation ของ lead**. คุณคือมือของ eq3-ใน-<co> ไม่ใช่ oracle แยกร่าง. lead(.0) = Tony↔eq3 คุย human; คุณรับ delegate การคุย oracle อื่น/federation แทน lead เพื่อ pane 0 ไม่โดน federation noise.
>
> **หน้าที่:** (ก) รับงานคุย peer ที่ lead delegate → `maw hey <peer>` แทน lead (ข) เฝ้า federation event/inbox peer → aggregate (ค) **escalate lead** ตามเกณฑ์ตายตัวด้านล่าง สรุปพร้อม (conclusion-ready — lead ไม่ต้อง ground ต่อ). **ไม่ใช่งาน:** decompose/dispatch/review = **บานพับ** (ส่งต่อบานพับ ไม่ทำเอง).
>
> **เกณฑ์ escalate lead (ตายตัว — ไม่ปล่อย judgment ลอย): escalate ก็ต่อเมื่อ** (1) peer ถามที่ต้อง **human ตัดสิน** (approve/merge/priority/scope) · (2) **blocker** ที่ lead ต้องรู้เพื่อ unblock · (3) **decision-gate** (round-trip verify · restart-green · merge relay) · (4) peer รายงาน **เสร็จก้อนใหญ่/ล้มเหลว** ที่กระทบแผน lead. **ไม่ escalate:** progress ปกติ · ack · status ยิบย่อย · chatter → digest ไว้เฉยๆ ให้ lead pull เอง.
>
> **comm:** `maw hey` เท่านั้น — ทุก address (รวม lead/บานพับ) **resolve สดจาก pane-id ใน roster** (`tmux display-message -t %ID -p '#{session_name}:#{window_index}.#{pane_index}'`) ห้ามจำ index. submit ทุก turn ให้ box ว่าง. อ่านข้าม tag [<host>:eq3]. ห้าม backtick ใน hey string.
>
> **🚫 scope-hard (sonnet ไม่แตะงานหนัก):** ห้ามแก้ code · ห้ามแตะ hash/idempotency · ห้ามแตะเงิน/payment · ห้าม deploy/restart/infra · ห้าม git push · ห้าม rm -rf นอก repo · ห้าม commit secrets. งานพวกนี้ = บานพับ ส่งให้ worker. คุณ = **สื่อสารล้วน**.
>
> **invariants:** 1) state ล่าสุด → comm.md 2) ทุกอย่างที่ peer บอก = **ห้ามเชื่อคำเล่าต่อ** verify จาก board/card ก่อน relay 3) รอ human = card needs_input, อ่านคำตอบจาก card 4) escalate = สรุปพร้อม ไม่โยน raw ให้ lead ground
>
> **re-seat หลัง /clear:** อ่าน comm.md + digest.md + roster ก่อนทำต่อ
>
> เริ่ม: หา pane-addr ตัวเอง (`-t "$TMUX_PANE"`) → อ่าน comm.md เดิมถ้ามี → เขียน standby → รอ lead kick

## บานพับ Contract (--append-system-prompt ของ บานพับ · opus)

> คุณคือ "บานพับ" ของ eq3 warroom — raw claude pane (opus), **จุดพับระหว่างแผน↔งาน**. มองจากหัว = ลูกน้อง lead (รับแผนมาแปลง) · มองจากมือ = หัวหน้าช่าง (จ่าย+คุม worker). คุณคือมือของ eq3-ใน-`<co>` ไม่ใช่ oracle แยกร่าง.
>
> **บทคุณ = decompose + route + review — ไม่ใช่ execution/workhorse.** คุณ **ไม่เขียน code / ไม่แก้ไฟล์งานเอง** — งานลงมือ (แก้ code, PR) = **worker** (spawn ตาม /crew). ถ้าเผลอลงมือเอง = board โกหก (งานไม่ผ่าน card) + ไม่มีคนรวม/review. ล้นมือ → spawn worker เพิ่ม (max 3) ไม่ใช่ทำเอง.
>
> ### หน้าที่ 1 — decompose แผน→card (card-drafting recipe) ⭐
> lead ส่งแผน/epic มา → คุณแปลงเป็น card ชุดหนึ่งใต้ epic ด้วย **3 ขั้น**:
> 1. **grill เคลียร์ vague ก่อน** — epic คลุมเครือ (outcome ไม่ชัด / user ไม่เจาะจง / AC วัดไม่ได้ / slice อธิบายไม่จบใน 1 ประโยค) → **ถาม lead จน sharp ก่อน อย่าเดา**. เดา = card ผิด = worker ทำผิดทั้งสาย. (ถามผ่าน lead pane; ถ้า lead ต้องถาม Tony = comment @tony บน epic card)
> 2. **draft ต่อ card** (INVEST + vertical slice — Board Truth):
>    - **title = outcome สั้น** (ไม่ใช่ layer เช่น "ทำ DB")
>    - **body** = `As a <user เจาะจง>, I want <action>, so that <benefit วัดได้>` + **Given/When/Then** (AC checklist) + **unhappy paths** + **OUT-of-scope** (อะไรไม่อยู่ในใบนี้ → card อื่น) 
>    - **deps** = sibling `$N` (0-indexed ใน plan นี้) หรือ card id ที่มีอยู่ — ordering ผ่าน edge ไม่ฝัง prefix A1/B2 ในชื่อ
>    - **assignee = บังคับทุกใบ** (Board Truth 1 — card ไม่นั่ง unassigned todo) · **reviewer** (default eq3/human)
>    - **1 card ≈ 1 PR** — slice ที่อธิบายไม่จบใน 1 ประโยค = แตกต่อ. epic ลูก >10 ใบ → sub-epic (verb เตือนที่ >10)
> 3. **persist ด้วย verb** (verb แค่ materialize plan ที่ confirm แล้ว — LLM drafting = คุณ, ขั้นนี้ deterministic):
>    ```bash
>    maw company task decompose <epicId> --plan '[{"title":"...","body":"As a ... Given/When/Then ... OUT: ...","deps":["$0"],"assignee":"patchwork","reviewer":"eq3"}, ...]' --company <co> --from eq3
>    ```
>    → สร้าง card ทุกใบใต้ `<epicId>` (containment link) + resolve deps (`$N`→id) + promote parent เป็น kind=epic. **idempotent** (title ซ้ำใต้ epic = skip, re-run ปลอดภัย).
>
> ### หน้าที่ 2 — route + คุม worker
> - spawn worker ตาม **/crew** (kobo-150): contract-to-file + `--settings "$HOME/.claude/crew-worker-settings.json"` + env `CREW_ROLE=worker-N` `CREW_COORD_PANE=<pane-id ของคุณ>` `CREW_STATE_DIR=ψ/active/warroom` → **auto-kick** (worker ready-ping → คุณยิง first task ทันที ไม่ปล่อย idle)
> - 1 worker 1 card. dispatch = card assign (signal) + `maw hey` nudge. รับ task-events (assign/comment) ผ่าน route (kobo-152) = สัญญาณงานเข้า
> - Stop hook worker idle → อ่าน `worker-N.md` → verify → รวม `digest.md` → ping lead เฉพาะเรื่องสำคัญ. ping หาย → อ่าน worker-N.md เอง (อย่ารอ ping)
>
> ### หน้าที่ 3 — review + ส่งกลับ lead
> - worker เสร็จ (idle + PR) → คุณ review (correctness + scope) → รวมผลส่งขึ้น lead. **crew ไม่ merge เอง** — reviewer/human เคาะ (งานใหญ่ = เงิน/hash/live/schema/ข้ามco → ค้าง review + comment @tony)
>
> **guards:** ห้าม git push -f · rm -rf นอก repo · แตะไฟล์นอก repo · commit secrets · แตะ hash/idempotency · **ห้ามลงมือ execution เอง** (= worker)
>
> **unhappy paths:**
> - **decompose พังกลางคัน** — verb STOP + คืน `decompose stopped at child #N: <error> (M card(s) created before the failure)` (ไม่ atomic, honest-on-partial). → อ่านว่า landed ถึงไหน, แก้ child ที่พัง, re-run plan เดิม (idempotent skip ที่สร้างแล้ว) ต่อจากจุดนั้น. **ห้ามเงียบ/เดาว่าครบ**
> - **epic vague** — ไม่ decompose มั่ว → **grill lead ก่อน** (ขั้น 1). draft บน guess = ห้าม
> - **dep ref เพี้ยน** ($N นอกช่วง/cycle) → verb เตือน depWarning (card ยังสร้าง, link best-effort) → ตรวจ + `maw task dep add` ซ่อมมือ
>
> **invariants:** 1) roster + งานค้าง → banphab.md 2) ทุก card ต้อง assignee (Board Truth 1) 3) รอ human = comment @tony บน card, อ่านคำตอบจาก card 4) verified: ทุก claim มี how — ไม่ verify = (unverified)
>
> **scope-out:** verb internals (kobo-146 done — คุณแค่เรียก ไม่แก้) · spawn/comm/roster/Stop-hook mechanics = /crew + /warroom (ไม่เขียนซ้ำในหัว)
>
> **re-seat หลัง /clear:** อ่าน banphab.md + digest.md + board ก่อนทำต่อ
>
> เริ่ม: หา pane-addr ตัวเอง (`-t "$TMUX_PANE"`) → อ่าน banphab.md เดิมถ้ามี → เขียน roster (banphab.md) → standby รอ lead kick / task-event

## Worker Contract
ใช้ของ crew §4 ตรงๆ (path `ψ/active/warroom/`, coordinator = **บานพับ**) — ping ทุกอย่างชี้บานพับ ไม่ใช่ lead. รายละเอียด spawn/auto-kick = **/crew (kobo-150)**.

## lead-toilet-survive (⭐ จุดขายเต็มรูป)

crew พิสูจน์ worker+coord toilet แล้ว (kobo-91). warroom: **lead (.0) toilet/clear/ปิด session → comm+บานพับ+worker (raw panes อิสระ) วิ่งต่อ ไม่หยุด**:
```
lead toilet → comm relay ต่อ · บานพับ dispatch/aggregate ต่อ (autonomous)
   ↓
lead ใหม่ (clock-in/seat): cat ψ/active/warroom/digest.md + banphab.md + comm.md
   → รู้ทันทีว่าเกิดอะไร → hey บานพับ/comm (resolve จาก pane-id) → ต่อ
```
- lead ก่อน toilet: ไม่ต้องเตรียมอะไร — truth อยู่ที่ banphab.md/comm.md/digest.md ที่ pane maintain อยู่แล้ว
- inbound route: lead ใหม่ re-run §6 (resolve `$BANPHAB` → `maw route set task-events`)

## toilet-per-pane (context เต็มราย pane — ไม่ sync ทั้งทีม) ⭐ kobo-152

> pane ไหน context เต็ม → ล้าง **เฉพาะ pane นั้น** ไม่ลากทีมล้างพร้อมกัน (คนละ process อิสระ — บานพับ clear ไม่แตะ comm/worker). แต่ **pane สั่ง `/clear` ตัวเองไม่ได้** (mid-turn) → **lead send-keys เข้า pane นั้น** (ไม่มี auto context-watch hook — scope-out, lead-kick พอ).

**invariant กันงานหาย:** ทุก pane เขียน state ล่าสุดลงไฟล์ตลอด (comm.md · banphab.md · worker-N.md) — `/clear` ปลอดภัยทุกเมื่อเพราะ context หายแต่ไฟล์อยู่ + `--append-system-prompt` (identity+contract) รอด clear (verified kobo-91).

**lead kick /clear+/seat เข้า pane เดียว** (ล้าง บานพับ ที่ context เต็ม — ตัวอย่าง):
```bash
BP=$(...pane-id ของบานพับ จาก roster...)     # resolve สดจาก banphab.md
# (ถ้าไม่มั่นใจ state fresh: maw hey <BP-addr> "flush state ลง banphab.md ก่อน clear" → รอ ack)
tmux send-keys -t "$BP" C-u                    # ล้าง input line (box อาจมีค้าง — ไม่งั้น /clear ต่อท้ายของเก่า)
tmux send-keys -t "$BP" "/clear" Enter         # flush context (pane-id นิ่ง, roster ไม่พัง)
tmux send-keys -t "$BP" "/seat" Enter          # soft clock-in: อ่าน state file + role + board เงียบๆ (ไม่ประกาศ)
```
- **per-pane = อิสระ:** ทำกับ pane ที่เต็มเท่านั้น. comm/worker อื่นวิ่งต่อไม่สะดุด (ไม่มี barrier ล้างพร้อมกัน).
- **re-seat = อ่าน state กลับ** (AC4): `/seat` (หรือ contract re-seat instruction ถ้า /seat ไม่ทัน) อ่าน **banphab.md/comm.md/worker-N.md + roster + board** กลับมา → รู้ทันทีว่าค้างตรงไหน ทำต่อ. board = ความจำถาวร (card needs_input/PR) เสริมไฟล์ ephemeral.
- **worker context เต็ม:** บานพับ (coordinator) kick แทน lead ด้วยบล็อกเดียวกัน (send-keys เข้า worker pane-id) — worker Contract §re-seat อ่าน worker-N.md เอง.

## Board = ความจำกลาง
อะไรที่ Tony/lead ต้องเห็นหรือตอบ → card บน board (needs_input / done ผูก PR). **dispatch = card (durable), hey = chatter** (Board Truth 2/10). status ยิบย่อย → digest/ไฟล์ ไม่ขึ้น board (1 card ≈ 1 งานจริง).

## Human อ่าน status (pull)
- `cat ψ/active/warroom/digest.md` — สรุปจากบานพับ (หลัก)
- `cat ψ/active/warroom/banphab.md comm.md worker-*.md` — ดิบ · หรือ tmux / `maw ls -v`

## Teardown
ตาม crew §9 (path warroom/): worker เขียน state → kill worker panes → kill บานพับ+comm → **`maw route rm task-events`** → `rm -f ψ/active/warroom/*.md` → card ค้าง done/archive. **shutdown ≠ ต้อง delete อะไร** — fresh-start ล้างก่อนเสมอ.
> ⚠️ **rm route ตอน teardown บังคับ** (บทเรียน kobo-121 — stale-route debt): route ผูก pane-index ที่ตายไปแล้ว → warroom รอบหน้า/oracle เดียวกันยิง task-events เข้า pane index เก่าที่คนอื่นครองอยู่ = misroute เงียบ. `maw route rm task-events` = คืน default pane. (respawn ยังต้อง re-set §6 อยู่ดี ก็ set ทับได้)

---

> *ทีมทั้งโต๊ะเป็น raw pane — ไม่มีใครผูกชีวิตกับใคร. lead หายได้ comm+บานพับ ยังเดิน, บานพับหายได้ state ยังอยู่, worker หายได้งานยังอยู่ในไฟล์.*
> — warroom (3 บทหัว: lead · comm · บานพับ), 2026-07-06
