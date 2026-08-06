import type { InvokeContext, InvokeResult, ServeHttpRouteRegistrar } from "../../../plugin/types";
import { createIdentityApi, type IdentityApiDeps } from "./impl";

type ServeIdentityContext = {
  http?: ServeHttpRouteRegistrar;
};

export function createIdentityRouteHandler(deps?: IdentityApiDeps) {
  const identityApi = createIdentityApi(deps);
  return (request: Request) => {
    const url = new URL(request.url);
    url.pathname = "/identity";
    return identityApi.handle(new Request(url.toString(), request));
  };
}

/** Register GET /api/identity during maw serve startup. */
export async function serve(ctx: ServeIdentityContext): Promise<{ ok: true; registered: boolean }> {
  if (!ctx.http) throw new Error("serve-identity requires serve http route registration");
  ctx.http.route("GET", "/api/identity", createIdentityRouteHandler());
  return { ok: true, registered: true };
}

export async function registerIdentityRouteForTests(targetApi: { use: (plugin: ReturnType<typeof createIdentityApi>) => unknown }): Promise<void> {
  targetApi.use(createIdentityApi());
}

export default async function handler(_ctx: InvokeContext): Promise<InvokeResult> {
  return { ok: true, output: "serve-identity registers GET /api/identity from the maw serve lifecycle hook" };
}

export { ADVERTISED_ENDPOINTS, createIdentityApi } from "./impl";
export type { IdentityApiDeps } from "./impl";
