import type { Hono } from "hono";
import { federationView } from "./federation";
import { timemachineView } from "./timemachine";
import { demoView } from "./demo";
import { infoView } from "./info";
import { messagesView } from "./messages";
import { companyView } from "./company";
import { companyStatusView } from "./company-status";
import { roomView } from "./room";
import { assetsView } from "./assets";

// UI moved to Soul-Brews-Studio/maw-ui (dev server on :5173).
// Only keep standalone HTML views that are self-contained.
export function mountViews(app: Hono) {
  app.route("/info", infoView);
  app.route("/demo", demoView);
  app.route("/timemachine", timemachineView);
  app.route("/federation", federationView);
  app.route("/messages", messagesView);
  app.route("/company", companyView);
  app.route("/company-status", companyStatusView); // kobo-445 — read-only per-oracle rollup (separate from the kanban board)
  app.route("/room", roomView); // kobo-245 — Brainstorm Room core wire
  app.route("/assets", assetsView); // kobo-398 — same-origin static assets (mermaid.js)
}
