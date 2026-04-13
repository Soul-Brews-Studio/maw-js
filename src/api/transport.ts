/**
 * Transport API — exposes transport status and messaging via HTTP.
 *
 * Routes:
 *   GET  /api/transport/status   → status of all transports
 *   POST /api/transport/send     → send message via transport router
 */

import { Elysia } from "elysia";
import { getTransportRouter } from "../transports";
import { TransportSendBody, type TTransportSendBody } from "../lib/schemas";

export const transportApi = new Elysia();

// GET /api/transport/status — show all transports and their connectivity
transportApi.get("/transport/status", () => {
  const router = getTransportRouter();
  return {
    transports: router.status(),
    timestamp: new Date().toISOString(),
  };
});

// POST /api/transport/send — send a message through the transport router
transportApi.post("/transport/send", async ({ body }) => {
  const { oracle, host, message, from } = body as TTransportSendBody;

  const router = getTransportRouter();
  const result = await router.send(
    { oracle, host: host || undefined },
    message,
    from || "api",
  );

  return {
    ...result,
    target: oracle,
    host: host || "local",
  };
}, {
  body: TransportSendBody,
});
