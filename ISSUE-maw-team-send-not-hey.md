# Issue: Use `maw team send` for team agents, not `maw hey`

Date: 2026-05-14 22:06 +07
Trace target: `/opt/sila/Code/github.com/Soul-Brews-Studio/maw-js`

## Problem

During a live Somwind team simulation, I used `maw hey` to talk to individual
panes that belonged to a `maw team`.

That is the wrong operator surface for team members.

`maw hey` is for oracle/session messaging. For agents that are members of a
`maw team`, the correct channel is:

```bash
maw team send <team> <agent> <message>
```

Using `maw hey` against pane targets can bypass the team inbox, make ACK/status
tracking ambiguous, and encourage operators to think in panes instead of team
agents.

## Observed Team

Team:

```text
gale-codex-215257
```

Members:

```text
scout
implementer
```

Correct commands sent:

```bash
maw team send gale-codex-215257 scout "SCOUT: ACK กลับมา สรุปสิ่งที่กำลังทำ และบอกไฟล์หรือ WT ที่รับผิดชอบ"
maw team send gale-codex-215257 implementer "IMPLEMENTER: ACK กลับมา สรุปสิ่งที่กำลังทำ และบอกไฟล์หรือ WT ที่รับผิดชอบ"
```

Verification commands:

```bash
maw team status gale-codex-215257
ls -la ~/.claude/teams/gale-codex-215257/inboxes
maw pane list
```

Verification observed:

- `scout` engine `codex`, status `running`, pane `%20`.
- `implementer` engine `codex`, status `running`, pane `%21`.
- Team inbox files existed: `scout.json`, `implementer.json`.
- `maw pane list` showed lead, implementer, and scout panes.

## Fix / Product Direction

1. Document that `maw team send` is the canonical way to message team members.
2. Consider adding a guard or warning when `maw hey` targets a pane annotated as
   `team: <agent> @ <team>`.
3. Keep `maw hey` for oracle/session messaging, including team fan-out where
   explicitly supported by `team:<name>`, but do not present it as the normal
   command for live `maw team` member coordination.

## Permanent Code-Team Rule

For code teams, create worktrees first:

```bash
maw workon Somwind-oracle scout
maw workon Somwind-oracle implementer
maw workon Somwind-oracle verifier
```

Then send prompts with an absolute worktree path:

```text
REPO=/absolute/path/to/Somwind-oracle-<role-worktree>
You own only REPO. Do not edit outside that worktree.
Report changed files and verification.
```

