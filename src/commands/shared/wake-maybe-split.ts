import { hostExec } from "../../sdk";

/** @internal — exported for tests only. */
export async function probeTmuxServer(): Promise<boolean> {
  try {
    await hostExec("tmux display-message -p '#S'");
    return true;
  } catch {
    return false;
  }
}

export async function maybeSplit(target: string, opts: { split?: boolean }): Promise<void> {
  if (!opts.split) return;
  if (process.env.TMUX) {
    try {
      const { cmdSplit } = await import("../plugins/split/impl");
      await cmdSplit(target);
    } catch (e: any) {
      console.log(`  \x1b[33m⚠\x1b[0m split failed: ${e.message || e}`);
    }
    return;
  }
  const serverUp = await probeTmuxServer();
  const session = target.split(":")[0] || target;
  if (serverUp) {
    console.log(`  \x1b[33m⚠\x1b[0m --split skipped — shell is not attached to a tmux pane.`);
    console.log(`      \x1b[90mstate created:    ${target}\x1b[0m`);
    console.log(`      \x1b[90mto view:          tmux attach -t ${session}\x1b[0m`);
    console.log(`      \x1b[90mto silence:       drop --split when running headless\x1b[0m`);
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m --split skipped — tmux server not running.`);
    console.log(`      \x1b[90mstate created:    ${target}\x1b[0m`);
    console.log(`      \x1b[90mto start tmux:    tmux new -s work\x1b[0m`);
    console.log(`      \x1b[90mto silence:       drop --split when running headless\x1b[0m`);
  }
}
