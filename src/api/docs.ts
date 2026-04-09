import { Hono } from "hono";
import { swaggerUI } from "@hono/swagger-ui";
import spec from "./openapi.json";

export const docsApi = new Hono();

// Serve OpenAPI spec as JSON
docsApi.get("/openapi.json", (c) => c.json(spec));

// Swagger UI at /api/docs
docsApi.get("/docs", swaggerUI({ url: "/api/openapi.json" }));
