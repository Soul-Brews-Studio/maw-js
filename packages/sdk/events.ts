import type { TransportResult, TransportTarget } from "../../src/core/transport/transport";

export interface PluginEventMap {
  "transport:before_send": {
    target: TransportTarget;
    message: string;
    from: string;
  };
  "transport:after_send": {
    target: TransportTarget;
    message: string;
    from: string;
    result: TransportResult;
    via: string;
  };
  "transport:receive": {
    from: string;
    body: string;
    transport: string;
    timestamp: number;
  };
  "session:start": {
    oracle: string;
    session: string;
    repoPath: string;
  };
  "session:end": {
    oracle: string;
    session: string;
    window: string;
  };
  "feed:message_send": {
    from: string;
    to: string;
    body: string;
    channel: string;
  };
  "feed:status_change": {
    oracle: string;
    pane: string;
    from: string;
    to: string;
  };
  "serve:start": {
    port: number;
    hostname: string;
  };
  "serve:plugin_loaded": {
    name: string;
    phase: string;
  };
}
