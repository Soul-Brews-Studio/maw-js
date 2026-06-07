import type { MawEngine } from "../../../engine";
import type { WSData } from "../../../core/types";
import type { ServeWsRouteRegistrar, ServeWsSocket } from "../../../core/serve-ws-registry";
import type { handlePtyClose, handlePtyMessage } from "../../../core/transport/pty";

type WsDeps = {
  handlePtyMessage: typeof handlePtyMessage;
  handlePtyClose: typeof handlePtyClose;
};

type ServeWsContext = {
  ws?: ServeWsRouteRegistrar;
  engine?: MawEngine;
};

function defaultDeps(): WsDeps {
  const pty = require("../../../core/transport/pty");
  return {
    handlePtyMessage: pty.handlePtyMessage,
    handlePtyClose: pty.handlePtyClose,
  };
}

function defaultWsData(mode?: WSData["mode"]): WSData {
  return { target: null, previewTargets: new Set(), ...(mode ? { mode } : {}) };
}

export function registerServeWsRoutes(ctx: ServeWsContext, deps: WsDeps = defaultDeps()): void {
  if (!ctx.ws) throw new Error("serve-ws requires serve ws route registration");
  if (!ctx.engine) throw new Error("serve-ws requires MawEngine in serve context");

  const registered = ctx.ws.snapshot();

  if (!registered.includes("/ws/pty")) {
    ctx.ws.route("/ws/pty", () => defaultWsData("pty"), {
      message: (ws, msg) => deps.handlePtyMessage(ws, msg as string | Buffer),
      close: (ws) => deps.handlePtyClose(ws),
    });
  }

  if (!registered.includes("/ws")) {
    ctx.ws.route("/ws", () => defaultWsData(), {
      open: (ws: ServeWsSocket) => ctx.engine!.handleOpen(ws as never),
      message: (ws: ServeWsSocket, msg: unknown) => ctx.engine!.handleMessage(ws as never, msg as never),
      close: (ws: ServeWsSocket) => ctx.engine!.handleClose(ws as never),
    });
  }
}

export function serve(ctx: ServeWsContext, deps?: WsDeps): { ok: true; routes: string[] } {
  registerServeWsRoutes(ctx, deps);
  return { ok: true, routes: ["/ws/pty", "/ws"] };
}

export default serve;
