export interface MawLogEntry {
  ts: string;
  from: string;
  to: string;
  msg: string;
  ch?: string;
}

export function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}↔${b}` : `${b}↔${a}`;
}

export function nameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function displayName(name: string): string {
  return name.replace(/-oracle$/, "").replace(/-mawjs$/, "");
}

export function isHuman(name: string): boolean {
  return name === "nat";
}
