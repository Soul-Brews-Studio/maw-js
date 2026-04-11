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
import { mawLogApi } from "./maw-log";
import { costsApi } from "./costs";
import { triggersApi } from "./triggers";
import { avengersApi } from "./avengers";
import { transportApi } from "./transport";
import { workspaceApi } from "./workspace";
import { monitoringApi } from "./monitoring";
import { healthApi } from "./health";
import { consciousnessApi } from "./consciousness";
import { onboardingApi } from "./onboarding";
import { dispatchApi } from "./dispatch";
import { chatsApi } from "./chats";
import { alertsApi } from "./alerts";
import { scheduleApi } from "./schedule";
import { tenantApi } from "./tenant";
import { docsApi } from "./docs";
import { federationAuth } from "../lib/federation-auth";
import { apiKeyAuth } from "../lib/api-key-auth";

export const api = new Hono();

// Docs — public, before auth middleware
api.route("/", docsApi);

// Federation auth — enforces HMAC on protected endpoints from remote peers
api.use("*", federationAuth());

// API key auth — multi-tenant (after federation, before routes)
api.use("*", apiKeyAuth());

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
api.route("/", mawLogApi);
api.route("/", deprecatedApi);
api.route("/", costsApi);
api.route("/", triggersApi);
api.route("/", avengersApi);
api.route("/", transportApi);
api.route("/", workspaceApi);
api.route("/", monitoringApi);
api.route("/", healthApi);
api.route("/", consciousnessApi);
api.route("/", onboardingApi);
api.route("/", dispatchApi);
api.route("/", chatsApi);
api.route("/", alertsApi);
api.route("/", scheduleApi);
api.route("/", tenantApi);
