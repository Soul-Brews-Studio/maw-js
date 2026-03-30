import type { Hono } from "hono";
import { officeView } from "./office";
import { bitView } from "./8bit";
import { warRoomView } from "./war-room";
import { raceTrackView } from "./race-track";
import { supermanView } from "./superman";
import { arenaView } from "./arena";
import { talkView } from "./talk";
import { shrineView } from "./shrine";
import { federationView } from "./federation";
import { timemachineView } from "./timemachine";

export function mountViews(app: Hono) {
  app.route("/timemachine", timemachineView);
  app.route("/federation", federationView);
  app.route("/shrine", shrineView);
  app.route("/talk", talkView);
  app.route("/arena", arenaView);
  app.route("/office-8bit", bitView);
  app.route("/war-room", warRoomView);
  app.route("/race-track", raceTrackView);
  app.route("/superman", supermanView);
  // office must be last (catches /)
  app.route("/", officeView);
}
