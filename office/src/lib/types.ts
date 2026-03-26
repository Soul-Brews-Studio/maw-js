export interface Window {
  index: number;
  name: string;
  active: boolean;
  cwd?: string;
}

export interface Session {
  name: string;
  windows: Window[];
  source?: string;  // peer URL or "local"
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
  project?: string;
  cwd?: string;
  source?: string;  // peer URL for federated agents, undefined = local
}

export interface AgentEvent {
  time: number;
  target: string;
  type: "status" | "command";
  detail: string;
}

export type AskType = "input" | "attention" | "plan";

export interface AskItem {
  id: string;
  oracle: string;
  target: string;      // tmux target e.g. "01-oracles:0"
  type: AskType;
  message: string;
  ts: number;
  dismissed?: boolean;
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
