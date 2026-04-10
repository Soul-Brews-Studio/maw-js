import { Hono } from "hono";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";

// --- Types ---

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  oracle: string;
  priority: "low" | "medium" | "high" | "critical";
  status: "inbox" | "assigned" | "in_progress" | "review" | "done";
  projectName?: string;
  worktreeBranch?: string;
  worktreePath?: string;
  dispatchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Storage ---

const MAW_DIR = join(homedir(), ".maw");
const TASKS_FILE = join(MAW_DIR, "kanban-tasks.json");
const TASKS_TMP = join(MAW_DIR, "kanban-tasks.json.tmp");

function ensureDir() {
  if (!existsSync(MAW_DIR)) mkdirSync(MAW_DIR, { recursive: true });
}

export async function readTasks(): Promise<KanbanTask[]> {
  try {
    const raw = await Bun.file(TASKS_FILE).text();
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeTasks(tasks: KanbanTask[]): Promise<void> {
  ensureDir();
  // Atomic: write to tmp, then rename
  await Bun.write(TASKS_TMP, JSON.stringify(tasks, null, 2));
  execSync(`mv "${TASKS_TMP}" "${TASKS_FILE}"`);
}

// --- Broadcast ---

let broadcastFn: (() => Promise<void>) | null = null;

export function setKanbanBroadcast(fn: () => Promise<void>) {
  broadcastFn = fn;
}

async function broadcastAfterWrite() {
  if (broadcastFn) await broadcastFn().catch(() => {});
}

// --- Auto-move Oracle tasks ---

export async function autoMoveOracleTasks(
  oracle: string,
  targetStatus: KanbanTask["status"],
): Promise<void> {
  const tasks = await readTasks();
  const now = new Date().toISOString();
  let changed = false;
  const updated = tasks.map((t) => {
    if (
      t.oracle === oracle &&
      (t.status === "assigned" || t.status === "in_progress")
    ) {
      changed = true;
      return { ...t, status: targetStatus, updatedAt: now };
    }
    return t;
  });
  if (changed) {
    await writeTasks(updated);
    await broadcastAfterWrite();
  }
}

// --- ID generation ---

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// --- API ---

export const kanbanApi = new Hono();

// GET /api/kanban/tasks
kanbanApi.get("/kanban/tasks", async (c) => {
  const tasks = await readTasks();
  return c.json({ tasks });
});

// POST /api/kanban/tasks
kanbanApi.post("/kanban/tasks", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return c.json({ error: "title is required" }, 400);
  }

  const now = new Date().toISOString();
  const task: KanbanTask = {
    id: generateId(),
    title,
    description: typeof body.description === "string" ? body.description.trim() : "",
    oracle: typeof body.oracle === "string" ? body.oracle.trim() : "blade",
    priority: (["low", "medium", "high", "critical"] as const).includes(body.priority as any)
      ? (body.priority as KanbanTask["priority"])
      : "medium",
    status: (["inbox", "assigned", "in_progress", "review", "done"] as const).includes(body.status as any)
      ? (body.status as KanbanTask["status"])
      : "inbox",
    projectName: typeof body.projectName === "string" ? body.projectName : undefined,
    worktreeBranch: typeof body.worktreeBranch === "string" ? body.worktreeBranch : undefined,
    worktreePath: typeof body.worktreePath === "string" ? body.worktreePath : undefined,
    dispatchedAt: typeof body.dispatchedAt === "string" ? body.dispatchedAt : undefined,
    createdAt: now,
    updatedAt: now,
  };

  const tasks = await readTasks();
  tasks.unshift(task);
  await writeTasks(tasks);
  await broadcastAfterWrite();

  return c.json({ task }, 201);
});

// PATCH /api/kanban/tasks/:id
kanbanApi.patch("/kanban/tasks/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) {
    return c.json({ error: "Task not found" }, 404);
  }

  const now = new Date().toISOString();
  const existing = tasks[idx];
  const updated: KanbanTask = {
    ...existing,
    ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
    ...(typeof body.description === "string" ? { description: body.description.trim() } : {}),
    ...(typeof body.oracle === "string" ? { oracle: body.oracle.trim() } : {}),
    ...(typeof body.priority === "string" &&
      ["low", "medium", "high", "critical"].includes(body.priority)
      ? { priority: body.priority as KanbanTask["priority"] }
      : {}),
    ...(typeof body.status === "string" &&
      ["inbox", "assigned", "in_progress", "review", "done"].includes(body.status)
      ? { status: body.status as KanbanTask["status"] }
      : {}),
    ...(typeof body.projectName === "string" ? { projectName: body.projectName } : {}),
    ...(typeof body.worktreeBranch === "string" ? { worktreeBranch: body.worktreeBranch } : {}),
    ...(typeof body.worktreePath === "string" ? { worktreePath: body.worktreePath } : {}),
    ...(typeof body.dispatchedAt === "string" ? { dispatchedAt: body.dispatchedAt } : {}),
    updatedAt: now,
  };

  tasks[idx] = updated;
  await writeTasks(tasks);
  await broadcastAfterWrite();

  return c.json({ task: updated });
});

// DELETE /api/kanban/tasks/:id
kanbanApi.delete("/kanban/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const tasks = await readTasks();
  const filtered = tasks.filter((t) => t.id !== id);

  if (filtered.length === tasks.length) {
    return c.json({ error: "Task not found" }, 404);
  }

  await writeTasks(filtered);
  await broadcastAfterWrite();

  return c.json({ ok: true });
});
