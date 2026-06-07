import type { ServeHttpRouteRegistrar, ServeRouteHandler, ServeRouteMethod } from "../plugin/types";

export type { ServeHttpRouteRegistrar, ServeRouteHandler, ServeRouteMethod } from "../plugin/types";

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

export class ServeRouteRegistry implements ServeHttpRouteRegistrar {
  private readonly routes = new Map<string, RegisteredServeRoute>();

  route(method: ServeRouteMethod, path: string, handler: ServeRouteHandler): void {
    assertAbsolutePath(path);
    const normalizedMethod = normalizeMethod(method);
    const key = `${normalizedMethod} ${path}`;
    if (this.routes.has(key)) throw new Error(`serve route already registered: ${key}`);
    this.routes.set(key, { method: normalizedMethod, path, handler });
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const route = this.routes.get(`${request.method.toUpperCase()} ${url.pathname}`);
    if (!route) return undefined;
    return route.handler(request);
  }

  snapshot(): Array<{ method: ServeRouteMethod; path: string }> {
    return [...this.routes.values()].map(({ method, path }) => ({ method, path }));
  }
}
