import {
  nextAgentColor, colorAnsi, stylePaneBorder, enableBorderStatus,
  applyTiledLayout, getWindowTarget,
} from "../tmux/layout-manager";
import { hostExec } from "../../../sdk";
import { withPaneLock } from "../../../core/transport/tmux-pane-lock";

export async function cmdTile(count: number): Promise<void> {
  if (count < 0 || !Number.isFinite(count)) {
    throw new Error("tile: count must be a non-negative integer");
  }
  if (count > 10) {
    throw new Error("tile: max 10 panes (got " + count + ")");
  }

  const window = await getWindowTarget();

  if (count === 0) {
    await applyTiledLayout(window);
    console.log("\x1b[32m✓\x1b[0m tiled");
    return;
  }

  const anchor = process.env.TMUX_PANE ?? "";

  for (let i = 0; i < count; i++) {
    const name = `pane-${i + 1}`;
    const color = nextAgentColor(i);
    const targetFlag = anchor ? `-t '${anchor}' ` : "";

    let paneId = "";
    await withPaneLock(async () => {
      paneId = (await hostExec(
        `tmux split-window ${targetFlag}-h -P -F '#{pane_id}' 'exec zsh'`,
      )).trim();
      await new Promise(r => setTimeout(r, 200));
    });

    await stylePaneBorder(paneId, name, color);
    await applyTiledLayout(window);
    await enableBorderStatus(window);

    console.log(`  \x1b[${colorAnsi(color)}m●\x1b[0m ${name} → ${paneId}`);
  }

  console.log(`\x1b[32m✓\x1b[0m ${count} panes tiled`);
}
