export interface SessionWindow {
  index: number;
  name: string;
  active: boolean;
}

export interface SessionInfo {
  name: string;
  windows: SessionWindow[];
}
