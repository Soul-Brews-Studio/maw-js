#![allow(clippy::missing_panics_doc)]

use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fmt::Write as _;

const HELP: &str = "usage: maw avengers [status|best|traffic|health] — ARRA-01 rate limit monitor\n\n  maw avengers status    All accounts + rate limits\n  maw avengers best      Account with most capacity\n  maw avengers traffic   Traffic stats\n  maw avengers health    Quick connectivity check\n";
const MISSING_CONFIG: &str =
    "Avengers not configured. Add to maw.config.json:\n  \"avengers\": \"http://white.local:8090\"";

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.config.get"]
    fn maw_config_get(input: u64) -> u64;
    #[link_name = "maw.net.fetch"]
    fn maw_net_fetch(input: u64) -> u64;
}

fn host_call(function: unsafe extern "C" fn(u64) -> u64, input: String) -> String {
    let Ok(memory) = Memory::from_bytes(input.as_bytes()) else {
        return String::new();
    };
    let offset = memory.offset();
    let output = unsafe { function(offset) };
    memory.free();
    Memory::find(output).map_or_else(String::new, |memory| {
        let bytes = memory.to_vec();
        memory.free();
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

#[derive(Deserialize)]
struct Context {
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Status,
    Best,
    Traffic,
    Health,
    Help,
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let context = serde_json::from_str::<Context>(&input).unwrap_or(Context { args: Vec::new() });
    Ok(match run(&context.args) {
        Ok(output) => json!({"ok": true, "output": output}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    })
}

fn run(args: &[String]) -> Result<String, String> {
    let command = parse_args(args)?;
    if command == Command::Help {
        return Ok(HELP.to_owned());
    }
    let base = config_url().ok_or_else(|| MISSING_CONFIG.to_owned())?;
    match command {
        Command::Status => show_status(&base),
        Command::Best => show_json("/best", 5_000, "Best Account"),
        Command::Traffic => show_json("/traffic-stats", 5_000, "Traffic Stats"),
        Command::Health => Ok(show_health(&base)),
        Command::Help => unreachable!(),
    }
}

fn parse_args(args: &[String]) -> Result<Command, String> {
    let mut positionals = Vec::new();
    let mut tail = false;
    for arg in args {
        if !tail && arg == "--" {
            tail = true;
            continue;
        }
        if !tail && matches!(arg.as_str(), "--help" | "-h") {
            return Ok(Command::Help);
        }
        if arg.starts_with('-') {
            return if tail {
                Err("avengers: subcommand value must not start with '-'".to_owned())
            } else {
                Err(format!("avengers: unknown argument {arg}"))
            };
        }
        validate(arg)?;
        positionals.push(arg.as_str());
    }
    if positionals.len() > 1 {
        return Err("avengers: expected at most one subcommand".to_owned());
    }
    Ok(match positionals.first().copied().unwrap_or("status") {
        "status" | "all" => Command::Status,
        "best" => Command::Best,
        "traffic" => Command::Traffic,
        "health" => Command::Health,
        _ => Command::Help,
    })
}

fn validate(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("avengers: empty value for subcommand".to_owned());
    }
    if value.bytes().any(|byte| matches!(byte, 0 | b'\n' | b'\r')) {
        return Err("avengers: invalid control character in subcommand".to_owned());
    }
    Ok(())
}

fn config_url() -> Option<String> {
    let response = host_call(maw_config_get, json!({"key": "avengers"}).to_string());
    serde_json::from_str::<Value>(&response)
        .ok()?
        .pointer("/value/value")?
        .as_str()
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn fetch(path: &str, timeout_ms: u64) -> Result<(u16, Value, u64), String> {
    let response = host_call(
        maw_net_fetch,
        json!({"endpoint": "avengers", "method": "GET", "path": path, "timeoutMs": timeout_ms})
            .to_string(),
    );
    let envelope = serde_json::from_str::<Value>(&response).map_err(|error| error.to_string())?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(envelope
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("maw.net.fetch failed")
            .to_owned());
    }
    let value = envelope
        .get("value")
        .ok_or_else(|| "maw.net.fetch returned no value".to_owned())?;
    let status = value
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| "maw.net.fetch returned no status".to_owned())?;
    let body = value
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| "maw.net.fetch returned no body".to_owned())?;
    let json = serde_json::from_str(body).map_err(|error| error.to_string())?;
    let elapsed_ms = value.get("elapsedMs").and_then(Value::as_u64).unwrap_or(0);
    Ok((status, json, elapsed_ms))
}

fn show_status(base: &str) -> Result<String, String> {
    match fetch("/all", 5_000) {
        Ok((status, accounts, _)) if (200..300).contains(&status) => {
            Ok(render_status(base, &accounts))
        }
        Ok((status, _, _)) => Err(format!(
            "\x1b[31merror\x1b[0m: avengers unreachable at {base}: HTTP {status}"
        )),
        Err(error) => Err(format!(
            "\x1b[31merror\x1b[0m: avengers unreachable at {base}: {error}"
        )),
    }
}

fn show_json(path: &str, timeout_ms: u64, title: &str) -> Result<String, String> {
    match fetch(path, timeout_ms) {
        Ok((status, value, _)) if (200..300).contains(&status) => {
            Ok(render_json_section(title, &value))
        }
        Ok((status, _, _)) => Err(format!("\x1b[31merror\x1b[0m: HTTP {status}")),
        Err(error) => Err(format!("\x1b[31merror\x1b[0m: {error}")),
    }
}

fn show_health(base: &str) -> String {
    match fetch("/all", 3_000) {
        Ok((status, accounts, elapsed_ms)) if (200..300).contains(&status) => {
            let count = accounts.as_array().map_or(0, Vec::len);
            let plural = if count == 1 { "" } else { "s" };
            format!("\n\x1b[32m●\x1b[0m  Avengers \x1b[32monline\x1b[0m  \x1b[90m{elapsed_ms}ms · {count} account{plural}\x1b[0m\n   \x1b[90m{base}\x1b[0m\n\n")
        }
        _ => format!("\n\x1b[31m●\x1b[0m  Avengers \x1b[31moffline\x1b[0m  \x1b[90m0ms\x1b[0m\n   \x1b[90m{base}\x1b[0m\n\n"),
    }
}

fn render_status(base: &str, accounts: &Value) -> String {
    let mut output = format!("\n\x1b[36;1mAvengers Status\x1b[0m  \x1b[90m{base}\x1b[0m\n\n");
    if let Some(accounts) = accounts.as_array() {
        for account in accounts {
            render_account(account, &mut output);
        }
    } else if let Ok(pretty) = serde_json::to_string_pretty(accounts) {
        output.push_str(&pretty);
        output.push('\n');
    }
    output.push('\n');
    output
}

fn render_account(account: &Value, output: &mut String) {
    let name = ["name", "email", "id"]
        .iter()
        .find_map(|key| account.get(*key).and_then(Value::as_str))
        .unwrap_or("?");
    let remaining = number_field(account, &["remaining", "requests_remaining"]);
    let limit = number_field(account, &["limit", "requests_limit"]);
    let percent = remaining.zip(limit).and_then(|(remaining, limit)| {
        (limit > 0).then(|| {
            ((i128::from(remaining) * 100 + i128::from(limit) / 2).div_euclid(i128::from(limit)))
                .try_into()
                .unwrap_or(i64::MAX)
        })
    });
    let color = match percent {
        Some(value) if value > 50 => "\x1b[32m",
        Some(value) if value > 20 => "\x1b[33m",
        Some(_) => "\x1b[31m",
        None => "\x1b[37m",
    };
    let capacity = match (remaining, limit, percent) {
        (Some(remaining), Some(limit), Some(percent)) => {
            format!("{color}{remaining}/{limit} ({percent}%)\x1b[0m")
        }
        (Some(remaining), _, _) => remaining.to_string(),
        _ => "?".to_owned(),
    };
    let name = name.chars().take(30).collect::<String>();
    let _ = writeln!(output, "  {color}●\x1b[0m  {name:<30}  {capacity}");
}

fn number_field(account: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| account.get(*key).and_then(Value::as_i64))
}

fn render_json_section(title: &str, value: &Value) -> String {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_owned());
    format!("\n\x1b[36;1m{title}\x1b[0m\n\n  {pretty}\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn argument_and_rendering_contract_matches_native() {
        assert!(matches!(parse_args(&args(&[])), Ok(Command::Status)));
        assert!(matches!(parse_args(&args(&["all"])), Ok(Command::Status)));
        assert!(matches!(parse_args(&args(&["--help"])), Ok(Command::Help)));
        assert!(parse_args(&args(&["--bad"]))
            .expect_err("bad flag")
            .contains("unknown argument"));

        let accounts = json!([
            {"name":"alpha","remaining":80,"limit":100},
            {"email":"beta@example.test","requests_remaining":10,"requests_limit":100}
        ]);
        let output = render_status("http://avengers", &accounts);
        assert!(output.contains("80/100 (80%)"));
        assert!(output.contains("10/100 (10%)"));
        assert!(
            render_json_section("Best Account", &json!({"remaining":42}))
                .contains("\"remaining\": 42")
        );
    }
}
