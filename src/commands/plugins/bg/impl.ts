/**
 * `maw bg <name> "<cmd>"` — spawn a detached tmux session running `<cmd>` (#1304).
 *
 * Thin wrapper over `tmux.newSession()` with `{ command }`. Default
 * attach=false: the operator typed `maw bg` because they want the thing to
 * run and stay running while they continue with their terminal. Pass
 * `--attach` for the rare case where you want both spawn AND attach.
 *
 * Fails loudly if the session name already exists — silent reuse would
 * hide stale processes / leak state from previous runs.
 *
 * Pairs with `maw shell <name>` (#1304 also) — same primitive, opposite
 * default. `shell` is for humans, `bg` is for services.
 *
 * Out of scope (v1, per issue body):
 *   - process management (kill / restart / list-running)
 *   - log capture beyond tmux's inherited stdio
 *   - --shell convenience flag (v2 polish)
 *
 * Testing seams (#1309): `opts.tmux` + `opts.attachFn` let tests inject
 * fakes directly rather than spying on the live `tmux` singleton. See
 * shell/impl.ts for the same pattern + rationale.
 */
import { tmux as defaultTmux, type Tmux } from "../../../core/transport/tmux-class";
import { cmdTmuxAttach as defaultAttach } from "../tmux/impl";

export interface BgOpts {
  /** Attach after spawning. Default: false. Pass `--attach` to attach. */
  attach?: boolean;
  /** Tmux instance override (testing seam — #1309). Default: real singleton. */
  tmux?: Pick<Tmux, "hasSession" | "newSession">;
  /** Attach helper override (testing seam — #1309). Default: cmdTmuxAttach. */
  attachFn?: (target: string) => void;
}

export async function cmdBg(name: string, cmd: string, opts: BgOpts = {}): Promise<void> {
  if (!name) throw new Error("session name required (usage: maw bg <name> \"<cmd>\")");
  if (!cmd) throw new Error("command required (usage: maw bg <name> \"<cmd>\")");

  const t = opts.tmux ?? defaultTmux;
  const attachFn = opts.attachFn ?? defaultAttach;

  if (await t.hasSession(name)) {
    throw new Error(
      `session '${name}' already exists — attach with 'maw a ${name}' or kill with 'maw kill ${name}'`,
    );
  }

  await t.newSession(name, { cwd: process.cwd(), command: cmd });

  const attach = opts.attach === true; // default false
  if (attach) {
    attachFn(name);
  } else {
    console.log(`✓ session '${name}' spawned (detached) — running: ${cmd}`);
    console.log(`  attach: maw a ${name}    kill: maw kill ${name}`);
  }
}
