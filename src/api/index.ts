import { Hono } from "hono";
import { sessionsApi } from "./sessions";
import { feedApi } from "./feed";
import { teamsApi } from "./teams";
import { configApi } from "./config";
import { fleetApi } from "./fleet";
import { asksApi } from "./asks";
import { oracleApi } from "./oracle";
import { federationApi } from "./federation";
import { worktreesApi } from "./worktrees";
import { uiStateApi } from "./ui-state";
import { deprecatedApi } from "./deprecated";
import { costsApi } from "./costs";
import { triggersApi } from "./triggers";
import { avengersApi } from "./avengers";
import { transportApi } from "./transport";
import { workspaceApi } from "./workspace";
import { peerExecApi } from "./peer-exec";
import { proxyApi } from "./proxy";
import { pulseApi } from "./pulse";
import { federationAuth } from "../lib/federation-auth";

export const api = new Hono();

// Federation auth — enforces HMAC on protected endpoints from remote peers
api.use("*", federationAuth());

api.route("/", sessionsApi);
api.route("/", feedApi);
api.route("/", teamsApi);
api.route("/", configApi);
api.route("/", fleetApi);
api.route("/", asksApi);
api.route("/", oracleApi);
api.route("/", federationApi);
api.route("/", worktreesApi);
api.route("/", uiStateApi);
api.route("/", deprecatedApi);
api.route("/", costsApi);
api.route("/", triggersApi);
api.route("/", avengersApi);
api.route("/", transportApi);
api.route("/", workspaceApi);
api.route("/", peerExecApi);
api.route("/", proxyApi);
api.route("/", pulseApi);
