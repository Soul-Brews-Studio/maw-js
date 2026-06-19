# Project Maintenance Vault

This `psi/` directory is for maintaining the `maw-js` repository.

`maw-js` is the fleet/runtime control layer. This vault records maintainer
handoffs, decisions, readouts, and project-specific learnings. It is not MAW
runtime state, not tmux session state, not plugin output, and not a task queue.

## Rules

- GitHub Issues and pull requests are the durable queue.
- This vault is memory and handoff, not a task claim system.
- Do not store secrets, tokens, API keys, generated databases, tmux captures,
  `.maw-engine` markers, `MAW_HOME` state, plugin build artifacts, or runtime
  logs.
- Keep runtime, scheduler, federation, and plugin changes in source directories
  with normal tests and review.
- Use this vault only for project maintenance context.

## Structure

```text
psi/
  active/     current maintainer context and checkpoints
  handoff/    session handoffs for future maintainers
  decisions/  project decisions, reversals, and rationale
  learn/      repo readouts, proofs, and investigations
  memory/     durable project learnings and retrospectives
```
