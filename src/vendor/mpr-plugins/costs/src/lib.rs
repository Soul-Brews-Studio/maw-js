#![allow(clippy::missing_panics_doc)]
use base64::Engine as _;
use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.paths.get"]
    fn maw_paths_get(input: u64) -> u64;
    #[link_name = "maw.fs.list"]
    fn maw_fs_list(input: u64) -> u64;
    #[link_name = "maw.fs.read"]
    fn maw_fs_read(input: u64) -> u64;
}

fn host_call(f: unsafe extern "C" fn(u64) -> u64, input: String) -> String {
    let Ok(mem) = Memory::from_bytes(input.as_bytes()) else {
        return String::new();
    };
    let offset = mem.offset();
    let out = unsafe { f(offset) };
    mem.free();
    Memory::find(out).map_or_else(String::new, |m| {
        let bytes = m.to_vec();
        m.free();
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

#[derive(Default, Clone)]
struct Usage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_create: u64,
    turns: u64,
    model: String,
    last: String,
}
#[derive(Default, Clone)]
struct Agent {
    name: String,
    tokens: u64,
    cost: f64,
    sessions: u64,
    turns: u64,
    last: String,
    daily: Vec<f64>,
    had: Vec<bool>,
}
#[derive(Deserialize)]
struct Ctx {
    args: Vec<String>,
    today: Option<String>,
    home: Option<String>,
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let ctx: Ctx = serde_json::from_str(&input).unwrap_or(Ctx {
        args: Vec::new(),
        today: None,
        home: None,
    });
    let (daily, days, as_json) = match parse_args(&ctx.args) {
        Ok(v) => v,
        Err(e) => return Ok(result(false, "", &e)),
    };
    let projects = projects_dir(ctx.home.as_deref());
    let agents = collect(&projects, daily, days, ctx.today.as_deref());
    let out = if daily {
        render_daily(&agents, days, as_json, ctx.today.as_deref())
    } else {
        render_summary(&agents)
    };
    Ok(result(true, &out, ""))
}

fn result(ok: bool, output: &str, error: &str) -> String {
    if ok {
        json!({"ok":true,"output":output}).to_string()
    } else {
        json!({"ok":false,"error":error}).to_string()
    }
}
fn usage() -> &'static str {
    "usage: maw-rs costs [--daily [N]|--days N] [--json]"
}
fn parse_args(args: &[String]) -> Result<(bool, usize, bool), String> {
    let (mut daily, mut days, mut js) = (false, 7, false);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => return Err(usage().to_owned()),
            "--json" | "-j" => js = true,
            "--daily" => {
                daily = true;
                if args.get(i + 1).is_some_and(|v| !v.starts_with('-')) {
                    days = parse_days(&args[i + 1])?;
                    i += 1;
                }
            }
            "--days" => {
                daily = true;
                let v = args
                    .get(i + 1)
                    .filter(|v| !v.starts_with('-'))
                    .ok_or("costs: missing --days value".to_owned())?;
                days = parse_days(v)?;
                i += 1;
            }
            x => return Err(format!("costs: unknown argument {x}\n{}", usage())),
        }
        i += 1;
    }
    Ok((daily, days, js))
}
fn parse_days(s: &str) -> Result<usize, String> {
    let Ok(n) = s.parse::<usize>() else {
        return Err("costs: days must be 1–365".to_owned());
    };
    if (1..=365).contains(&n) {
        Ok(n)
    } else {
        Err("costs: days must be 1–365".to_owned())
    }
}

fn projects_dir(home: Option<&str>) -> String {
    let r = host_call(maw_paths_get, json!({"name":"claude-projects"}).to_string());
    if ok(&r) {
        if let Some(p) = field(&r, "path") {
            return p;
        }
    }
    home.map_or(".".to_owned(), |h| format!("{h}/.claude/projects"))
}
fn ok(s: &str) -> bool {
    s.contains("\"ok\":true")
}
fn field(s: &str, k: &str) -> Option<String> {
    let v = serde_json::from_str::<Value>(s).ok()?;
    v.get(k)
        .or_else(|| v.get("value")?.get(k))?
        .as_str()
        .map(ToOwned::to_owned)
}
fn list(path: &str, kind: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut offset = 0;
    loop {
        let req = json!({
            "path": path,
            "recursive": false,
            "includeDirs": true,
            "maxEntries": 1000,
            "offset": offset
        });
        let r = host_call(maw_fs_list, req.to_string());
        let Ok(v) = serde_json::from_str::<Value>(&r) else {
            break;
        };
        let value = v.get("value").unwrap_or(&v);
        if let Some(a) = value.get("entries").and_then(Value::as_array) {
            for e in a {
                if e.get("kind").and_then(Value::as_str) == Some(kind) {
                    if let Some(p) = e.get("path").and_then(Value::as_str) {
                        out.push(p.to_owned());
                    }
                }
            }
        }
        let Some(next_offset) = value.get("nextOffset").and_then(Value::as_u64) else {
            break;
        };
        offset = next_offset;
    }
    out
}
fn read_bytes(path: &str, offset: u64) -> Option<(Vec<u8>, Option<u64>)> {
    let r = host_call(
        maw_fs_read,
        json!({"path":path,"encoding":"base64","maxBytes":10485760u64,"offset":offset}).to_string(),
    );
    let v = serde_json::from_str::<Value>(&r).ok()?;
    let value = v.get("value").unwrap_or(&v);
    let content = value.get("content").and_then(Value::as_str)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .ok()?;
    let next = value.get("nextOffset").and_then(Value::as_u64);
    Some((bytes, next))
}

fn collect(projects: &str, daily: bool, days: usize, today: Option<&str>) -> Vec<Agent> {
    let buckets = make_buckets(days, today);
    let mut map: BTreeMap<String, Agent> = BTreeMap::new();
    for dir in list(projects, "dir") {
        let files = list(&dir, "file");
        if files.is_empty() {
            continue;
        }
        let name = agent_name(base(&dir));
        let e = map.entry(name.clone()).or_insert_with(|| Agent {
            name,
            daily: vec![0.0; days],
            had: vec![false; days],
            ..Agent::default()
        });
        for f in files {
            if !f.ends_with(".jsonl") {
                continue;
            }
            let u = scan_file(&f);
            if u.turns == 0 {
                continue;
            }
            let cost = estimate(&u);
            if daily {
                if let Some(idx) = buckets
                    .iter()
                    .position(|b| *b == u.last.chars().take(10).collect::<String>())
                {
                    e.daily[idx] += cost;
                    e.cost += cost;
                    e.had[idx] = true
                }
            } else {
                e.tokens += u.input + u.output + u.cache_read + u.cache_create;
                e.cost += cost;
                e.sessions += 1;
                e.turns += u.turns;
                if u.last > e.last {
                    e.last = u.last
                }
            }
        }
    }
    let mut v = map
        .into_values()
        .filter(|a| if daily { a.cost > 0.0 } else { a.sessions > 0 })
        .collect::<Vec<_>>();
    v.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    v
}
fn scan_file(path: &str) -> Usage {
    let mut u = Usage::default();
    let mut carry = Vec::new();
    let mut offset = 0;
    while let Some((mut bytes, next)) = read_bytes(path, offset) {
        carry.append(&mut bytes);
        let mut start = 0;
        for idx in 0..carry.len() {
            if carry[idx] == b'\n' {
                scan_line(&mut u, &String::from_utf8_lossy(&carry[start..idx]));
                start = idx + 1;
            }
        }
        carry = carry[start..].to_vec();
        let Some(next_offset) = next else { break };
        offset = next_offset;
    }
    if !carry.is_empty() {
        scan_line(&mut u, &String::from_utf8_lossy(&carry));
    }
    u
}
fn scan_line(u: &mut Usage, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let Some(message) = value.get("message") else {
        return;
    };
    let Some(usage) = message.get("usage") else {
        return;
    };
    u.input += usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    u.output += usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    u.cache_read += usage
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    u.cache_create += usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    u.turns += 1;
    if u.model.is_empty() {
        if let Some(model) = message.get("model").and_then(Value::as_str) {
            model.clone_into(&mut u.model);
        }
    }
    if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
        timestamp.clone_into(&mut u.last);
    }
}

fn estimate(u: &Usage) -> f64 {
    let (ir, or) = match tier(&u.model) {
        "opus" => (15.0, 75.0),
        "haiku" => (0.25, 1.25),
        _ => (3.0, 15.0),
    };
    ((u.input + u.cache_read + u.cache_create) as f64 / 1_000_000.0) * ir
        + (u.output as f64 / 1_000_000.0) * or
}
fn tier(m: &str) -> &'static str {
    if m.contains("opus") {
        "opus"
    } else if m.contains("haiku") {
        "haiku"
    } else {
        "sonnet"
    }
}
fn agent_name(dir: &str) -> String {
    let t = dir.strip_prefix('-').unwrap_or(dir);
    let p = t.split('-').collect::<Vec<_>>();
    if let Some(i) = p.iter().position(|x| *x == "github") {
        if p.get(i + 1) == Some(&"com") && p.len() > i + 3 {
            return p[i + 2..].join("-");
        }
    }
    if p.len() >= 2 {
        p[p.len() - 2..].join("-")
    } else {
        t.to_owned()
    }
}
fn base(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn render_summary(a: &[Agent]) -> String {
    if a.is_empty() {
        return "\x1b[90mno session data found\x1b[0m\n".to_owned();
    }
    let (sess, tok, cost) = (
        a.iter().map(|x| x.sessions).sum::<u64>(),
        a.iter().map(|x| x.tokens).sum::<u64>(),
        a.iter().map(|x| x.cost).sum::<f64>(),
    );
    let hdr = format!(
        "{}  {}  {}  {}  {}  {}",
        pad_e("Agent", 30),
        pad_s("Tokens", 14),
        pad_s("Est. Cost", 12),
        pad_s("Sessions", 10),
        pad_s("Turns", 8),
        pad_s("Last Active", 13)
    );
    let mut o=format!("\n\x1b[36mCOST TRACKING\x1b[0m  ({} agents, {sess} sessions)\n\n  \x1b[90m{hdr}\x1b[0m\n  \x1b[90m{}\x1b[0m\n",a.len(),"─".repeat(hdr.chars().count()));
    for x in a {
        let last = if x.last.is_empty() {
            "—".to_owned()
        } else {
            x.last.chars().take(10).collect()
        };
        o.push_str(&format!(
            "  {}  {}  {}{}\x1b[0m  {}  {}  {}\n",
            pad_e(&trunc(&x.name, 28), 30),
            pad_s(&fmt_num(tokf(x.tokens)), 14),
            color(x.cost, 10.0, 1.0),
            pad_s(&format!("${:.2}", x.cost), 12),
            pad_s(&x.sessions.to_string(), 10),
            pad_s(&x.turns.to_string(), 8),
            pad_s(&last, 13)
        ))
    }
    o.push_str(&format!(
        "  \x1b[90m{}\x1b[0m\n  {}  {}  {}{}\x1b[0m  {}\n\n",
        "─".repeat(hdr.chars().count()),
        pad_e("TOTAL", 30),
        pad_s(&fmt_num(tokf(tok)), 14),
        color(cost, 50.0, 10.0),
        pad_s(&format!("${cost:.2}"), 12),
        pad_s(&sess.to_string(), 10)
    ));
    o
}
fn render_daily(a: &[Agent], days: usize, json_out: bool, today: Option<&str>) -> String {
    let b = make_buckets(days, today);
    let total = a.iter().map(|x| x.cost).sum::<f64>();
    if json_out {
        return serde_json::to_string_pretty(&json!({"window":days,"buckets":b,"agents":a.iter().map(|x|json!({"name":x.name,"dailyCosts":x.daily,"totalCost":x.cost,"hadActivity":x.had})).collect::<Vec<_>>(),"total":{"cost":total,"agents":a.len()}})).unwrap()+"\n";
    }
    if a.is_empty() {
        return format!("\x1b[90mno activity in the last {days} days\x1b[0m\n");
    }
    let nw = 28;
    let mut o = format!(
        "\n\x1b[36mDAILY COSTS\x1b[0m  ({days}d ending {})\n\n",
        b.last().cloned().unwrap_or_default()
    );
    for x in a {
        o.push_str(&format!(
            "  {}  {}  ${:.2}\n",
            pad_e(
                &if x.name.chars().count() > nw {
                    trunc(&x.name, nw - 1)
                } else {
                    x.name.clone()
                },
                nw
            ),
            spark(&x.daily, &x.had),
            x.cost
        ))
    }
    let totals = (0..days)
        .map(|i| a.iter().map(|x| x.daily[i]).sum::<f64>())
        .collect::<Vec<_>>();
    let had = totals.iter().map(|v| *v > 0.0).collect::<Vec<_>>();
    o.push_str(&format!(
        "  {}\n  {}  {}  ${:.2}\n\n",
        "─".repeat(nw + 2 + days + 4),
        pad_e("TOTAL", nw),
        spark(&totals, &had),
        total
    ));
    o
}
fn make_buckets(days: usize, today: Option<&str>) -> Vec<String> {
    let t = today.filter(|v| v.len() >= 10).unwrap_or("2026-06-25");
    let (y, m, d) = (
        t[0..4].parse().unwrap_or(1970),
        t[5..7].parse().unwrap_or(1),
        t[8..10].parse().unwrap_or(1),
    );
    let td = days_from_civil(y, m, d);
    (0..days)
        .map(|i| civil(td - (days - 1 - i) as i64))
        .collect()
}
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = i64::from(m);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
fn civil(z: i64) -> String {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    format!("{:04}-{:02}-{:02}", y + i64::from(m <= 2), m, d)
}
fn spark(v: &[f64], h: &[bool]) -> String {
    let b = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let max = v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    v.iter()
        .enumerate()
        .map(|(i, x)| {
            if !h.get(i).copied().unwrap_or(false) {
                '░'
            } else if max == 0.0 {
                '▁'
            } else {
                b[((x / max) * 7.0).round() as usize + 1]
            }
        })
        .collect()
}
fn tokf(n: u64) -> f64 {
    n as f64
}
fn fmt_num(n: f64) -> String {
    if n >= 1e9 {
        format!("{:.1}B", n / 1e9)
    } else if n >= 1e6 {
        format!("{:.1}M", n / 1e6)
    } else if n >= 1e3 {
        format!("{:.1}K", n / 1e3)
    } else {
        format!("{}", n as u64)
    }
}
fn pad_s(s: &str, w: usize) -> String {
    let l = s.chars().count();
    if l >= w {
        s.to_owned()
    } else {
        format!("{}{}", " ".repeat(w - l), s)
    }
}
fn pad_e(s: &str, w: usize) -> String {
    let l = s.chars().count();
    if l >= w {
        s.to_owned()
    } else {
        format!("{}{}", s, " ".repeat(w - l))
    }
}
fn trunc(s: &str, w: usize) -> String {
    if s.chars().count() <= w {
        s.to_owned()
    } else {
        format!("{}…", s.chars().take(w).collect::<String>())
    }
}
fn color(v: f64, h: f64, m: f64) -> &'static str {
    if v > h {
        "\x1b[31m"
    } else if v > m {
        "\x1b[33m"
    } else {
        "\x1b[32m"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_line_uses_outer_type_and_message_usage() {
        let mut usage = Usage::default();
        scan_line(
            &mut usage,
            r#"{"message":{"model":"claude-opus-4","type":"message","usage":{"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":7}},"type":"assistant","timestamp":"2026-07-11T00:00:00Z"}"#,
        );

        assert_eq!(usage.input, 2);
        assert_eq!(usage.output, 3);
        assert_eq!(usage.cache_read, 5);
        assert_eq!(usage.cache_create, 7);
        assert_eq!(usage.turns, 1);
        assert_eq!(usage.model, "claude-opus-4");
        assert_eq!(usage.last, "2026-07-11T00:00:00Z");
    }
}
