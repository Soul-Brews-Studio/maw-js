import type { Hono } from "hono";
import { federationView } from "./federation";
import { timemachineView } from "./timemachine";
import { demoView } from "./demo";
import { infoView } from "./info";

// UI moved to Soul-Brews-Studio/maw-ui (dev server on :5173).
// Only keep standalone HTML views that are self-contained.
export function mountViews(app: Hono) {
  app.route("/info", infoView);
  app.route("/demo", demoView);
  app.route("/timemachine", timemachineView);
  app.route("/federation", federationView);
}
