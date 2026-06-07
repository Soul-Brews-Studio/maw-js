import { api } from "../../../api";
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { createIdentityApi } from "./impl";

let registered = false;

/** Register GET /api/identity during maw serve startup. */
export async function serve(): Promise<{ ok: true; registered: boolean }> {
  if (!registered) {
    api.use(createIdentityApi());
    registered = true;
  }
  return { ok: true, registered };
}

export async function registerIdentityRouteForTests(targetApi: { use: (plugin: ReturnType<typeof createIdentityApi>) => unknown }): Promise<void> {
  targetApi.use(createIdentityApi());
}

export default async function handler(_ctx: InvokeContext): Promise<InvokeResult> {
  return { ok: true, output: "serve-identity registers GET /api/identity from the maw serve lifecycle hook" };
}

export { ADVERTISED_ENDPOINTS, createIdentityApi } from "./impl";
export type { IdentityApiDeps } from "./impl";
