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
 *
 * Testing seams (#1309): `opts.tmux` + `opts.attachFn` let tests inject
 * fakes directly rather than spying on the live `tmux` singleton. Under
 * `bun run test` (no `--isolate`), sibling tests can replace properties on
 * the tmux singleton, leaving `spyOn(...).mockRestore` unable to clean up.
 * DI sidesteps the module-pollution failure mode entirely.
 */
import { tmux as defaultTmux, type Tmux } from "../../../core/transport/tmux-class";
import { cmdTmuxAttach as defaultAttach } from "../tmux/impl";

export interface ShellOpts {
  /** Attach after creating. Default: true. Pass `--no-attach` for detached. */
  attach?: boolean;
  /** Tmux instance override (testing seam — #1309). Default: real singleton. */
  tmux?: Pick<Tmux, "hasSession" | "newSession">;
  /** Attach helper override (testing seam — #1309). Default: cmdTmuxAttach. */
  attachFn?: (target: string) => void;
}

export async function cmdShell(name: string, opts: ShellOpts = {}): Promise<void> {
  if (!name) throw new Error("session name required (usage: maw shell <name>)");

  const t = opts.tmux ?? defaultTmux;
  const attachFn = opts.attachFn ?? defaultAttach;

  // Refuse to clobber an existing session. tmux's own `new-session -s NAME`
  // errors with "duplicate session" but the message is opaque; we surface a
  // friendlier hint pointing at `maw a` / `maw kill`.
  if (await t.hasSession(name)) {
    throw new Error(
      `session '${name}' already exists — attach with 'maw a ${name}' or kill with 'maw kill ${name}'`,
    );
  }

  await t.newSession(name, { cwd: process.cwd() });

  const attach = opts.attach !== false; // default true
  if (attach) {
    attachFn(name);
  } else {
    console.log(`✓ session '${name}' created (detached) — attach with: maw a ${name}`);
  }
}
