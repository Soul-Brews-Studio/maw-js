import type { WSData } from "../../core/types";
import type { ServeWsRouteRegistrar } from "../../core/serve-ws-registry";
import type { handleTmuxStreamClose, handleTmuxStreamMessage, handleTmuxStreamOpen } from "../../api/tmux-stream";

type TmuxStreamWsDeps = {
  handleTmuxStreamOpen: typeof handleTmuxStreamOpen;
  handleTmuxStreamMessage: typeof handleTmuxStreamMessage;
  handleTmuxStreamClose: typeof handleTmuxStreamClose;
};

type ServeTmuxStreamWsContext = {
  ws?: ServeWsRouteRegistrar;
};

function defaultDeps(): TmuxStreamWsDeps {
  const tmux = require("../../api/tmux-stream");
  return {
    handleTmuxStreamOpen: tmux.handleTmuxStreamOpen,
    handleTmuxStreamMessage: tmux.handleTmuxStreamMessage,
    handleTmuxStreamClose: tmux.handleTmuxStreamClose,
  };
}

function tmuxStreamWsData(): WSData {
  return { target: null, previewTargets: new Set(), mode: "tmux-stream" };
}

export function registerServeTmuxStreamWsRoute(ctx: ServeTmuxStreamWsContext, deps: TmuxStreamWsDeps = defaultDeps()): void {
  if (!ctx.ws) throw new Error("serve-tmux-stream-ws requires serve ws route registration");

  ctx.ws.route("/ws/tmux", () => tmuxStreamWsData(), {
    open: (ws) => deps.handleTmuxStreamOpen(ws),
    message: (ws, msg) => deps.handleTmuxStreamMessage(ws, msg),
    close: (ws) => deps.handleTmuxStreamClose(ws),
  });
}

export function serve(ctx: ServeTmuxStreamWsContext, deps?: TmuxStreamWsDeps): { ok: true; routes: string[] } {
  registerServeTmuxStreamWsRoute(ctx, deps);
  return { ok: true, routes: ["/ws/tmux"] };
}

export default serve;
