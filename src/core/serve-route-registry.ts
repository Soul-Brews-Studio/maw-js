import type { ServeHttpRouteRegistrar, ServeRouteHandler, ServeRouteMethod } from "../plugin/types";

export type { ServeHttpRouteRegistrar, ServeRouteHandler, ServeRouteMethod } from "../plugin/types";

export type ServeRouteEnv = Record<string, unknown>;

export type ServeFallbackHandler = (
  req: Request,
  env?: ServeRouteEnv,
) => Response | Promise<Response>;

export interface ServeFallbackRegistrar {
  /** Register the public fallback surface used after core /ws and /api routing. */
  fallback(id: string, handler: ServeFallbackHandler): void;
}

export interface ServeHookContext {
  http: ServeHttpRouteRegistrar & ServeFallbackRegistrar;
  plugin?: { name: string; dir?: string };
}

type RegisteredServeRoute = {
  method: ServeRouteMethod;
  path: string;
  handler: ServeRouteHandler;
};

function normalizeMethod(method: ServeRouteMethod): ServeRouteMethod {
  return method.toUpperCase() as ServeRouteMethod;
}

function assertAbsolutePath(path: string): void {
  if (!path.startsWith("/")) throw new Error(`serve route path must start with '/': ${path}`);
}

export class ServeRouteRegistry implements ServeHttpRouteRegistrar, ServeFallbackRegistrar {
  private readonly routes = new Map<string, RegisteredServeRoute>();
  private readonly fallbackHandlers: Array<{ id: string; handler: ServeFallbackHandler }> = [];

  route(method: ServeRouteMethod, path: string, handler: ServeRouteHandler): void {
    assertAbsolutePath(path);
    const normalizedMethod = normalizeMethod(method);
    const key = `${normalizedMethod} ${path}`;
    if (this.routes.has(key)) throw new Error(`serve route already registered: ${key}`);
    this.routes.set(key, { method: normalizedMethod, path, handler });
  }

  fallback(id: string, handler: ServeFallbackHandler): void {
    if (!id.trim()) throw new Error("serve fallback id is required");
    if (typeof handler !== "function") throw new Error(`serve fallback ${id} handler must be a function`);
    if (this.fallbackHandlers.some((entry) => entry.id === id)) {
      throw new Error(`serve fallback already registered: ${id}`);
    }
    this.fallbackHandlers.push({ id, handler });
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const route = this.routes.get(`${request.method.toUpperCase()} ${url.pathname}`);
    if (!route) return undefined;
    return route.handler(request);
  }

  handleFallback(req: Request, env?: ServeRouteEnv): Response | Promise<Response> {
    const entry = this.fallbackHandlers[0];
    if (!entry) return new Response("Not Found", { status: 404 });
    return entry.handler(req, env);
  }

  snapshot(): Array<{ method: ServeRouteMethod; path: string }> {
    return [...this.routes.values()].map(({ method, path }) => ({ method, path }));
  }

  listFallbacks(): string[] {
    return this.fallbackHandlers.map((entry) => entry.id);
  }
}
