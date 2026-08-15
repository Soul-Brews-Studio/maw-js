#![allow(clippy::missing_panics_doc)]
use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};

const USAGE: &str =
    "usage: maw follow <pane> [--since=<dur>] [--json] [--grep <pattern>] [--quit-on-idle=<dur>]";

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.tmux.list_sessions"]
    fn maw_tmux_list_sessions(input: u64) -> u64;
    #[link_name = "maw.tmux.capture"]
    fn maw_tmux_capture(input: u64) -> u64;
}

fn host_call(f: unsafe extern "C" fn(u64) -> u64, input: String) -> Value {
    let Ok(mem) = Memory::from_bytes(input.as_bytes()) else {
        return Value::Null;
    };
    let offset = mem.offset();
    let out = unsafe { f(offset) };
    mem.free();
    Memory::find(out)
        .and_then(|m| {
            let bytes = m.to_vec();
            m.free();
            serde_json::from_slice(&bytes).ok()
        })
        .unwrap_or(Value::Null)
}

fn host_value(value: &Value) -> &Value {
    value.get("value").unwrap_or(value)
}

#[derive(Default, Deserialize)]
struct Context {
    args: Vec<String>,
}

#[derive(Default)]
struct Options {
    target: String,
    since: Option<String>,
    json: bool,
    grep: Option<String>,
    quit_on_idle: Option<String>,
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let ctx = serde_json::from_str::<Context>(&input).unwrap_or_default();
    Ok(match run(&ctx.args) {
        Ok(output) => json!({"ok":true,"output":output}),
        Err(error) => json!({"ok":false,"error":error}),
    }
    .to_string())
}

fn run(args: &[String]) -> Result<String, String> {
    let options = parse(args)?;
    let pane = resolve_target(&options.target)?;
    let lines = options
        .since
        .as_deref()
        .and_then(parse_duration_ms)
        .map_or(80, replay_lines_for_duration);
    let response = host_call(
        maw_tmux_capture,
        json!({
            "target": pane,
            "lines": lines,
            "stripAnsi": false
        })
        .to_string(),
    );
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(response
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("follow: tmux capture failed")
            .to_owned());
    }
    let content = host_value(&response)
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if options
        .grep
        .as_ref()
        .is_some_and(|pattern| !content.contains(pattern))
    {
        return Ok(String::new());
    }
    if options.json {
        Ok(format!(
            "{}\n",
            json!({"ts":"0","pane":pane,"chunk":content})
        ))
    } else {
        Ok(content.to_owned())
    }
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
        match token.as_str() {
            "--help" | "-h" => return Err(USAGE.to_owned()),
            "--json" => {
                options.json = true;
                index += 1;
            }
            "--since" => options.since = Some(take_value(args, &mut index, "--since")?),
            "--grep" => options.grep = Some(take_value(args, &mut index, "--grep")?),
            "--quit-on-idle" => {
                options.quit_on_idle = Some(take_value(args, &mut index, "--quit-on-idle")?)
            }
            _ if token.starts_with("--since=") => {
                options.since = Some(inline_value(token, "--since=")?);
                index += 1;
            }
            _ if token.starts_with("--grep=") => {
                options.grep = Some(inline_value(token, "--grep=")?);
                index += 1;
            }
            _ if token.starts_with("--quit-on-idle=") => {
                options.quit_on_idle = Some(inline_value(token, "--quit-on-idle=")?);
                index += 1;
            }
            "--" => {
                index += 1;
                while index < args.len() {
                    set_target(&mut options, &args[index])?;
                    index += 1;
                }
            }
            _ if token.starts_with('-') => return Err(USAGE.to_owned()),
            _ => {
                set_target(&mut options, token)?;
                index += 1;
            }
        }
    }
    if options.target.is_empty() {
        return Err(USAGE.to_owned());
    }
    validate_target(&options.target)?;
    if let Some(since) = &options.since {
        if parse_duration_ms(since).is_none() {
            return Err(format!("follow: invalid --since duration: {since}"));
        }
    }
    if let Some(idle) = &options.quit_on_idle {
        if parse_duration_ms(idle).is_none_or(|ms| ms == 0) {
            return Err(format!("follow: invalid --quit-on-idle duration: {idle}"));
        }
    }
    if options.grep.as_ref().is_some_and(|pattern| {
        pattern.is_empty() || pattern.starts_with('-') || pattern.chars().any(char::is_control)
    }) {
        return Err("follow: invalid --grep pattern".to_owned());
    }
    Ok(options)
}

fn take_value(args: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    *index += 1;
    let value = args.get(*index).ok_or_else(|| USAGE.to_owned())?;
    let value = validate_value(flag, value)?;
    *index += 1;
    Ok(value)
}

fn inline_value(token: &str, prefix: &str) -> Result<String, String> {
    validate_value(prefix.trim_end_matches('='), &token[prefix.len()..])
}

fn set_target(options: &mut Options, target: &str) -> Result<(), String> {
    if !options.target.is_empty() {
        return Err(USAGE.to_owned());
    }
    options.target = validate_value("target", target)?;
    Ok(())
}

fn validate_value(label: &str, value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.trim() != value
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        return Err(format!("follow: invalid {label} value"));
    }
    Ok(value.to_owned())
}

fn validate_target(target: &str) -> Result<(), String> {
    if !target
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '%' | '-'))
    {
        return Err("follow: tmux target contains unsupported characters".to_owned());
    }
    if target.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(
            "follow: bare numeric tmux targets are refused; use session:window or %pane_id"
                .to_owned(),
        );
    }
    Ok(())
}

fn resolve_target(target: &str) -> Result<String, String> {
    if target.contains(':') || target.starts_with('%') {
        return Ok(target.to_owned());
    }
    let response = host_call(maw_tmux_list_sessions, "{}".to_owned());
    let sessions = host_value(&response)
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let matches = sessions
        .iter()
        .filter(|session| session.get("name").and_then(Value::as_str) == Some(target))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Err(format!("follow: session '{target}' not found")),
        [session] => {
            let window = session
                .get("windows")
                .and_then(Value::as_array)
                .and_then(|windows| windows.first())
                .and_then(|window| window.get("name"))
                .and_then(Value::as_str);
            Ok(window.map_or_else(|| target.to_owned(), |window| format!("{target}:{window}")))
        }
        _ => Err(format!("follow: '{target}' is ambiguous")),
    }
}

fn parse_duration_ms(raw: &str) -> Option<u64> {
    if raw.is_empty() || raw.trim() != raw {
        return None;
    }
    if raw.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
        return float_ms(raw, 1_000.0);
    }
    let mut total = 0u64;
    let mut cursor = 0;
    while cursor < raw.len() {
        let start = cursor;
        while cursor < raw.len()
            && (raw.as_bytes()[cursor].is_ascii_digit() || raw.as_bytes()[cursor] == b'.')
        {
            cursor += 1;
        }
        if cursor == start {
            return None;
        }
        let unit_start = cursor;
        while cursor < raw.len() && raw.as_bytes()[cursor].is_ascii_alphabetic() {
            cursor += 1;
        }
        let multiplier = match &raw[unit_start..cursor] {
            "ms" => 1.0,
            "s" => 1_000.0,
            "m" => 60_000.0,
            "h" => 3_600_000.0,
            "d" => 86_400_000.0,
            _ => return None,
        };
        total = total.checked_add(float_ms(&raw[start..unit_start], multiplier)?)?;
    }
    Some(total)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
fn float_ms(number: &str, multiplier: f64) -> Option<u64> {
    let value = number.parse::<f64>().ok()?;
    let millis = (value * multiplier).round();
    (value.is_finite() && value >= 0.0 && millis <= u64::MAX as f64).then_some(millis as u64)
}

fn replay_lines_for_duration(ms: u64) -> u32 {
    u32::try_from(ms.div_ceil(1_000).clamp(1, 10_000)).unwrap_or(10_000)
}
