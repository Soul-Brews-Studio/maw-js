# MAW JS — operations runbook

**Canonical current-operations entrypoint** for the TTT3P live install (fork
checkout + symlinked global install). Any other MAW operations document is
specialized, generic/upstream, or historical and defers to this file.

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
  - **`src/cli.ts` is the ~64-line MODULAR ENTRY** (it `import`s `./cli/*` and
    `./core/*`); the bin runs it, so core edits go live only because bun loads
    the modular source. **Never commit a `bun build` bundle as `src/cli.ts`** —
    a minified `// @bun` bundle inlines and FREEZES core code, so core changes
    (fleet-ensure, wake-cmd, …) silently stop going live even though plugins
    (symlinked under `~/.maw/plugins`) still do. `dist/maw` is the build output;
    `src/cli.ts` is the source entry. A guard test
    (`test/cli-entry-modular.test.ts`) fails if a bundle is committed here.
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

- Transport commands: `maw hey <target> "…"`, inspect with `maw peek` /
  `maw capture` / `maw messages`; lifecycle: `wake`, `sleep`, `kill`, `done`,
  `cleanup`. Their behavioral contract (what delivery proves, targeting,
  dry-run discipline) is owned by `rules/maw-communication.md`.

### Fleet-record lifecycle & drift (validated 2026-08-22)

- Records live at `~/.maw/fleet/<num>-<group>.json`. The **write dir** is the runtime
  home `~/.maw/fleet` (`fleetDirForWrite`); **reads** merge that with `~/.config/maw/fleet`
  **first-writer-wins by filename**, excluding `*.disabled` (`fleet-load-core.ts`).
- A record is a **launch snapshot, not live truth**: `windows[]` is written once at
  registration (`maw new` / `auto_registered`) and is reconciled by **no** ordinary
  lifecycle op. Consequences:
  - `maw sleep <oracle> [window]` stops only the **recorded** window(s); un-recorded
    live windows keep running.
  - `maw wake <oracle>` rebuilds windows from the recovery snapshot **only when the
    session is fully gone**; with a surviving pane it reconciles nothing. (`wake` has
    no window positional — a 2nd arg becomes a task.)
  - a runtime-capture/backfill path rewrites a record's `runtime` block and may prune
    *some* windows without fully reconciling — a third drift source.
- **Detect drift (read-only, no repair)** — record vs live windows:
  ```sh
  maw locate <oracle>                                   # session + fleet path (no side effects)
  tmux list-windows -t <session> -F '#{window_name}'    # live windows
  cat ~/.maw/fleet/<session>.json                       # recorded windows[]
  ```
  Classifier + regression tests: `src/core/fleet/fleet-drift.ts` and
  `test/fleet-record-hygiene.test.ts`. The three drift classes currently on this machine
  (no-record / record<live / record>live) are recorded in the MAW-HYG measured evidence
  and receipt `MAW-HYG-20260822-01` — not restated here.
- **Repairing** a real seat's record (re-register / prune) is **gated work** (TINE
  deploy word), never done in-band from a diagnostic.

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

- Normative MAW communication/transport policy is owned by
  `~/.claude-config-repo/rules/maw-communication.md` (global contract); this
  runbook does not restate it.
- **No raw-tmux exception (TINE decision 2026-08-17):** the proposed
  fleet-restore.sh bootstrap exception was NOT ratified. Sessions opened
  correctly resume on their own (Claude holds seat 1; CROO opens leads, leads
  open their own workers), so `orchestrator-vnext/tools/fleet-restore.sh` only
  starts the daemon and runs `maw wake` — it never sends raw tmux input.
  Startup prompts are answered by the human in the pane.
- Heuristic writes are fail-safe by policy: preflight `--fix` never writes to
  unclassified panes (commit c515c49b); sendText prompt-marker fallback must not
  match mid-line status text (commit 3707438a).

## 8. Escalation

- Because install = live source, any edit here is R1-adjacent: stage → test
  (`bun test <target>` + `bun run build`) → independent review → commit.
- Known open items: ghost-last pane classification (PARK, needs live evidence),
  FleetWindow intent/engine field for safe auto-revive (design debt).

## 9. Federation peers (serve bind)

To make a node reachable as a MAW peer, its `maw serve` must bind a routable
address, not just loopback. The bind is chosen by `core/bind-host.ts`: it flips
to `0.0.0.0` once peers exist (`peers.json` / `config.peers` / `config.namedPeers`)
or `MAW_HOST=0.0.0.0`, else `127.0.0.1`.

- **Do NOT rely on `MAW_HOST=0.0.0.0`** — on at least one proven node (win /
  WSL2, MAW-PEER-WIN-01) maw serve hangs after `[scout] listening`, before the
  HTTP bind, when the hostname is `0.0.0.0` (raw `Bun.serve` on `0.0.0.0` binds
  fine there, so it is maw's `0.0.0.0` heuristic path, not Bun/OS).
- **Instead set an explicit bind IP:** `maw config set bind <this-node-IP>`
  (e.g. the Tailscale/WG address). Binds cleanly and is narrower than `0.0.0.0`.
- **Consequence of adding a peer:** the heuristic would pick `0.0.0.0` on the
  daemon's NEXT restart → the hang above. Set `config.bind` to an explicit IP on
  BOTH ends BEFORE the next restart, or the daemon will not come up.
- Peer add + probe: `maw peers add <alias> http://<ip>:3456 --ssh <ssh-alias>`
  then `maw peers probe <alias>` (expect `✓ reached <alias>`). For `maw hey`
  federation, also add `{ "name":"<alias>", "url":"http://<ip>:3456" }` to
  `config.namedPeers`. Per-node install details live in the owning operator
  receipt (e.g. `maw-maint-oracle ψ/maw-hygiene/peer-win-01/`).
