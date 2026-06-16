import type {
  ServeFallbackHandler,
  ServeHttpRouteRegistrar,
  ServeRouteHandler,
  ServeRouteMethod,
  ServeRouteRegistrar,
} from "../plugin/types";

export type { ServeFallbackHandler, ServeHttpRouteRegistrar, ServeRouteHandler, ServeRouteMethod, ServeRouteRegistrar } from "../plugin/types";

export type ServeRouteEnv = Record<string, unknown>;

export type ServeRouteOwner = {
  name: string;
  dir?: string;
};

export interface ServeRouteRegistryContext extends ServeRouteRegistrar {
  /** Return a plugin-scoped registrar so route ownership is captured centrally. */
  forPlugin(plugin: ServeRouteOwner): ServeRouteRegistrar;
}

export interface ServeHookContext {
  http: ServeRouteRegistrar;
  plugin?: ServeRouteOwner;
}

type RegisteredServeRoute = {
  method: ServeRouteMethod;
  path: string;
  handler: ServeRouteHandler;
  plugin?: ServeRouteOwner;
};

type RegisteredServeFallback = {
  id: string;
  handler: ServeFallbackHandler;
  plugin?: ServeRouteOwner;
};

function normalizeMethod(method: ServeRouteMethod): ServeRouteMethod {
  return method.toUpperCase() as ServeRouteMethod;
}

function assertAbsolutePath(path: string): void {
  if (!path.startsWith("/")) throw new Error(`serve route path must start with '/': ${path}`);
}

function routePathMatches(pattern: string, pathname: string): boolean {
  if (pattern === pathname) return true;
  if (!pattern.includes(":")) return false;
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
}

function pluginLabel(plugin?: ServeRouteOwner): string {
  return plugin?.name ? ` (${plugin.name})` : "";
}

export class ServeRouteRegistry implements ServeRouteRegistryContext {
  private readonly routes = new Map<string, RegisteredServeRoute>();
  private readonly fallbackHandlers: RegisteredServeFallback[] = [];

  forPlugin(plugin: ServeRouteOwner): ServeRouteRegistrar {
    if (!plugin.name.trim()) throw new Error("serve route plugin name is required");
    const owner = { name: plugin.name, ...(plugin.dir ? { dir: plugin.dir } : {}) };
    return {
      route: (method, path, handler) => this.registerRoute(owner, method, path, handler),
      fallback: (id, handler) => this.registerFallback(owner, id, handler),
    };
  }

  route(method: ServeRouteMethod, path: string, handler: ServeRouteHandler): void {
    this.registerRoute(undefined, method, path, handler);
  }

  fallback(id: string, handler: ServeFallbackHandler): void {
    this.registerFallback(undefined, id, handler);
  }

  private registerRoute(
    plugin: ServeRouteOwner | undefined,
    method: ServeRouteMethod,
    path: string,
    handler: ServeRouteHandler,
  ): void {
    assertAbsolutePath(path);
    if (typeof handler !== "function") throw new Error(`serve route ${method} ${path} handler must be a function`);
    const normalizedMethod = normalizeMethod(method);
    const key = `${normalizedMethod} ${path}`;
    const existing = this.routes.get(key);
    if (existing) {
      throw new Error(`serve route already registered: ${key}${pluginLabel(existing.plugin)}`);
    }
    this.routes.set(key, { method: normalizedMethod, path, handler, plugin });
  }

  private registerFallback(plugin: ServeRouteOwner | undefined, id: string, handler: ServeFallbackHandler): void {
    if (!id.trim()) throw new Error("serve fallback id is required");
    if (typeof handler !== "function") throw new Error(`serve fallback ${id} handler must be a function`);
    const existing = this.fallbackHandlers.find((entry) => entry.id === id);
    if (existing) {
      throw new Error(`serve fallback already registered: ${id}${pluginLabel(existing.plugin)}`);
    }
    this.fallbackHandlers.push({ id, handler, plugin });
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase() as ServeRouteMethod;
    const exact = this.routes.get(`${method} ${url.pathname}`);
    if (exact) return exact.handler(request);
    const route = [...this.routes.values()].find((candidate) =>
      candidate.method === method && routePathMatches(candidate.path, url.pathname),
    );
    if (!route) return undefined;
    return route.handler(request);
  }

  handleFallback(req: Request, env?: ServeRouteEnv): Response | Promise<Response> {
    const entry = this.fallbackHandlers[0];
    if (!entry) return new Response("Not Found", { status: 404 });
    return entry.handler(req, env);
  }

  snapshot(): Array<{ method: ServeRouteMethod; path: string; plugin?: string }> {
    return [...this.routes.values()].map(({ method, path, plugin }) => ({
      method,
      path,
      ...(plugin?.name ? { plugin: plugin.name } : {}),
    }));
  }

  listFallbacks(): string[] {
    return this.fallbackHandlers.map((entry) => entry.id);
  }

  fallbackSnapshot(): Array<{ id: string; plugin?: string }> {
    return this.fallbackHandlers.map(({ id, plugin }) => ({
      id,
      ...(plugin?.name ? { plugin: plugin.name } : {}),
    }));
  }
}
