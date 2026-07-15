---
name: worker
description: Self-declare as a worker role — set up ψ/active/worker/ state, load worker contract, ping coordinator ready. Leaf execution pane (no sub-panes, no spawn). Use when an oracle says "/worker", "take worker role", or wants to self-designate as a crew worker without being spawned by a coordinator. Re-seat after /clear reads ψ/active/worker/worker.md and resumes from prior state.
---

# /worker — self-invoked worker (leaf execution, no spawn)

> **Worker = leaf.** Pure execution. No sub-panes ever. Gets work via card or `maw hey` from coordinator/lead. Pings coordinator on every meaningful state change. Truth stays in `ψ/active/worker/worker.md`, not in context.

```
coordinator / lead (another pane or remote oracle)
      │  dispatch (card assign / maw hey)
      ▼
   ⚙️ worker   ← this pane, self-invoked
      │  reports results + pings on state change
      └─ NO children (leaf — never spawn sub-panes)
```

**Kernel = /crew worker contract.** `/worker` = same duties + invariants as a crew worker; difference is self-invocation: an oracle declares itself worker directly, not spawned by a coordinator. State-dir = `ψ/active/worker/` (default when no CREW_STATE_DIR set).

## Re-seat vs First-init

**ลำดับแรกที่ต้องทำ:**

```bash
STATE_DIR="${CREW_STATE_DIR:-ψ/active/worker}"
ROLE="${CREW_ROLE:-worker}"
ADDR=$(tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}')
```

- **`$STATE_DIR/$ROLE.md` มีอยู่** → **RE-SEAT** (no full re-init):
  - อ่านไฟล์ → derive coordinator addr → ping "⚙️ worker re-seated @ `<addr>` — ทำต่อจาก: `<task สุดท้าย>`"
  - ทำงานต่อจากที่หยุด (งานค้างอ่านจาก card + state)
- **ไม่มีไฟล์** → **FIRST-INIT**:
  - สร้าง dir + เขียน state ตั้งต้น → ping coordinator ready

## Steps (first-init)

1. **company-gate** — oracle ต้องอยู่ใน company (`~/.maw/companies/*.json`); งานนอก company ใช้ harness sub-agent แทน
2. **State dir:**
   ```bash
   STATE_DIR="${CREW_STATE_DIR:-ψ/active/worker}"
   ROLE="${CREW_ROLE:-worker}"
   mkdir -p "$STATE_DIR"
   ADDR=$(tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}')
   ```
3. **Tag pane** (durable — survives /clear, enables seat-resume.sh liveness):
   ```bash
   tmux set-option -p -t "$TMUX_PANE" @role "⚙️ worker"
   ```
4. **Write state** (`$STATE_DIR/$ROLE.md`) — see §State file format
5. **Ping coordinator ready** — coordinator addr (priority order):
   - `$CREW_COORD_PANE` → `$CREW_COORD` → card body → unknown (ask human)
   ```
   maw hey <coordinator-addr> "⚙️ worker ready @ <addr> — standby รองาน. state: $STATE_DIR/$ROLE.md"
   ```
6. **Standby** — idle รองาน (รับผ่าน `maw hey` หรือ card assign)

## State file format (`$STATE_DIR/$ROLE.md`)

```md
## worker @ <addr> · company:<co> · <time>
- task: <งานที่รับอยู่ หรือ standby>
- card: <card-id หรือ ->
- coordinator: <pane-addr หรือ maw-addr ของ coordinator>
- status: standby | in-progress | blocked | done
- verified: <what was verified, or ->
- next: <next step>
```

> **Overwrite ทุกครั้งที่มีเหตุ** (state ล่าสุดเสมอ). Ping coordinator **1 บรรทัด + ชี้ไฟล์** ไม่เล่าเนื้อยาว.

## Worker Contract (invariants — ทำทุกข้อ)

1. **signal+state**: state ล่าสุดเขียนลง `$STATE_DIR/$ROLE.md` (overwrite) — เหตุสำคัญ ping coordinator **1 บรรทัด + ชี้ไฟล์**
2. **verified**: ทุก claim ต้องมีบรรทัด `verified: <how, ราย path>` — ไม่ได้ verify = `claim (unverified)` ห้าม ✅ เปล่า
3. **รอ human**: ลง card (needs_input) + what/why/options → **หยุด (default deny)** → ping coordinator 1 บรรทัด
4. **งานนอกสาย**: ลง card ก่อน (tag ที่มา) + แจ้ง coordinator แล้วค่อยทำ
5. **ก่อนลงมือ**: อ่าน premise จาก card/state จริง (ground-before-execute) อย่าทำจากความจำ
6. **ได้ยิน decision**: เขียนลง card/ไฟล์ทันที (loopback) — ไม่เขียน = หาย
7. **🚫 ห้าม `run_in_background`** — ทุกอย่างรันใน pane นี้ให้มองเห็น

## Card-lifecycle (worker drives state, never self-closes)

```
รับงาน → move card in-progress → ทำงาน
  → เสร็จ  → move card review (not done — done=PR merge or reviewer)
  → ติด dep → move card blocked --kind dependency
  → รอ Tony → move card need-answer --reason "<คำถาม>"
```

## Accept criteria (เมื่อได้รับงาน)

- card id ชัด + premise อ่านจาก card body จริง (ไม่จากความจำ)
- scope ชัด: รู้ว่า OUT-of-scope คืออะไร
- AC ชัด: Given/When/Then
- ถ้าไม่ชัด → comment @coordinator บน card + หยุดรอ

## Unhappy paths

- ไม่รู้ coordinator addr → เขียน state (coordinator: unknown) → รอ human provide addr
- state file เสียหาย / parse ผิด → first-init mode (safe default)
- งานชนกัน (2 cards พร้อมกัน) → accept 1 ใบ → surface อีกใบให้ coordinator ตัดสิน

## Comms

`maw hey <addr>` เท่านั้น. Tag `[<host>:<oracle>]` นำหน้า — อ่านข้าม. **Submit ทุก turn ให้ input box ว่าง.**

## Re-seat after /clear ⭐

seat-resume.sh hook fires on `startup|resume|clear` → อ่าน `$STATE_DIR/$ROLE.md` (via CREW_STATE_DIR + CREW_ROLE env, หรือ @role "⚙️ worker" fallback) → inject เป็น context → worker wake up already oriented.

> ถ้าสั่งเปิด pane โดยไม่มี CREW_STATE_DIR ตั้ง → hook ยัง search `ψ/active/worker/` → พบ `worker.md` → seated. Solo-safe: ไม่มีไฟล์ → hook silent.

---

> *Worker เป็น leaf — งานมา ทำ ส่ง ไม่แตก. truth อยู่ในไฟล์+card. ตาย-clear-restart ได้โดยงานไม่หาย.*
> — /worker (leaf execution tier · self-invoked · no spawn), kobo-316
