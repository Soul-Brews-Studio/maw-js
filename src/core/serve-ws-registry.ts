import type { ServerWebSocket } from "bun";
import type { WSData } from "./types";

export type ServeWsData = WSData & { __serveWsRoute?: string; params?: Record<string, string> };
export type ServeWsSocket = ServerWebSocket<ServeWsData>;

export type ServeWsDataFactory = (request: Request) => WSData;
export type ServeWsHandler = (ws: ServeWsSocket, message?: unknown) => void | Promise<void>;

export interface ServeWsRouteHandlers {
  open?: (ws: ServeWsSocket) => void | Promise<void>;
  message?: (ws: ServeWsSocket, message: unknown) => void | Promise<void>;
  close?: (ws: ServeWsSocket) => void | Promise<void>;
}

export interface ServeWsRouteRegistrar {
  route(path: string, data: ServeWsDataFactory, handlers: ServeWsRouteHandlers): void;
  snapshot(): string[];
}

export type ServeWsUpgradeResult = {
  matched: boolean;
  response?: Response;
};

function assertAbsolutePath(path: string): void {
  if (!path.startsWith("/")) throw new Error(`serve ws route path must start with '/': ${path}`);
}

type RegisteredServeWsRoute = {
  path: string;
  data: ServeWsDataFactory;
  handlers: ServeWsRouteHandlers;
};
type RouteMatch = {
  params: Record<string, string>;
  route: RegisteredServeWsRoute;
};

export class ServeWsRegistry implements ServeWsRouteRegistrar {
  private readonly routes = new Map<string, RegisteredServeWsRoute>();
  private readonly paramRoutes: RegisteredServeWsRoute[] = [];

  readonly handlers = {
    open: (ws: ServeWsSocket) => this.dispatch("open", ws),
    message: (ws: ServeWsSocket, message: unknown) => this.dispatch("message", ws, message),
    close: (ws: ServeWsSocket) => this.dispatch("close", ws),
  };

  route(path: string, data: ServeWsDataFactory, handlers: ServeWsRouteHandlers): void {
    assertAbsolutePath(path);
    if (this.routes.has(path)) throw new Error(`serve ws route already registered: ${path}`);
    const entry = { path, data, handlers };
    this.routes.set(path, entry);
    if (path.includes(":")) this.paramRoutes.push(entry);
  }

  private match(pathname: string): RouteMatch | null {
    const exact = this.routes.get(pathname);
    if (exact && !exact.path.includes(":")) {
      return { route: exact, params: {} };
    }

    for (const entry of this.paramRoutes) {
      const template = entry.path.split("/").filter(Boolean);
      const actual = pathname.split("/").filter(Boolean);
      if (template.length !== actual.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < template.length; i += 1) {
        const token = template[i];
        if (token.startsWith(":")) {
          params[token.slice(1)] = decodeURIComponent(actual[i] ?? "");
        } else if (token !== actual[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: entry, params };
    }

    return null;
  }

  handleUpgrade(req: Request, server: { upgrade: (request: Request, options: { data: ServeWsData }) => boolean }): ServeWsUpgradeResult {
    const url = new URL(req.url);
    const match = this.match(url.pathname);
    const route = match?.route;
    if (!route) return { matched: false };

    const data = { ...route.data(req), __serveWsRoute: route.path, ...(Object.keys(match?.params ?? {}).length ? { params: match?.params } : {}) } as ServeWsData;
    if (server.upgrade(req, { data })) return { matched: true };
    return { matched: true, response: new Response("WebSocket upgrade failed", { status: 400 }) };
  }

  snapshot(): string[] {
    return [...this.routes.keys()];
  }

  private dispatch(kind: keyof ServeWsRouteHandlers, ws: ServeWsSocket, message?: unknown): void | Promise<void> {
    const routeId = ws.data.__serveWsRoute ?? (ws.data.mode === "pty"
      ? "/ws/pty"
      : ws.data.mode === "tmux-stream"
        ? "/ws/tmux"
        : "/ws");
    const route = this.routes.get(routeId);
    const handler = route?.handlers[kind];
    if (!handler) return;
    if (kind === "message") return (handler as NonNullable<ServeWsRouteHandlers["message"]>)(ws, message);
    return (handler as NonNullable<ServeWsRouteHandlers["open"]>)(ws);
  }
}
