import type { MawWS } from "../types";
import { readTasks } from "../api/kanban";

/** Broadcast kanban tasks to all clients if changed */
export async function broadcastKanban(
  clients: Set<MawWS>,
  lastJson: { value: string },
): Promise<void> {
  if (clients.size === 0) return;
  const tasks = await readTasks();
  const json = JSON.stringify(tasks);
  if (json === lastJson.value) return;
  lastJson.value = json;
  const msg = JSON.stringify({ type: "kanban_update", tasks });
  for (const ws of clients) ws.send(msg);
}
