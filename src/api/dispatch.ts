import { Hono } from "hono";

export const dispatchApi = new Hono();

const ORACLE_TARGETS = new Set([
  "blade", "lens", "edge", "clip", "deck", "scope",
  "quill", "link", "bastion", "warden", "prism", "sage",
]);

// POST /api/dispatch -- receives { target, message }, executes `maw hey <target> "<message>"`
dispatchApi.post("/dispatch", async (c) => {
  let body: { target?: unknown; message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } }, 400);
  }

  const target = typeof body.target === "string" ? body.target.trim().toLowerCase() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!target) {
    return c.json({ success: false, error: { code: "VALIDATION_ERROR", message: "target is required" } }, 400);
  }
  if (!message) {
    return c.json({ success: false, error: { code: "VALIDATION_ERROR", message: "message is required" } }, 400);
  }
  if (!ORACLE_TARGETS.has(target)) {
    const valid = Array.from(ORACLE_TARGETS);
    return c.json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `Unknown target: ${target}. Valid targets: ${valid.join(", ")}`,
      },
    }, 400);
  }

  try {
    const proc = Bun.spawn(["maw", "hey", target, message], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const errMsg = stderr.trim().slice(0, 400) || `maw exited with code ${exitCode}`;
      return c.json({
        success: false,
        error: { code: "DISPATCH_FAILED", message: errMsg },
      }, 500);
    }

    return c.json({
      success: true,
      data: { target, output: stdout.trim().slice(0, 1000) },
    });
  } catch (err: any) {
    return c.json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to execute dispatch command" },
    }, 500);
  }
});
