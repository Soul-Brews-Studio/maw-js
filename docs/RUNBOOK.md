# MAW JS — operations runbook

Format: `rules/oracle-runbook-standard.md` (claude-config-repo). Commands below
were executed and verified during the 2026-08-16/17 recovery arc.

## 1. Identity & layout

- Live checkout: `~/tt3p/reference-repos/Soul-Brews-Studio/maw-js` (branch `alpha`)
- Publish surface: `git@github.com:TTT3P/maw-js.git` (remote `fork`; upstream
  Soul-Brews-Studio is 403 for the TTT3P account)
- **Install is a symlink to this checkout**:
  `~/.bun/install/global/node_modules/maw-js -> <this repo>`, CLI at
  `~/.bun/bin/maw` runs `src/cli.ts` as TypeScript source directly —
  **editing the working tree is live-effective on the next `maw` invocation**;
  "staging" a change here IS deploying it.
- Daemon: `maw serve` on port **3456** (state under `~/.maw/`, fleet registry
  `~/.maw/fleet/*.json`, message ledger `~/.maw/maw-log.jsonl`).

## 2. Health

```sh
maw health          # expect: tmux running, maw server online (:3456, probe ok)
maw serve status    # expect: running (PID …)
maw preflight       # expect: N pass / 0 fail; "unclassified panes" is informational
```
Note: `pane_current_command=bash` does NOT mean a dead agent (Codex runs under
bash); preflight lists such panes as unclassified and `--fix` never writes to them.

## 3. Restart

```sh
maw serve stop
nohup maw serve --quiet >/dev/null 2>&1 &
sleep 3 && maw serve status      # expect: running (PID …)
```
`maw serve` runs in the foreground (it IS the live Bun server), so the daemon
must be started detached; the `nohup … &` form above is the one fleet-restore
used in the 2026-08-16 recovery, and the live daemon currently runs as
`maw serve --quiet`. **NEVER use `maw restart` for the daemon** — it restarts
the entire fleet (sleep + wake all). Full fleet recovery after a machine
reboot: `bash ~/tt3p/agent-hub/orchestrator-vnext/tools/fleet-restore.sh`
(owner: orchestrator-vnext — see section 7 for its policy boundary).

## 4. Data operations

- Transport: `maw hey <target> "…"` (delivered/queued = transport only; only a
  reply proves understanding). Inspect with `maw peek` / `maw capture` /
  `maw messages` — see `rules/maw-communication.md` for the usage contract.
- Lifecycle mutations (`wake`, `sleep`, `kill`, `done`, `cleanup`): resolve the
  exact target first; use documented dry-run when available.

## 5. Backup & restore

- The tool itself is stateless code: git is the backup (push `alpha` to the fork).
- Runtime state worth preserving: `~/.maw/` (fleet registry, message ledger,
  serve logs). Backup (verified 2026-08-17 by checksum round-trip on
  `maw-log.jsonl`):
  ```sh
  tar -czf ~/maw-state-backup.tar.gz -C "$HOME" .maw
  tar -tzf ~/maw-state-backup.tar.gz | head   # expect .maw/… entries
  ```
- Restore: stop the daemon, extract, start detached:
  ```sh
  maw serve stop
  tar -xzf ~/maw-state-backup.tar.gz -C "$HOME"
  nohup maw serve --quiet >/dev/null 2>&1 &
  sleep 3 && maw serve status   # expect: running (PID …)
  ```

## 6. Fresh install

```sh
git clone git@github.com:TTT3P/maw-js.git ~/tt3p/reference-repos/Soul-Brews-Studio/maw-js
cd ~/tt3p/reference-repos/Soul-Brews-Studio/maw-js && git checkout alpha && bun install
# recreate BOTH live symlinks (package + CLI — verified against the live install):
ln -s ~/tt3p/reference-repos/Soul-Brews-Studio/maw-js \
      ~/.bun/install/global/node_modules/maw-js
ln -s ../install/global/node_modules/maw-js/src/cli.ts ~/.bun/bin/maw
command -v maw                    # expect: ~/.bun/bin/maw
nohup maw serve --quiet >/dev/null 2>&1 &
sleep 3 && maw serve status && maw health   # expect: running / server online
```

## 7. Policies & holds

- MAW is the ONLY transport/lifecycle surface for agents — no raw
  `tmux send-keys`, custom inboxes, or substitute dispatchers (global contract).
- **Known boundary case:** `orchestrator-vnext/tools/fleet-restore.sh` (reboot
  bootstrap, owner orchestrator-vnext) drives raw tmux input to answer Claude
  trust/resume prompts during machine-reboot recovery, which predates and sits
  in tension with the rule above. Ratification of this exception is pending
  with TINE; until then treat fleet-restore as reboot-bootstrap only, never as
  an agent-messaging path.
- Heuristic writes are fail-safe by policy: preflight `--fix` never writes to
  unclassified panes (commit c515c49b); sendText prompt-marker fallback must not
  match mid-line status text (commit 3707438a).

## 8. Escalation

- Because install = live source, any edit here is R1-adjacent: stage → test
  (`bun test <target>` + `bun run build`) → independent review → commit.
- Known open items: ghost-last pane classification (PARK, needs live evidence),
  FleetWindow intent/engine field for safe auto-revive (design debt).
