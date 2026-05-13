/**
 * `maw shell <name>` — spawn an interactive tmux shell session (#1304).
 *
 * Thin wrapper over `tmux.newSession()`. Default attach=true: the operator
 * typed `maw shell foo` because they want to BE in that shell. Pass
 * `--no-attach` to detach (create-only, attach later via `maw a foo`).
 *
 * Fails loudly if the session name already exists — silent reuse of an
 * existing session would be a foot-gun (you might end up in a stale shell
 * with the wrong cwd).
 *
 * Pairs with `maw bg <name> "<cmd>"` (#1304 also) — same primitive, opposite
 * default. `shell` is for humans, `bg` is for services.
 */
import { tmux } from "../../../core/transport/tmux-class";
import { cmdTmuxAttach } from "../tmux/impl";

export interface ShellOpts {
  /** Attach after creating. Default: true. Pass `--no-attach` for detached. */
  attach?: boolean;
}

export async function cmdShell(name: string, opts: ShellOpts = {}): Promise<void> {
  if (!name) throw new Error("session name required (usage: maw shell <name>)");

  // Refuse to clobber an existing session. tmux's own `new-session -s NAME`
  // errors with "duplicate session" but the message is opaque; we surface a
  // friendlier hint pointing at `maw a` / `maw kill`.
  if (await tmux.hasSession(name)) {
    throw new Error(
      `session '${name}' already exists — attach with 'maw a ${name}' or kill with 'maw kill ${name}'`,
    );
  }

  await tmux.newSession(name, { cwd: process.cwd() });

  const attach = opts.attach !== false; // default true
  if (attach) {
    cmdTmuxAttach(name);
  } else {
    console.log(`✓ session '${name}' created (detached) — attach with: maw a ${name}`);
  }
}
