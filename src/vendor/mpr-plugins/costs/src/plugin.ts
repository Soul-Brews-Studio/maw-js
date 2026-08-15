import { Host, Memory } from "@extism/as-pdk";
import { length } from "@extism/as-pdk/lib/env";
import { fsRead, fsList } from "@maw-rs/wasm-sdk";

@external("extism:host/user", "maw.paths.get") declare function mawPathsGet(input: u64): u64;
export function myAbort(message: string | null, fileName: string | null, lineNumber: u32, columnNumber: u32): void {}

class Usage { input: f64 = 0; output: f64 = 0; cacheRead: f64 = 0; cacheCreate: f64 = 0; turns: i32 = 0; model: string = ""; last: string = ""; }
class Agent { name: string; tokens: f64 = 0; cost: f64 = 0; sessions: i32 = 0; turns: i32 = 0; last: string = ""; daily: f64[] = []; had: bool[] = []; constructor(name: string) { this.name = name; } }
class Parsed { value: string = ""; next: i32 = 0; }

export function handle(): i32 {
  const input = Host.inputString();
  const args = extractArgs(input);
  const parsed = parseArgs(args);
  if (parsed.startsWith("error:")) return finish(false, "", parsed.slice(6) + "\n" + usage());
  const projects = projectsDir(input);
  const agents = collect(projects, parsed.startsWith("daily:"), parsed.startsWith("daily:") ? toInt(parsed.slice(6)) : 7);
  if (agents.length < 0) return finish(false, "", "Cannot read ~/.claude/projects/\n");
  if (parsed.startsWith("daily:")) {
    const days = toInt(parsed.slice(6));
    return finish(true, renderDaily(agents, days, has(args, "--json") || has(args, "-j")), "");
  }
  return finish(true, renderSummary(agents), "");
}

function usage(): string { return "usage: maw-rs costs [--daily [N]|--days N] [--json]"; }

function parseArgs(args: string[]): string {
  let daily = false; let days = 7;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a == "--help" || a == "-h") return "error:" + usage();
    if (a == "--json" || a == "-j") continue;
    if (a == "--daily") { daily = true; if (i + 1 < args.length && !args[i + 1].startsWith("-")) { days = parseDays(args[i + 1]); if (days == 0) return "error:costs: days must be 1–365"; i++; } continue; }
    if (a == "--days") { daily = true; if (i + 1 >= args.length || args[i + 1].startsWith("-")) return "error:costs: missing --days value"; days = parseDays(args[i + 1]); if (days == 0) return "error:costs: days must be 1–365"; i++; continue; }
    return "error:costs: unknown argument " + a;
  }
  return daily ? "daily:" + days.toString() : "summary";
}
function parseDays(s: string): i32 { const n = toInt(s); return n >= 1 && n <= 365 && n.toString() == s ? n : 0; }

function projectsDir(input: string): string {
  const fromHost = pathGet("claude-projects"); if (fromHost.length > 0) return fromHost;
  const home = jsonStringField(input, "home"); return home.length > 0 ? home + "/.claude/projects" : ".";
}
function pathGet(name: string): string { const input = Memory.allocateString("{\"name\":" + quote(name) + "}"); const output = mawPathsGet(input.offset); const out = new Memory(output, length(output)).toString(); return out.indexOf("\"ok\":true") < 0 ? "" : jsonStringField(out, "path"); }

function collect(projects: string, dailyMode: bool, days: i32): Agent[] {
  const buckets = makeBuckets(days); const agents = new Array<Agent>();
  const dirs = list(projects, "dir");
  for (let d = 0; d < dirs.length; d++) {
    const dir = dirs[d]; const files = list(dir, "file"); if (files.length == 0) continue;
    const name = agentName(baseName(dir)); let agent = findAgent(agents, name); if (agent === null) { agent = new Agent(name); agent.daily = zeros(days); agent.had = falses(days); agents.push(agent); }
    for (let f = 0; f < files.length; f++) {
      if (!files[f].endsWith(".jsonl")) continue;
      const u = scan(read(files[f])); if (u.turns == 0) continue;
      const cost = estimate(u); const tokens = u.input + u.output + u.cacheRead + u.cacheCreate;
      if (dailyMode) { const idx = indexOf(buckets, u.last.slice(0, 10)); if (idx >= 0) { agent.daily[idx] += cost; agent.cost += cost; agent.had[idx] = true; } }
      else { agent.tokens += tokens; agent.cost += cost; agent.sessions += 1; agent.turns += u.turns; if (u.last > agent.last) agent.last = u.last; }
    }
  }
  const active = new Array<Agent>();
  for (let i = 0; i < agents.length; i++) if (dailyMode ? agents[i].cost > 0 : agents[i].sessions > 0) active.push(agents[i]);
  sortAgents(active); return active;
}

function scan(content: string): Usage {
  const u = new Usage(); let i = 0;
  while (i < content.length) { let e = content.indexOf("\n", i); if (e < 0) e = content.length; const line = content.slice(i, e); i = e + 1;
    if (jsonStringField(line, "type") != "assistant") continue; const msg = readJsonValueAtKey(line, "message"); const use = readJsonValueAtKey(msg, "usage"); if (use == "") continue;
    u.input += jsonNum(use, "input_tokens"); u.output += jsonNum(use, "output_tokens"); u.cacheRead += jsonNum(use, "cache_read_input_tokens"); u.cacheCreate += jsonNum(use, "cache_creation_input_tokens"); u.turns += 1;
    if (u.model == "") u.model = jsonStringField(msg, "model"); const ts = jsonStringField(line, "timestamp"); if (ts.length > 0) u.last = ts;
  }
  return u;
}

function renderSummary(agents: Agent[]): string {
  if (agents.length == 0) return "\x1b[90mno session data found\x1b[0m\n";
  let totalSessions = 0; let totalTokens: f64 = 0; let totalCost: f64 = 0;
  for (let i = 0; i < agents.length; i++) { totalSessions += agents[i].sessions; totalTokens += agents[i].tokens; totalCost += agents[i].cost; }
  const hdr = padEnd("Agent", 30) + "  " + padStart("Tokens", 14) + "  " + padStart("Est. Cost", 12) + "  " + padStart("Sessions", 10) + "  " + padStart("Turns", 8) + "  " + padStart("Last Active", 13);
  let out = "\n\x1b[36mCOST TRACKING\x1b[0m  (" + agents.length.toString() + " agents, " + totalSessions.toString() + " sessions)\n\n";
  out += "  \x1b[90m" + hdr + "\x1b[0m\n  \x1b[90m" + repeat("─", hdr.length) + "\x1b[0m\n";
  for (let i = 0; i < agents.length; i++) { const a = agents[i]; const name = truncate(a.name, 28); const last = a.last == "" ? "—" : a.last.slice(0, 10); out += "  " + padEnd(name, 30) + "  " + padStart(fmtNum(a.tokens), 14) + "  " + color(a.cost, 10, 1) + padStart("$" + fixed2(a.cost), 12) + "\x1b[0m  " + padStart(a.sessions.toString(), 10) + "  " + padStart(a.turns.toString(), 8) + "  " + padStart(last, 13) + "\n"; }
  out += "  \x1b[90m" + repeat("─", hdr.length) + "\x1b[0m\n  " + padEnd("TOTAL", 30) + "  " + padStart(fmtNum(totalTokens), 14) + "  " + color(totalCost, 50, 10) + padStart("$" + fixed2(totalCost), 12) + "\x1b[0m  " + padStart(totalSessions.toString(), 10) + "\n\n";
  return out;
}

function renderDaily(agents: Agent[], days: i32, asJson: bool): string {
  const buckets = makeBuckets(days); let totalCost: f64 = 0; for (let i = 0; i < agents.length; i++) totalCost += agents[i].cost;
  if (asJson) return dailyJson(agents, buckets, totalCost);
  if (agents.length == 0) return "\x1b[90mno activity in the last " + days.toString() + " days\x1b[0m\n";
  let out = "\n\x1b[36mDAILY COSTS\x1b[0m  (" + days.toString() + "d ending " + buckets[buckets.length - 1] + ")\n\n";
  const nameWidth = 28;
  for (let i = 0; i < agents.length; i++) out += "  " + padEndOrTrunc(agents[i].name, nameWidth) + "  " + spark(agents[i].daily, agents[i].had) + "  $" + fixed2(agents[i].cost) + "\n";
  const totals = zeros(days); const had = falses(days); for (let d = 0; d < days; d++) { for (let i = 0; i < agents.length; i++) totals[d] += agents[i].daily[d]; had[d] = totals[d] > 0; }
  out += "  " + repeat("─", nameWidth + 2 + days + 4) + "\n  " + padEnd("TOTAL", nameWidth) + "  " + spark(totals, had) + "  $" + fixed2(totalCost) + "\n\n"; return out;
}
function dailyJson(agents: Agent[], buckets: string[], totalCost: f64): string {
  let out = "{\n  \"window\": " + buckets.length.toString() + ",\n  \"buckets\": [\n";
  for (let i = 0; i < buckets.length; i++) out += "    " + quote(buckets[i]) + (i + 1 < buckets.length ? "," : "") + "\n";
  out += "  ],\n  \"agents\": [\n";
  for (let i = 0; i < agents.length; i++) { const a = agents[i]; out += "    {\n      \"name\": " + quote(a.name) + ",\n      \"dailyCosts\": [\n"; for (let d = 0; d < buckets.length; d++) out += "        " + numJson(a.daily[d]) + (d + 1 < buckets.length ? "," : "") + "\n"; out += "      ],\n      \"totalCost\": " + numJson(a.cost) + ",\n      \"hadActivity\": [\n"; for (let d = 0; d < buckets.length; d++) out += "        " + (a.had[d] ? "true" : "false") + (d + 1 < buckets.length ? "," : "") + "\n"; out += "      ]\n    }" + (i + 1 < agents.length ? "," : "") + "\n"; }
  out += "  ],\n  \"total\": {\n    \"cost\": " + numJson(totalCost) + ",\n    \"agents\": " + agents.length.toString() + "\n  }\n}\n"; return out;
}

function list(path: string, kind: string): string[] { const res = fsList("{\"path\":" + quote(path) + ",\"recursive\":false,\"includeDirs\":true,\"maxEntries\":1000}"); const out = new Array<string>(); if (res.indexOf("\"ok\":true") < 0) return out; const objs = jsonObjectsInArray(res, "entries"); for (let i = 0; i < objs.length; i++) if (jsonStringField(objs[i], "kind") == kind) out.push(jsonStringField(objs[i], "path")); sortPaths(out); return out; }
function read(path: string): string { const res = fsRead("{\"path\":" + quote(path) + ",\"encoding\":\"utf8\",\"maxBytes\":10485760}"); return res.indexOf("\"ok\":true") < 0 ? "" : jsonStringField(res, "content"); }
function estimate(u: Usage): f64 { const tier = modelTier(u.model); const inRate = tier == "opus" ? 15 : tier == "haiku" ? 0.25 : 3; const outRate = tier == "opus" ? 75 : tier == "haiku" ? 1.25 : 15; return ((u.input + u.cacheRead + u.cacheCreate) / 1000000) * inRate + (u.output / 1000000) * outRate; }
function modelTier(m: string): string { return m.indexOf("opus") >= 0 ? "opus" : m.indexOf("haiku") >= 0 ? "haiku" : "sonnet"; }
function agentName(dir: string): string { const trimmed = dir.startsWith("-") ? dir.slice(1) : dir; const parts = trimmed.split("-"); for (let i = 0; i < parts.length; i++) if (parts[i] == "github" && i + 3 < parts.length && parts[i + 1] == "com") return join(parts, i + 2); return parts.length >= 2 ? parts[parts.length - 2] + "-" + parts[parts.length - 1] : trimmed; }
function makeBuckets(days: i32): string[] { const today = jsonStringField(Host.inputString(), "today"); const raw = today.length >= 10 ? today.slice(0, 10) : "2026-06-25"; const base = daysFromCivil(toInt(raw.slice(0,4)), toInt(raw.slice(5,7)), toInt(raw.slice(8,10))); const out = new Array<string>(); for (let i = 0; i < days; i++) out.push(civilFromDays(base - (days - 1 - i))); return out; }
function daysFromCivil(year0: i32, month0: i32, day0: i32): i32 { let year = year0 - (month0 <= 2 ? 1 : 0); const era = (year >= 0 ? year : year - 399) / 400; const yoe = year - era * 400; const month = month0; const doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day0 - 1; const doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; return era * 146097 + doe - 719468; }
function civilFromDays(days0: i32): string { let z = days0 + 719468; const era = (z >= 0 ? z : z - 146096) / 146097; const doe = z - era * 146097; const yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; let y = yoe + era * 400; const doy = doe - (365 * yoe + yoe / 4 - yoe / 100); const mp = (5 * doy + 2) / 153; const d = doy - (153 * mp + 2) / 5 + 1; const m = mp + (mp < 10 ? 3 : -9); y += m <= 2 ? 1 : 0; return y.toString().padStart(4, "0") + "-" + m.toString().padStart(2, "0") + "-" + d.toString().padStart(2, "0"); }
function spark(values: f64[], had: bool[]): string { const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]; let max: f64 = -1; for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i]; let out = ""; for (let i = 0; i < values.length; i++) { if (!had[i]) out += "░"; else if (max == 0) out += "▁"; else out += blocks[Math.round((values[i] / max) * 7) as i32 + 1]; } return out; }
function findAgent(a: Agent[], name: string): Agent | null { for (let i = 0; i < a.length; i++) if (a[i].name == name) return a[i]; return null; }
function sortAgents(a: Agent[]): void { for (let i = 1; i < a.length; i++) { const x = a[i]; let j = i; while (j > 0 && a[j - 1].cost < x.cost) { a[j] = a[j - 1]; j--; } a[j] = x; } }
function sortPaths(a: string[]): void { for (let i = 1; i < a.length; i++) { const x = a[i]; let j = i; while (j > 0 && a[j - 1] > x) { a[j] = a[j - 1]; j--; } a[j] = x; } }
function indexOf(a: string[], v: string): i32 { for (let i = 0; i < a.length; i++) if (a[i] == v) return i; return -1; }
function zeros(n: i32): f64[] { const a = new Array<f64>(); for (let i = 0; i < n; i++) a.push(0); return a; }
function falses(n: i32): bool[] { const a = new Array<bool>(); for (let i = 0; i < n; i++) a.push(false); return a; }
function join(a: string[], start: i32): string { let out = ""; for (let i = start; i < a.length; i++) { if (i > start) out += "-"; out += a[i]; } return out; }
function baseName(p: string): string { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }
function fmtNum(n: f64): string { if (n >= 1000000000) return fixed1(n / 1000000000) + "B"; if (n >= 1000000) return fixed1(n / 1000000) + "M"; if (n >= 1000) return fixed1(n / 1000) + "K"; return (n as i64).toString(); }
function fixed1(n: f64): string { const t = Math.round(n * 10) as i64; return (t / 10).toString() + "." + (t % 10).toString(); }
function fixed2(n: f64): string { const c = Math.round(n * 100) as i64; const f = c % 100; return (c / 100).toString() + "." + (f < 10 ? "0" : "") + f.toString(); }
function numJson(n: f64): string { const c = Math.round(n * 1000000) as i64; if (c % 1000000 == 0) return (c / 1000000).toString() + ".0"; let s = n.toString(); return s.indexOf(".") < 0 ? s + ".0" : s; }
function color(v: f64, high: f64, med: f64): string { return v > high ? "\x1b[31m" : v > med ? "\x1b[33m" : "\x1b[32m"; }
function padStart(s: string, w: i32): string { return s.length >= w ? s : repeat(" ", w - s.length) + s; }
function padEnd(s: string, w: i32): string { return s.length >= w ? s : s + repeat(" ", w - s.length); }
function padEndOrTrunc(s: string, w: i32): string { return s.length > w ? truncate(s, w - 1) : padEnd(s, w); }
function truncate(s: string, w: i32): string { return s.length <= w ? s : s.slice(0, w) + "…"; }
function repeat(s: string, n: i32): string { let out = ""; for (let i = 0; i < n; i++) out += s; return out; }
function has(a: string[], v: string): bool { for (let i = 0; i < a.length; i++) if (a[i] == v) return true; return false; }
function toInt(s: string): i32 { let out = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 48 || c > 57) break; out = out * 10 + c - 48; } return out; }
function extractArgs(json: string): string[] { const out = new Array<string>(); const start = json.indexOf("\"args\":"); if (start < 0) return out; let i = json.indexOf("[", start); while (i >= 0 && i < json.length && json.charAt(i) != "]") { if (json.charAt(i) == "\"") { const p = readJsonString(json, i); out.push(p.value); i = p.next; } else i++; } return out; }
function jsonObjectsInArray(json: string, key: string): string[] { const out = new Array<string>(); let i = json.indexOf("\"" + key + "\":"); if (i < 0) return out; i = json.indexOf("[", i); while (i >= 0 && i < json.length) { const ch = json.charAt(i); if (ch == "\"") i = readJsonString(json, i).next; else if (ch == "{") { const p = readJsonValue(json, i); out.push(p.value); i = p.next; } else if (ch == "]") break; else i++; } return out; }
function readJsonValueAtKey(json: string, key: string): string { const at = json.indexOf("\"" + key + "\":"); if (at < 0) return ""; let i = at + key.length + 3; while (i < json.length && json.charCodeAt(i) <= 32) i++; return readJsonValue(json, i).value; }
function readJsonValue(s: string, i: i32): Parsed { const p = new Parsed(); let depth = 0; const start = i; while (i < s.length) { const ch = s.charAt(i); if (ch == "\"") i = readJsonString(s, i).next; else { if (ch == "{" || ch == "[") depth++; else if (ch == "}" || ch == "]") { depth--; if (depth == 0) { i++; break; } } else if (ch == "," && depth == 0) break; i++; } } p.value = s.slice(start, i); p.next = i; return p; }
function jsonStringField(json: string, key: string): string { const at = json.indexOf("\"" + key + "\":"); if (at < 0) return ""; let i = at + key.length + 3; while (i < json.length && json.charAt(i) != "\"") i++; return i < json.length ? readJsonString(json, i).value : ""; }
function jsonNum(json: string, key: string): f64 { const at = json.indexOf("\"" + key + "\":"); if (at < 0) return 0; let i = at + key.length + 3; while (i < json.length && json.charCodeAt(i) <= 32) i++; const start = i; while (i < json.length) { const c = json.charCodeAt(i); if ((c < 48 || c > 57) && c != 46) break; i++; } return F64.parseFloat(json.slice(start, i)); }
function readJsonString(s: string, i: i32): Parsed { const p = new Parsed(); i++; while (i < s.length) { const ch = s.charAt(i); if (ch == "\\") { i++; if (i < s.length) { const e = s.charAt(i); p.value += e == "n" ? "\n" : e == "r" ? "\r" : e == "t" ? "\t" : e; } } else if (ch == "\"") { p.next = i + 1; return p; } else p.value += ch; i++; } p.next = i; return p; }
function quote(s: string): string { let out = "\""; for (let i = 0; i < s.length; i++) { const ch = s.charAt(i); const code = s.charCodeAt(i); if (ch == "\\") out += "\\\\"; else if (ch == "\"") out += "\\\""; else if (ch == "\n") out += "\\n"; else if (ch == "\r") out += "\\r"; else if (ch == "\t") out += "\\t"; else if (code < 32 || code > 126) out += "\\u" + hex4(code); else out += ch; } return out + "\""; }
function hex4(code: i32): string { const d = "0123456789abcdef"; return d.charAt((code >> 12) & 15) + d.charAt((code >> 8) & 15) + d.charAt((code >> 4) & 15) + d.charAt(code & 15); }
function finish(ok: bool, output: string, error: string): i32 { Host.outputString(ok ? "{\"ok\":true,\"output\":" + quote(output) + "}" : "{\"ok\":false,\"error\":" + quote(error) + "}"); return 0; }
