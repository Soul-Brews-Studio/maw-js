import { UserError } from "maw-js/sdk";
const MAW_PORT = process.env.MAW_PORT || "3456";
const MAW_URL = `http://localhost:${MAW_PORT}`;

export async function cmdReply(correlationId: string, reply: string, data?: unknown) {
  if (!correlationId || !reply) {
    throw new UserError("usage: maw reply <correlationId> <message>");
  }

  const res = await fetch(`${MAW_URL}/api/reply/${correlationId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply, ...(data !== undefined ? { data } : {}) }),
  });

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    if (body?.error === "request not found") {
      console.error(`\x1b[31merror\x1b[0m: request '${correlationId}' not found`);
    } else if (body?.error === "already replied") {
      console.error(`\x1b[33mwarn\x1b[0m: request '${correlationId}' already replied`);
    } else {
      console.error(`\x1b[31merror\x1b[0m: ${body?.error || res.statusText}`);
    }
    return;
  }

  console.log(`\x1b[32mreplied\x1b[0m → ${correlationId}`);
}

export async function cmdReplyList(oracle?: string) {
  const params = new URLSearchParams();
  if (oracle) params.set("oracle", oracle);
  params.set("status", "delivered");

  const res = await fetch(`${MAW_URL}/api/requests?${params}`);
  const body = await res.json() as { requests?: Array<Record<string, unknown>>; total?: number };

  if (!body.requests?.length) {
    console.log("no pending requests");
    return;
  }

  for (const r of body.requests) {
    console.log(`  \x1b[36m${r.correlationId}\x1b[0m from \x1b[33m${r.from}\x1b[0m → ${r.message}`);
  }
  console.log(`\n${body.total} pending request(s)`);
}
