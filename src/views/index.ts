import type { Hono } from "hono";
import { federationView } from "./federation";
import { timemachineView } from "./timemachine";
import { demoView } from "./demo";

// UI moved to evilelfza/maw-ui (dev server on :3457).
// Only keep standalone HTML views that are self-contained.
export function mountViews(app: Hono) {
  app.route("/demo", demoView);
  app.route("/timemachine", timemachineView);
  app.route("/federation", federationView);
}
