import { startEnginePluginHealthPolling as defaultStartEnginePluginHealthPolling } from "../../core/engine-plugin-registry";

type ServeEngineHealthPollingDeps = {
  startEnginePluginHealthPolling: typeof defaultStartEnginePluginHealthPolling;
};

type StopPolling = ReturnType<typeof defaultStartEnginePluginHealthPolling>;

const defaultDeps: ServeEngineHealthPollingDeps = {
  startEnginePluginHealthPolling: defaultStartEnginePluginHealthPolling,
};

export function startServeEngineHealthPolling(
  deps: Partial<ServeEngineHealthPollingDeps> = {},
): { ok: true; stopPolling: StopPolling } {
  const d = { ...defaultDeps, ...deps };
  return { ok: true, stopPolling: d.startEnginePluginHealthPolling() };
}

export function serve(
  _ctx: Record<string, unknown> = {},
  deps?: Partial<ServeEngineHealthPollingDeps>,
): { ok: true; stopPolling: StopPolling } {
  return startServeEngineHealthPolling(deps);
}

export default serve;
