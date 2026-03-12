export interface Window {
  index: number;
  name: string;
  active: boolean;
}

export interface Session {
  name: string;
  windows: Window[];
}

export type PaneStatus = "ready" | "busy" | "idle";

export interface AgentState {
  target: string;
  name: string;
  session: string;
  windowIndex: number;
  active: boolean;
  preview: string;
  status: PaneStatus;
}

export interface AgentEvent {
  time: number;
  target: string;
  type: "status" | "command" | "saiyan";
  detail: string;
}

export interface ConfigData {
  host: string;
  port: number;
  ghqRoot: string;
  oracleUrl: string;
  envMasked: Record<string, string>;
  commands: Record<string, string>;
  sessions: Record<string, string>;
}
