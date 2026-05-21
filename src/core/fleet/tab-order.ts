import { join } from "path";
import { mawStatePath } from "../xdg";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { tmux } from "../transport/tmux";

const TAB_ORDER_DIR = mawStatePath("tab-order");

// Ensure dir exists
mkdirSync(TAB_ORDER_DIR, { recursive: true });

export interface TabOrderEntry {
  index: number;
  name: string;
}

/**
 * Save the current window order for a session.
 * Called before sleep so we can restore on wake.
 */
export async function saveTabOrder(session: string): Promise<void> {
  try {
    const windows = await tmux.listWindows(session);
    const order: TabOrderEntry[] = windows
      .sort((a, b) => a.index - b.index)
      .map(w => ({ index: w.index, name: w.name }));
    const filePath = join(TAB_ORDER_DIR, `${session}.json`);
    writeFileSync(filePath, JSON.stringify(order, null, 2) + "\n");
  } catch {
    // Session might not exist
  }
}

/**
 * Restore window order from saved tab-order file.
 * Uses swap-window to reorder windows to match saved positions.
 * Returns number of windows moved, or 0 if no saved order.
 */
export async function restoreTabOrder(session: string): Promise<number> {
  const filePath = join(TAB_ORDER_DIR, `${session}.json`);
  if (!existsSync(filePath)) return 0;

  let savedOrder: TabOrderEntry[];
  try {
    savedOrder = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return 0;
  }

  if (!savedOrder.length) return 0;

  let moved = 0;

  // Selection-sort approach: for each position in saved order,
  // find the window that belongs there and swap it into place.
  for (const saved of savedOrder) {
    let currentWindows: { index: number; name: string }[];
    try {
      currentWindows = await tmux.listWindows(session);
    } catch {
      break;
    }

    // Find where the desired window currently is
    const actual = currentWindows.find(w => w.name === saved.name);
    if (!actual) continue; // window no longer exists

    // Find what's currently at the target index
    const atTarget = currentWindows.find(w => w.index === saved.index);

    if (actual.index === saved.index) continue; // already in place

    if (atTarget) {
      // Swap the two windows
      try {
        await tmux.run("swap-window", "-s", `${session}:${actual.index}`, "-t", `${session}:${saved.index}`);
        moved++;
      } catch {
        // swap failed — try move-window as fallback
        try {
          await tmux.run("move-window", "-s", `${session}:${actual.index}`, "-t", `${session}:${saved.index}`);
          moved++;
        } catch { /* expected: tmux move-window may conflict */ }
      }
    } else {
      // Target index is empty — just move
      try {
        await tmux.run("move-window", "-s", `${session}:${actual.index}`, "-t", `${session}:${saved.index}`);
        moved++;
      } catch { /* expected: tmux move-window may conflict */ }
    }
  }

  // Clean up saved order file after successful restore
  try { unlinkSync(filePath); } catch { /* expected: file may already be removed */ }

  return moved;
}
