import { hostExec } from "../../sdk";

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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
      const anchor = process.env.TMUX_PANE;
      const targetFlag = anchor ? `-t ${shellArg(anchor)} ` : "";
      const innerCmd = `TMUX= tmux attach-session -t ${shellArg(target)}`;
      await hostExec(`tmux split-window ${targetFlag}-h -l 50% ${shellArg(innerCmd)}`);
      console.log(`  \x1b[32m✓\x1b[0m split beside — ${target} (50%)`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.log(`  \x1b[33m⚠\x1b[0m split failed: ${message}`);
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

export async function maybeOpenWindow(target: string, opts: { bring?: boolean }): Promise<void> {
  if (!opts.bring) return;
  const session = target.split(":")[0] || target;
  if (process.env.TMUX) {
    try {
      const targetWindow = target.split(":").slice(1).join(":") || session;
      const windowName = `bring-${targetWindow}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "bring";
      const innerCmd = `TMUX= tmux attach-session -t ${shellArg(target)}`;
      await hostExec(`tmux new-window -d -n ${shellArg(windowName)} ${shellArg(innerCmd)}`);
      console.log(`  \x1b[32m✓\x1b[0m opened background tab — ${target}`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.log(`  \x1b[33m⚠\x1b[0m bring failed: ${message}`);
    }
    return;
  }
  const serverUp = await probeTmuxServer();
  if (serverUp) {
    console.log(`  \x1b[33m⚠\x1b[0m bring skipped — shell is not attached to a tmux pane.`);
    console.log(`      \x1b[90mstate created:    ${target}\x1b[0m`);
    console.log(`      \x1b[90mto view:          tmux attach -t ${session}\x1b[0m`);
    console.log(`      \x1b[90mto silence:       use maw wake instead of maw bring when running headless\x1b[0m`);
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m bring skipped — tmux server not running.`);
    console.log(`      \x1b[90mstate created:    ${target}\x1b[0m`);
    console.log(`      \x1b[90mto start tmux:    tmux new -s work\x1b[0m`);
    console.log(`      \x1b[90mto silence:       use maw wake instead of maw bring when running headless\x1b[0m`);
  }
}
