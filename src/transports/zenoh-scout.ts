/**
 * Compatibility shim for the zenoh-scout transport.
 *
 * The implementation lives on the zenoh-scout plugin module surface. Core code
 * must not import vendored plugin internals directly; use this async helper only
 * when a legacy caller still needs to request the plugin-provided transport.
 */
import type { MawConfig } from "../config/types";
import type { Transport } from "../core/transport/transport";
import { importPluginSymbol } from "../plugin/registry";

type PluginTransportFactory = (config: MawConfig) => Transport | Promise<Transport>;

export async function createZenohScoutTransport(config: MawConfig): Promise<Transport> {
  const factory = await importPluginSymbol<PluginTransportFactory>("zenoh-scout", "createZenohScoutTransport");
  return await factory(config);
}
