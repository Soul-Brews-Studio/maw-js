import { Elysia, t} from "elysia";
import { loadConfig } from "../config";

const ORACLE_URL = process.env.ORACLE_URL || loadConfig().oracleUrl;

export const oracleApi = new Elysia();

oracleApi.get("/oracle/search", async ({ query, set}) => {
  const q = query?.q;
  if (!q) { set.status = 400; return { error: "q required" }; }
  const params = new URLSearchParams({ q, mode: query?.mode || "hybrid", limit: query?.limit || "10" });
  if (query?.model) params.set("model", query.model);
  try {
    const res = await fetch(`${ORACLE_URL}/api/search?${params}`);
    return await res.json();
  } catch (e: any) {
    set.status = 502; return { error: `Oracle unreachable: ${e.message}` };
  }
}, {
  query: t.Object({
    q: t.Optional(t.String()),
    mode: t.Optional(t.String()),
    limit: t.Optional(t.String()),
    model: t.Optional(t.String()),
  }),
});

oracleApi.get("/oracle/traces", async ({ query, set}) => {
  const limit = query?.limit || "10";
  try {
    const res = await fetch(`${ORACLE_URL}/api/traces?limit=${limit}`);
    return await res.json();
  } catch (e: any) {
    set.status = 502; return { error: `Oracle unreachable: ${e.message}` };
  }
}, {
  query: t.Object({ limit: t.Optional(t.String()) }),
});

oracleApi.get("/oracle/stats", async ({ set }) => {
  try {
    const res = await fetch(`${ORACLE_URL}/api/stats`);
    return await res.json();
  } catch (e: any) {
    set.status = 502; return { error: `Oracle unreachable: ${e.message}` };
  }
});
