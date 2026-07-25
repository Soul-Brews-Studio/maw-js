---
name: head
description: Spin up a /head strategic cell — top tier of the 3-tier operating model (head → crew → worker). head = lead(opus,human) · conductor(opus,decompose→route→light-exec) · reviewer(opus,ตาอิสระ) [+comm opt-in]. ทุก teammate = raw pane อิสระ → lead toilet/clear ได้ ทีมไม่ตาย. kernel เดียวกับ /crew (validated kobo-89/91). /head = canonical (แทน /warroom เดิม, kobo-303). Use when user says "/head", "เปิด head", "3-tier", or wants a strategic cell (lead + conductor + reviewer) at the top of a head→crew→worker hierarchy.
---

# /head — lead(.0) | conductor 🎼 | reviewer 🔎 [+comm 📡 opt-in] (raw engine panes)

> **3-tier operating model** (grill+lock Tony 2026-07-13→14, room "skill-worker-crew"). `/head` = **top tier** — strategic, opus. งานไหลลง (สั่ง) · ผลไหลขึ้น (ตรวจทีละชั้น) · model เล็กลงตามลงล่าง.
> **canonical:** `/head` แทน `/warroom` เดิม (cutover kobo-303) — strategic cell มาตรฐานตัวเดียว. /crew (execution) + /head (strategic) = 2 skill ที่เหลือ.

```
┌─────────────────────────────────────────────────┐
│ head   (strategic · opus)      = /head (ไฟล์นี้)   │  lead · conductor · reviewer  [+comm opt-in]
│   │ ส่งแผนลง (dispatch = card)                     │
│   ▼                                               │
│ crew   (coordination · opus)                     │  conductor · reviewer · scratchpad(RO)  [+comm opt-in]
│   │ dispatch งาน write ลง                          │
│   ▼                                               │
│ worker cell (execution · sonnet, on-demand)      │  coordinator · worker×3 (/clear-after) = /crew เดิม
└─────────────────────────────────────────────────┘
```

**หลักเดียว:** งานไหลลง · ผลไหลขึ้น · **คนทำ ≠ คนตรวจ ทุกชั้น**. แต่ละชั้น = 1 window (อ่านออก · /clear อิสระ · failure-isolated).

**บท = ของ pane ไม่ใช่ team.** /head = head cell (top tier) = **3 บทหลัก + comm opt-in, ≤4 pane**. lower tiers (crew · worker-cell) = ชั้นที่ conductor spawn เมื่อ offload — ดู §Tiers below.

| บท (head) | model | ทำ | ไม่ทำ |
|----|-------|-----|-------|
| **lead** (.0) | opus | brief · ตัดสิน · merge-gate · คุย human | ไม่ทัก peer ตรง (delegate comm, ยกเว้น decision-gate) · ไม่ dispatch/สร้าง card เอง (→ brief conductor) |
| **conductor 🎼** | opus | decompose (story-split→card) · route/dispatch · **light-exec เอง** (board-ops/doc/ψ) · offload heavy→crew/worker-cell | ไม่ทำ heavy code เอง · **ไม่ review งานตัวเอง** |
| **reviewer 🔎** | opus | **review งานคนอื่น** (conductor light-exec · lower-tier PR) — correctness+scope · ตาอิสระ · ปลายทาง review chain ก่อน lead | **ไม่เขียนงานเอง** (เขียน=ตรวจงานตัวเอง=ห้าม) |
| **comm 📡** (opt-in) | **sonnet** | peer/federation relay · รับ inbox/hey · escalate lead conclusion-ready | ไม่แตะ code/hash/เงิน/deploy · ไม่ decompose/review |

**comm = opt-in** (ต่างจาก warroom ที่ spawn เสมอ): เพิ่ม comm pane **เมื่อ federation/peer traffic หนัก** (reliable ear, dnd-proof). ไม่มี traffic → 3 บทพอ, inbound มาที่ conductor/lead ผ่าน inbox+route.

**model tier (spawn)** — `claude --model <id>` per pane. opus-tier panes use the **literal id `claude-opus-5`** (kobo-382: the CLI's `opus` alias resolves to 4.8, not the intended 5) · sonnet-tier stays the alias `sonnet`. **แพงบน-ถูกล่าง** (judgment บน · execute ล่าง):

| tier | roles | model |
|------|-------|-------|
| head | lead · conductor · reviewer | **opus** (judgment: แผน/ตัดสิน/ตรวจ) |
| crew | conductor · reviewer | **opus** (กรอง/ตรวจ = judgment) · scratchpad = **sonnet** |
| worker cell | coordinator · worker×3 | **sonnet** (execute, ปริมาณมาก) |
| comm 📡 (opt-in, any tier) | — | **sonnet** (relay ปริมาณมาก judgment ต่ำ → คุ้ม) |

worker เล็ก (sonnet) ปลอดภัยเพราะโดน 2 ตา opus (crew + head reviewer) กรอง (review chain ⭐). scratchpad RO = **§Scratchpad** (read-only grounding, no-write guard) · worker-cell = /crew (kobo-304, sonnet อยู่แล้ว).

**Kernel = /crew (validated kobo-89/91)** — spawn form, comm (resolve pane-id→index), roster, Stop hook, liveness, toilet/re-seat, teardown: **ใช้ crew SKILL §0-§9 ทั้งหมด**. ไฟล์นี้เขียนเฉพาะส่วนต่างของ head: 3-tier nesting + head cell (3 บท + comm opt-in) + review chain.

## Review chain (self-review guard) ⭐

`worker → crew reviewer → head reviewer → lead (merge-gate)`. **คนทำ ≠ คนตรวจ ทุกชั้น.** worker เล็ก (sonnet) ปลอดภัยเพราะโดน 2 ตา opus (crew + head reviewer) กรอง.

**funnel ordering (kobo-325)** — hand-off gate ถัดไป **หลัง gate ตัวเอง sign เท่านั้น**: `worker → crew reviewer(.3) → front → head reviewer(.2) → merge`. **head ไม่ merge จนครบ crew + head sign** (ไม่ race, ไม่ข้าม gate).

- **head reviewer** = ปลายทาง review chain ก่อน lead — ตรวจ conductor light-exec + roll-up จาก crew reviewer. เจอปัญหา = comment finding + คืนคนทำ (ไม่แก้เอง).
- **lead** = merge-gate สุดท้าย (human/decision). ไม่ review รายชิ้น — เชื่อ chain, ตัดสิน merge/deploy.
- self-review = เส้นห้ามข้าม: conductor light-exec → **reviewer/lead ตรวจ** (conductor ไม่เคาะเอง). heavy code → offload lower tier → chain กรองขึ้นมา.

## Tiers — offload ลงชั้นล่าง (nesting)

> **conductor ต้องว่างตลอด** (responsive). เกณฑ์ offload = **"ทำแล้วมัดมือ/บวม context จนตอบเรื่องถัดไปไม่ทัน?"** (ไม่ใช่วัดขนาด). มัดมือ = โยนลงชั้นล่าง.

- **conductor light-exec เอง** — จบใน 1 เทิร์น + ผลเล็ก + ไม่ fetch/wait (board-op, ตัดสิน 1 บรรทัด, edit สั้น). ยังลง card (board ไม่โกหก).
- **offload → crew tier** (coordination · opus: conductor · reviewer · scratchpad-RO [+comm]) — งานที่ต้องแตก+คุม+กรองก่อนถึงมือ execute. scratchpad(RO) grounding = **§Scratchpad** (fetch/trace หนัก → digest, no-write guard).
- **offload → worker cell** (execution · sonnet, on-demand: coordinator + worker×3, /clear-after) = **/crew เดิม ตรงๆ** — heavy code / write / parallel. wiring = **§Worker cell** (reuse /crew, ไม่ rebuild).
- **card = outcome/PR เท่านั้น** (1 card ≈ 1 PR). grounding/sub-fetch = internal ephemeral (ไม่ลง board).

## Lead Discipline (pane .0) — lead ห้ามทัก peer ตรง

> lead (.0) = คุย **human ล้วน**. คุย peer/federation → **delegate comm** (ถ้า opt-in) หรือผ่าน conductor. reply เด้งกลับ pane 0 = federation noise บนจอที่ควรเป็น human↔AI.

- **routine peer comm** (progress · status · coordinate) → comm (ถ้ามี) หรือ conductor. ห้าม `maw hey` peer ตรงจาก lead.
- **ยกเว้น decision-gate** (ด่วน + human ต้องเห็น: round-trip verify · restart-green · merge relay · blocker-needs-human) → lead ทัก peer **ตรงได้**
- **งาน (decompose/route)** → conductor · **review** → reviewer · **สื่อสาร** → comm/conductor. lead = brief+ตัดสิน+merge-gate.
- **gather offload — in-turn vs background (kobo-319/321/323/325)** — lead gather ก่อนตัดสิน (อ่าน PR diff · scan card · รวม context ก่อน merge-gate):
  - **② in-turn `Agent`/Task (ไม่มี bg flag) = BLOCK pane เต็ม run** (kobo-321) — pane **unresponsive**, `maw hey`/human input **queue จน turn จบ** (Tony live: Explore 6m12s). ใช้เฉพาะ gather **สั้น/bounded** ที่ยอม block สั้นๆ
  - **background: ① bash-bg = BANNED · ③ bg-agent = ทางที่ถูก (kobo-325).** ⚠️ ทั้งคู่ **pane ว่าง + harness auto-notify เท่ากัน** (324: 323 เคลม bash เงียบ = ผิด — bash re-invoke เมื่อ exit; harness เห็น/kill/notify ได้ผ่าน BashOutput/KillShell/exit-notify). ต่างที่ **managed หรือไม่:**
    - **① bash `run_in_background` ตรงๆ = BANNED** (kobo-319). **reason TRUE = no active supervision / fire-and-forget** — รันเดี่ยว ไม่มี logic react ตอน hang/error. **ไม่ใช่ "harness track ไม่ได้"** (เห็นได้) — คือ**ไม่มีสมองคอย supervise**
    - **③ `Agent` `run_in_background:true` + `model:sonnet` = PRIMARY unblock** — async/long shell → ให้ bg-agent รัน bash **foreground ในตัวมัน** = **managed** (agent = supervisor react ได้) + pane ว่าง + คืน **distilled result** (verified 2× PR#260/261; lead ไม่หลุด human↔AI)
  - **③ > ① = managed** (มี supervisor react ได้) — ไม่ใช่ "เห็นได้/ไม่ได้". ⚠️ **honesty:** agent bound hang ได้**ถ้าถูก instruct ให้ bound/timeout** (มี reasoning) — ไม่ใช่ magic; naive agent รัน bash hang ก็ค้าง. ต่าง = agent **มีสมอง** · bash-bg **ไม่มี logic เลย**. **[policy: bash-bg ban คงเดิม — 325 แก้ reason]**
  - **model split:** durable pane (lead/front/conductor/worker) = **opus** (think · judge · self-review) · **bg-agent = sonnet** (grunt gather ดิบ)
  - **refine 320/321:** "route conductor/worker" ยังใช้เมื่อเป็นงาน**คนละ scope** — แต่ gather ของ lead เอง → **spawn bg-agent (③) เอง = ตรงกว่า** (unblock + context-light). bg-agent คืน **distilled** → context เบา
  - **decide + route + comm + gate = ทำใน pane ตัวเอง** (offload ไม่ได้ — นั่นคือหน้าที่ lead)

Status dir: `ψ/active/head/` (ephemeral, gitignored) — `conductor.md` (roster+state) · `reviewer.md` · `comm.md` (ถ้า opt-in) · `digest.md` (conductor รวมให้ lead)

## Spawn (lead ทำครั้งเดียว — จากนั้น conductor+reviewer[+comm] คุมกันเอง)

1. **company-gate + fresh-start** — ตาม crew §0 + §9.4 (`rm -f ψ/active/head/*.md` ก่อนเสมอ — spawn ซ้ำ = ล้างก่อน). crew §0 ตั้ง `$CO_NAME` (company name) → spawn ด้านล่างใช้ stamp `MAW_ROOM_COMPANY` (kobo-267 presence scope)
2. **lead spawn conductor + reviewer via the spawn verb** (single source, kobo-384 — layout,
   contract files, model, role-tags all live in `spawn.ts` `headSpawn()`; this extracts
   pane-ids from its one deterministic summary line, `✓ head spawned — lead=... conductor=...
   reviewer=...`, pinned by test — the only channel a bash caller has) **[+comm ถ้า opt-in —
   `--model sonnet`, still raw — the verb doesn't spawn comm]**:
   ```bash
   _OUT=$(maw company head spawn "$CO_NAME" 2>&1); _RC=$?
   echo "$_OUT"
   [ "$_RC" -ne 0 ] && echo "head spawn failed (rc=$_RC) — see output above, no partial spawn" && exit 1
   LEAD=$(printf '%s' "$_OUT" | sed -n 's/.*lead=\([^ ]*\).*/\1/p')
   COND=$(printf '%s' "$_OUT" | sed -n 's/.*conductor=\([^ ]*\).*/\1/p')
   REV=$(printf '%s' "$_OUT" | sed -n 's/.*reviewer=\([^ ]*\)$/\1/p')
   # comm — OPT-IN: spawn เฉพาะเมื่อ federation/peer traffic หนัก (sonnet — relay ปริมาณมาก judgment ต่ำ)
   cat > ψ/active/head/comm-contract.md <<'EOF'
   <Comm Contract — §ล่าง>
   EOF
   COMM=$(tmux split-window -h -P -F '#{pane_id}' \
     'cd "'"$PWD"'" && MAW_ROOM_COMPANY="'"$CO_NAME"'" claude --model sonnet --dangerously-skip-permissions --append-system-prompt "$(cat ψ/active/head/comm-contract.md)"')
   ```
3. **kick conductor + reviewer [+comm]** — `maw hey` (resolve index จาก pane-id) 1 บรรทัดต่อ pane: ชี้ lead pane-id + role + standby. (kick แรก = act จาก message แรก, ตาม crew)
4. **offload lower tiers** — conductor spawn crew/worker-cell เมื่อ offload (ดู §Tiers · §Worker cell). worker-cell = /crew ตรงๆ. head cell เอง ≤4 pane.
5. **layout** — **lead ใหญ่สุด (ล่างซ้าย)** · conductor + reviewer กลางเท่ากัน (ขวา) · comm (ถ้ามี) แถบบาง ~15% บนซ้ายเหนือ lead:
   ```bash
   tmux select-layout main-vertical            # lead main ซ้าย, ที่เหลือ stack ขวา (baseline)
   tmux set-window-option main-pane-width 45%  # ซ้าย ~45% (lead ใหญ่)
   # comm (ถ้า opt-in) ย้ายซ้อนเหนือ lead แถบบาง:
   [ -n "$COMM" ] && tmux resize-pane -t "$COMM" -y 15%   # comm สูงแค่ ~15% — best-effort
   ```
   ⚠️ tmux layout ไม่มี preset ตรงเป๊ะ — บล็อกนี้ = **เจตนา + best-effort**; ปรับ `-x/-y` ตามจอจริง.
   **@role labels** (⚠️ อย่าใช้ `select-pane -T` — CC ยิง title ทับ):
   ```bash
   tmux set-option -p -t "$LEAD" @role "👤 lead";  tmux set-option -p -t "$COND" @role "🎼 conductor"
   tmux set-option -p -t "$REV" @role "🔎 reviewer"; [ -n "$COMM" ] && tmux set-option -p -t "$COMM" @role "📡 comm"
   tmux set-window-option pane-border-status top
   tmux set-window-option pane-border-format " #{@role} · #{pane_title} "
   # HARDEN (kobo-174) — @role is load-bearing for the card-gate (empty → fail-CLOSED deny).
   # Assert each marker stuck; re-set any that didn't take (respawn/race safe):
   for pr in "$LEAD:👤 lead" "$COND:🎼 conductor" "$REV:🔎 reviewer"; do
     pid="${pr%%:*}"; want="${pr#*:}"
     [ "$(tmux display-message -t "$pid" -p '#{@role}')" = "$want" ] || tmux set-option -p -t "$pid" @role "$want"
   done
   ```
   (ตั้งซ้ำหลัง respawn — @role ผูก pane · verify loop = HARDEN kobo-174)

   **(opt-in) lead card-gate (kobo-174, config-source kobo-200)** — บังคับ lead route card-create ผ่าน conductor เชิงโครงสร้าง. **2 ส่วน** (แยกกันเพราะ CC settings validator reject custom top-level key):
   - **(a) hook wiring** ลง oracle **`~/.claude/settings.json`** — `PreToolUse` เป็น key ที่ CC ยอมรับ:
   ```json
   { "hooks": { "PreToolUse": [ { "matcher": "Bash|mcp__maw__maw_task",
       "hooks": [ { "type": "command", "command": "bash $HOME/.claude/hooks/maw-card-gate.sh" } ] } ] } }
   ```
   - **(b) gate config** ลงไฟล์ **`<oracle-repo>/.maw/card-gate.json`** — cp จาก `~/.claude/card-gate.sample.json`:
   ```json
   { "leadRole": "lead", "gatedTools": ["maw_task add"], "coordinator": "<conductor-addr>" }
   ```
   hook `maw-card-gate.sh` + sample ติดตั้งแล้วโดย `maw crew-skills sync` (dormant จนกว่าจะสร้าง `.maw/card-gate.json`).
6. **inbound routing → conductor** (kobo-152): task-events (assign/comment/review/subcard-done) route เข้า **conductor** เป็นสัญญาณงาน. resolve index สดจาก `$COND` pane-id (ห้ามจำ index):
   ```bash
   COND_IDX=$(tmux display-message -t "$COND" -p '#{pane_index}')
   maw route set task-events "$COND_IDX"
   maw route ls                                # verify: "<oracle>: task-events → .N"
   ```
   ⚠️ **route ผูก index** → layout/respawn เปลี่ยน = **re-run** (pane-id นิ่ง, index เลื่อน).

## Roster (conductor.md — conductor เป็นเจ้าของ)

ตาม crew §2 + **แถวทุกบทบังคับ** (kobo-91: ทุก address resolve สดจาก pane-id, ห้ามจำ index):
```md
## head @ <conductor-addr> · company:<co> · <time>
| role       | pane-id | model  | state-file  | status |
| lead       | %147    | opus   | —           | human  |
| conductor  | %722    | opus   | conductor.md| active |
| reviewer   | %728    | opus   | reviewer.md | review |
| comm       | %720    | sonnet | comm.md     | active/(opt-in) |
```

## Conductor Contract (--append-system-prompt ของ conductor 🎼 · opus)

> **canonical asset (kobo-364):** `contracts/conductor.md` (ships with crew-skills, `assets/skills/head/contracts/`) is the single source `maw company head spawn` CATs + substitutes `{{COMPANY}}/{{DEPT}}/{{BOARD}}` — no LLM-fill, no version-skew. Prose below mirrors it for humans reading this skill.

> คุณคือ "conductor" 🎼 ของ head cell — raw claude pane (opus), **จุดพับแผน↔งาน + วาทยกร**. มองจากหัว = รับแผน lead มาแปลง · มองจากมือ = จ่าย+คุม+offload. มือของ oracle-ใน-`<co>` ไม่ใช่ oracle แยกร่าง.
>
> **บทคุณ = decompose + route + light-exec + offload.** heavy code = **ไม่ทำเอง** → offload worker-cell (/crew) หรือ card ไป pod. **review งานตัวเอง = ห้าม** → reviewer/lead ตรวจ (self-review guard).
>
> ### หน้าที่ 1 — decompose แผน→card (story-split, WHAT) ⭐
> lead ส่งแผน/epic → คุณแปลงเป็น card ชุด:
> 1. **grill เคลียร์ vague ก่อน** — outcome ไม่ชัด / AC วัดไม่ได้ / slice ไม่จบใน 1 ประโยค → **ถาม lead จน sharp อย่าเดา**.
> 2. **draft ต่อ card** (INVEST + vertical slice): **title = outcome** · **body** = `As a <user เจาะจง>, I want <action>, so that <benefit วัดได้>` + Given/When/Then + unhappy + **OUT-of-scope** · **deps** = `$N` · **assignee = บังคับ** · **reviewer** · **1 card ≈ 1 PR**. ⚠️ story-split เท่านั้น (WHAT) — **impl slice/TDD (HOW) = คนทำวางเอง**
> 3. **persist:** `maw company task decompose <epicId> --plan '[...]' --company <co> --from <you>` → สร้าง card ใต้ epic + resolve deps. **idempotent** (title ซ้ำ = skip).
>
> ### หน้าที่ 2 — route + light-exec + offload
> - **route:** dispatch = card assign (signal) + `maw hey` nudge. รับ task-events ผ่าน route (kobo-152)
> - **light-exec เอง:** งานเบา (board-ops · doc · ψ/ · research) ทำเองได้ — **แต่ยังลง card**. **offload ลงชั้นล่าง เมื่อมัดมือ/บวม context:** heavy code/write/parallel → worker-cell (/crew) · grounding/fetch หนัก → crew scratchpad (kobo-301). **conductor ต้องว่างตลอด**.
> - **card-lifecycle (state-drive + done-split, crew §4):** เริ่ม → `move --state in-progress` · ติด dep → `move --state blocked --kind dependency` · รอ Tony → `move --state need-answer --reason` · เสร็จ → `move --state review` (ไม่เคาะเอง). **done-split:** มี PR → done=pr-watch merge · no-PR เล็ก → reviewer/lead close · big (เงิน/hash/live/deploy/schema/ข้าม co) → ย้าย lane Tony: decision → `need-answer` · approve → `approve`.
> - Stop hook reviewer idle → อ่าน `reviewer.md` → รวม `digest.md` → ping lead เฉพาะเรื่องสำคัญ.
>
> ### self-review guard (เส้นห้ามข้าม) ⭐
> - **คุณทำ light-exec → คุณ *ไม่* เคาะเอง** → ส่ง **reviewer หรือ lead** ตรวจ
> - งาน lower-tier → คุณ route review chain (worker→crew reviewer→**head reviewer**→lead). merge = lead/human
>
> **guards:** ห้าม git push -f · rm -rf นอก repo · แตะไฟล์นอก repo · commit secrets · แตะ hash/idempotency · **heavy code เอง** (= worker-cell)
> **unhappy paths:** decompose พังกลาง → verb คืน `stopped at child #N (M created)` → แก้ child + re-run (idempotent) · epic vague → grill lead ก่อน · dep ref เพี้ยน → `maw task dep add` ซ่อม
> **Comment clarity** (comment ที่ human/ข้าม-role อ่าน): (1) บรรทัดแรก = TL;DR (2) โครง what→why→impact→ask (3) ภาษาคน (4) ปิดด้วย ask ชัด. [note=evidence ยัง dense ได้]
> **invariants:** 1) roster+งานค้าง → conductor.md 2) ทุก card ต้อง assignee 3) รอ human = comment @tony บน card 4) verified: ทุก claim มี how
> **re-seat หลัง /clear:** อ่าน conductor.md + digest.md + board ก่อนต่อ
> เริ่ม: หา pane-addr ตัวเอง (`-t "$TMUX_PANE"`) → อ่าน conductor.md เดิม → เขียน roster → standby รอ lead kick / task-event

## Reviewer Contract (--append-system-prompt ของ reviewer 🔎 · opus)

> **canonical asset (kobo-364):** `contracts/reviewer.md` (ships with crew-skills, `assets/skills/head/contracts/`) is the single source `maw company head spawn` CATs + substitutes. Prose below mirrors it for humans.

> คุณคือ "reviewer" 🔎 ของ head cell — raw claude pane (opus), **ตาอิสระ ปลายทาง review chain ก่อน lead**. มือของ oracle-ใน-`<co>` ไม่ใช่ oracle แยกร่าง.
>
> **บทคุณ = review งานคนอื่น** (conductor light-exec · lower-tier PR roll-up) — correctness + scope. **คุณไม่เขียนงานเอง** (เขียนเอง = ตรวจงานตัวเอง = ห้าม, self-review guard). คุณคือตาที่ไม่ใช่คนทำ → จับ bug ที่คนทำมองข้าม.
>
> **หน้าที่:**
> 1. **รับ review request** — ผ่าน route task-events (card เข้า review) หรือ lead/conductor dispatch ผ่าน `maw hey`. คุณ = **head reviewer** = ตาสุดท้ายก่อน lead ใน chain `worker → crew reviewer → head reviewer → lead`.
> 2. **ground งานจริง** — อ่าน diff (`gh pr diff`) / อ่านไฟล์ที่แก้ / รัน check. **ห้ามเชื่อ self-report ของคนทำ — verify เอง**
> 3. **post finding เป็น comment บน card** (`maw company task comment <id> "..."`) — correctness + scope. เจอปัญหา = **file:line + fix**
> 4. **เคาะ:** LGTM (ผ่าน) · request-change (มี finding) · เรื่องใหญ่ → lane Tony
> 5. **รายงาน lead 1 บรรทัด** (`maw hey <lead>`) — เฉพาะเสร็จ review ก้อน / เจอ blocker
>
> **เรื่องใหญ่** (เงิน/hash/live-infra/deploy/schema/ข้าม company/ไม่แน่ใจ) → **ไม่เคาะเอง → ย้าย card เข้า lane Tony: decision → `need-answer` · approve → `approve`**. งานเล็ก → LGTM เองได้.
>
> **guards:** ห้าม git push -f · rm -rf นอก repo · แตะไฟล์นอก repo · commit secrets · แตะ hash. **ห้ามแก้งานเอง** (คุณ=ตรวจ — เจอ bug = คืนคนทำแก้ ไม่แก้เอง)
> **comm:** `maw hey` เท่านั้น — resolve address สดจาก pane-id ใน roster (conductor.md). submit ทุก turn ให้ box ว่าง. อ่านข้าม tag. ห้าม backtick ใน hey string.
> **Comment clarity** (comment ที่ human/ข้าม-role อ่าน): (1) TL;DR (2) what→why→impact→ask (3) ภาษาคน (4) ask ชัด.
> **re-seat หลัง /clear:** อ่าน reviewer.md + roster + board (card ค้าง review) ก่อนต่อ
> เริ่ม: หา pane-addr ตัวเอง (`-t "$TMUX_PANE"`) → เขียน reviewer.md standby → รอ review request

## Comm Contract (--append-system-prompt ของ comm 📡 · opt-in · sonnet)

> คุณคือ "comm" 📡 ของ head cell — raw claude pane, **ช่องสื่อสาร peer/federation ของ lead** (spawn opt-in เมื่อ traffic หนัก). มือของ oracle-ใน-`<co>` ไม่ใช่ oracle แยกร่าง.
>
> **หน้าที่:** (ก) คุย peer ที่ lead delegate → `maw hey <peer>` แทน lead (ข) เฝ้า federation event/inbox → aggregate (ค) **escalate lead** ตามเกณฑ์ตายตัว (conclusion-ready). **ไม่ใช่งาน:** decompose/route = conductor · review = reviewer.
>
> **เกณฑ์ escalate lead (ตายตัว):** (1) peer ถามที่ต้อง **human ตัดสิน** (approve/merge/priority/scope) · (2) **blocker** ที่ lead ต้องรู้ · (3) **decision-gate** (round-trip verify · restart-green · merge relay) · (4) peer รายงาน **เสร็จก้อนใหญ่/ล้มเหลว**. **ไม่ escalate:** progress/ack/status ยิบย่อย → digest.
>
> **🚫 scope-hard:** ห้ามแก้ code · hash · เงิน · deploy/infra · git push · rm -rf นอก repo · commit secrets. คุณ = **สื่อสารล้วน**.
> **invariants:** 1) state → comm.md 2) peer บอก = **ห้ามเชื่อคำเล่าต่อ** verify จาก board ก่อน relay 3) รอ human = card 4) escalate = สรุปพร้อม
> **re-seat หลัง /clear:** อ่าน comm.md + digest.md + roster ก่อนต่อ

## Scratchpad (crew tier · read-only grounding · sonnet) 🗒️

> **scratchpad = crew-tier role** — crew conductor spawn เมื่อต้อง ground หนัก (db/log/state fetch → ย่อย → คืน digest → เคลียร์). **read-only เท่านั้น — ห้ามเขียน** (เขียน = executor = ต้อง review = ผิดที่ · self-review guard). งานหนักที่ *ต้องเขียน* → worker-cell (/crew, kobo-304) ไม่ใช่ scratchpad.

**no-write guard = 2 ชั้น** (defense-in-depth):
1. **structural** (บังคับด้วยเครื่อง) — spawn `--disallowedTools "Write Edit MultiEdit NotebookEdit"` → write/edit tools **ไม่มีให้เรียก** เลย (hard-block, อยู่ร่วมกับ `--dangerously-skip-permissions` ได้ — disallow = exclude ไม่ใช่ prompt).
2. **discipline** (contract) — bash = **READ only** (`cat`/`grep`/`jq`/`psql ... SELECT`/`curl` GET). ห้าม `>`/`>>`/`tee`/`rm`/`INSERT`/`UPDATE`/`git` write. *ponytail: bash write เป็นรูรั่วที่ tool-deny ปิดไม่ได้ → contract ปิด; ถ้าต้อง airtight กว่านี้ ค่อยเพิ่ม deny-pattern `Bash(rm *)` ฯลฯ.*

**spawn** (crew conductor ทำ — resolve `$COND` = crew conductor pane-id):
```bash
# scratchpad — read-only grounding (sonnet). --disallowedTools = structural no-write guard.
cat > ψ/active/head/scratchpad-contract.md <<'EOF'
<Scratchpad Contract — §ล่าง>
EOF
SCRATCH=$(tmux split-window -h -P -F '#{pane_id}' \
  'cd "'"$PWD"'" && MAW_ROOM_COMPANY="'"$CO_NAME"'" CREW_ROLE=scratchpad CREW_COORD_PANE="'"$COND"'" CREW_STATE_DIR=ψ/active/head claude --model sonnet --settings "$HOME/.claude/crew-worker-settings.json" --dangerously-skip-permissions --disallowedTools "Write Edit MultiEdit NotebookEdit" --append-system-prompt "$(cat ψ/active/head/scratchpad-contract.md)"')
tmux set-option -p -t "$SCRATCH" @role "🗒️ scratchpad"
```

### Scratchpad Contract (--append-system-prompt ของ scratchpad 🗒️ · sonnet · RO)

> คุณคือ "scratchpad" 🗒️ ของ crew tier — raw claude pane (sonnet), **read-only grounding**. มือของ oracle-ใน-`<co>` ไม่ใช่ oracle แยกร่าง. งานเดียว: **fetch source → ย่อย → คืน digest → เคลียร์**.
>
> **🚫 read-only เด็ดขาด — ห้ามเขียน/แก้ทุกกรณี:** write/edit tools ถูก `--disallowedTools` ปิดแล้ว (เรียกไม่ได้). bash = **READ only** — `cat`/`grep`/`jq`/`psql ... SELECT`/`curl` GET เท่านั้น. ห้าม `>`/`>>`/`tee`/`rm`/`git commit|push`/SQL write. ถ้างานต้องเขียน = **ไม่ใช่งานคุณ** → บอก conductor ให้ส่ง worker-cell.
>
> **หน้าที่:** (1) รับ grounding request จาก crew conductor (`maw hey` / task-event) (2) fetch+trace+ย่อย (db/log/state/file/PR) (3) **post digest กลับ conductor** — `maw hey <conductor>` สรุปสั้น หรือ note บน card (evidence) (4) idle. **digest = ephemeral grounding, ไม่ลง board card** (เหมือน tool-call ไม่ใช่ dispatch).
>
> **invariants:** 1) ไม่เขียน state ใดๆ (แม้ scratchpad.md — Stop hook เขียนให้เอง, คุณไม่แตะ) 2) digest = ข้อเท็จจริงจาก source ที่อ่าน, ระบุ where (file:line / query) 3) ไม่เดา — อ่านจริงก่อนสรุป 4) งานเขียน = คืน conductor
> **guards:** ห้าม git push/commit · rm · แตะไฟล์ · commit secrets · แตะ hash. คุณ = **อ่าน+ย่อย ล้วน**.
> **re-seat หลัง /clear:** อ่าน digest.md + roster + grounding request ค้าง ก่อนต่อ (คุณไม่มี state file ของตัวเองที่ต้องเขียน)

## Worker cell (execution tier · = /crew ตรงๆ) ⚙️

> **worker cell = `/crew` เดิม — reuse ไม่ rebuild.** ชั้นล่างสุด (execution): coordinator (front) + worker×3 (sonnet, on-demand, `/clear`-after). crew tier offload งาน *ที่ต้องเขียน/parallel* ลงมาที่นี่. เป็น **/crew ที่ validated แล้ว (kobo-89/91)** — head ไม่เขียน worker-cell ใหม่, เรียกใช้ /crew ตรงๆ.

**nesting — crew conductor เรียก /crew เมื่อ offload:**
- **เมื่อไหร่:** heavy code / write / parallel (เกณฑ์ offload §Tiers — "มัดมือ/บวม context"). grounding อ่านอย่างเดียว → scratchpad (RO) · งานเขียน → worker cell.
- **ยังไง:** crew conductor spawn worker cell = **invoke `/crew`** (front pane + worker×N) ตาม crew SKILL §0-§9 — company-gate · spawn form · roster resolve-from-pane-id · Stop-hook idle→coordinator · toilet-per-pane · teardown. **ไม่มี spawn form ใหม่ในไฟล์นี้** — /crew เป็นเจ้าของ kernel นั้น (single source, กัน drift).
- **front = coordinator ของ worker cell** (ไม่ใช่ crew conductor) — /crew front รับ dispatch → split → spawn worker → route → merge-gate ภายใน cell. crew conductor = ผู้ *เรียก* worker cell แล้วรับผลกลับ (ไม่ลงไปคุม worker เอง).
- **model:** worker cell = **sonnet** (execution, kobo-300 tier) — /crew workers เป็น sonnet อยู่แล้ว, ไม่ต้อง override.
- **lifecycle:** on-demand (เรียกเมื่อมีงาน) · `/clear`-after (worker ล้าง context เมื่อจบ, ephemeral) · cap ≤3 worker ต่อ cell (crew rule).

**addressing (ข้ามชั้น):** worker cell = window ใหม่ (W3+). crew↔worker-cell คุยผ่าน `maw hey <session>:<window>.<pane>` (resolve สดจาก pane-id, ห้ามจำ index). หลายสายงาน = หลาย worker-cell window.

**review chain:** worker (sonnet) → crew reviewer → head reviewer → lead. worker cell ส่ง PR/ผลขึ้น → crew reviewer กรองก่อน (คนทำ ≠ คนตรวจ). worker cell **ไม่ self-merge** (merge = lead/human).

> **หลัก reuse:** worker cell ไม่ใช่ของใหม่ — คือ /crew ที่ nest ใต้ crew tier. แก้ /crew = worker cell ได้ประโยชน์ทันที (single kernel). head/crew เพิ่มแค่ *เมื่อไหร่เรียก* + *รับผลกลับยังไง* ไม่แตะ spawn machinery.

## lead-toilet-survive (⭐)

crew พิสูจน์ worker+coord toilet แล้ว (kobo-91). head: **lead (.0) toilet/clear/ปิด session → conductor+reviewer[+comm] (raw panes อิสระ) วิ่งต่อ**:
```
lead toilet → conductor dispatch/aggregate ต่อ · reviewer review ต่อ · comm relay ต่อ (autonomous)
   ↓
lead ใหม่ (clock-in/seat): cat ψ/active/head/digest.md + conductor.md + reviewer.md [+comm.md]
   → รู้ว่าเกิดอะไร → hey conductor (resolve จาก pane-id) → ต่อ
```
- truth อยู่ที่ไฟล์ที่แต่ละ pane maintain — lead ไม่ต้องเตรียมอะไรก่อน toilet
- inbound route: lead ใหม่ re-run §6 (resolve `$COND` → `maw route set task-events`)

## toilet-per-pane (context เต็มราย pane) ⭐ kobo-152

> pane ไหน context เต็ม → ล้าง **เฉพาะ pane นั้น** (คนละ process). แต่ **pane สั่ง `/clear` ตัวเองไม่ได้** → **lead/conductor send-keys เข้า pane นั้น**.

**invariant กันงานหาย:** ทุก pane เขียน state ล่าสุดลงไฟล์ตลอด (conductor.md · reviewer.md · comm.md) — `/clear` ปลอดภัยเพราะ context หายแต่ไฟล์อยู่ + `--append-system-prompt` รอด clear.

```bash
CD=$(...pane-id จาก roster...)                 # resolve สดจาก conductor.md
tmux send-keys -t "$CD" C-u                     # ล้าง input line
tmux send-keys -t "$CD" "/clear" Enter          # flush context (pane-id นิ่ง)
tmux send-keys -t "$CD" "/seat" Enter           # soft clock-in: อ่าน state file + role + board
```
- **per-pane = อิสระ:** ทำกับ pane ที่เต็มเท่านั้น. อื่นวิ่งต่อไม่สะดุด.

## Failure modes ⭐ (async/pull — no hard-lock)

**hard-deadlock ไม่มี** — maw = async/pull ไม่ใช่ blocking mutex. **soft-stall เกิดได้** (blackhole pane / blank-boot worker / away-not-seated / context เต็ม). **ยิ่งชั้นลึก ยิ่งมี blackhole เยอะ.** mitigation (bake):
1. **ห้าม block รอ reply — ใช้ card เสมอ** (durable pull), sender เดินต่อ
2. **liveness + idle-with-work badge** (presence observable, kobo-297) — pane ตัน = เห็น
3. **poll ไม่ block** — conductor/reviewer เช็คเป็นระยะ ไม่นั่งรอเงียบ
4. **ห้าม blocking prompt บน autonomous pane** — worker/scratchpad spawn `--dangerously-skip-permissions`
5. **away-aware** — ไม่ dispatch หวัง sync-reply ไป pane away → card ไว้
> **กฎเหล็ก: ทุก wait ต้องมีตาเห็น (card/badge). ไม่มี wait เงียบ.**

## Board = ความจำกลาง
Tony/lead ต้องเห็นหรือตอบ → card บน board. **dispatch = card (durable), hey = chatter** (Board Truth 2/10). status ยิบย่อย → digest/ไฟล์.

## Teardown
ตาม crew §9 (path head/): pane เขียน state → kill reviewer+conductor[+comm] panes → **`maw route rm task-events`** → `rm -f ψ/active/head/*.md` → card ค้าง done/archive.
> ⚠️ **rm route ตอน teardown บังคับ** (kobo-121 stale-route debt).

## Migration (warroom → head) — DONE ✅
> /warroom migrated → /head (cutover kobo-303, hard-removed). /head = canonical strategic cell. ทำแบบ additive-then-cutover: /head พิสูจน์ live+dogfood (kobo-302) ก่อน แล้วค่อยลบ /warroom (คนละ deploy) — running instance รอดเพราะ contract baked ใน `--append-system-prompt` + re-seat อ่าน state files ไม่ใช่ skill.

## Reuse
kernel = /crew เดิม (spawn form, roster resolve-from-pane-id, Stop-hook, toilet-per-pane, teardown, inbound-route). /head เขียนเฉพาะส่วนต่าง: 3-tier nesting + head cell (3 บท + comm opt-in) + review chain. worker cell = /crew ตรงๆ.

---

> *ทีมทั้งโต๊ะเป็น raw pane — ไม่มีใครผูกชีวิตกับใคร. lead หายได้ conductor+reviewer ยังเดิน, conductor หายได้ state ยังอยู่, reviewer หายได้ card ยังรอ review ในบอร์ด. คนทำ ≠ คนตรวจ เสมอ. งานไหลลง · ผลไหลขึ้น.*
> — /head (top tier: lead · conductor 🎼 · reviewer 🔎 [+comm 📡]), 3-tier lock · 2026-07-14
