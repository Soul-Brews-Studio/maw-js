#![allow(clippy::missing_panics_doc)]

use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fmt::Write as _;

const USAGE: &str = "usage: maw-rs stream <session>:<win> [--into <session>] [--name <alias>] [--dry-run|--plan-json] | maw-rs stream --unlink <session>:<alias> [--dry-run|--plan-json]";
const PLACEHOLDER: &str = "maw-stream-placeholder";

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.tmux.list_sessions"]
    fn maw_tmux_list_sessions(input: u64) -> u64;
    #[link_name = "maw.tmux.command"]
    fn maw_tmux_command(input: u64) -> u64;
}

#[derive(Default, Deserialize)]
struct Context {
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Clone, Deserialize)]
struct Window {
    index: u32,
    name: String,
}

#[derive(Clone, Deserialize)]
struct Session {
    name: String,
    #[serde(default)]
    windows: Vec<Window>,
}

#[derive(Default)]
struct Options {
    into: Option<String>,
    name: Option<String>,
    unlink: bool,
    dry_run: bool,
    plan_json: bool,
}

struct Source {
    session: String,
    name: String,
    target: String,
}

struct Plan {
    source: Option<String>,
    into: String,
    name: String,
    target: String,
    created_destination: bool,
    renamed_shared_window: bool,
    unlinked: bool,
    commands: Vec<Vec<String>>,
}

fn host_call(function: unsafe extern "C" fn(u64) -> u64, input: String) -> Value {
    let Ok(memory) = Memory::from_bytes(input.as_bytes()) else {
        return Value::Null;
    };
    let offset = memory.offset();
    let output = unsafe { function(offset) };
    memory.free();
    Memory::find(output)
        .and_then(|memory| {
            let bytes = memory.to_vec();
            memory.free();
            serde_json::from_slice(&bytes).ok()
        })
        .unwrap_or(Value::Null)
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let context: Context = serde_json::from_str(&input).unwrap_or_default();
    Ok(match run(&context.args) {
        Ok(output) => json!({"ok": true, "output": output}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    })
}

fn run(args: &[String]) -> Result<String, String> {
    let (target, options) = parse_args(args)?;
    let plan = if options.unlink {
        unlink_plan(&target)?
    } else {
        link_plan(&target, &options)?
    };
    if options.plan_json {
        return Ok(render_plan_json(&plan));
    }
    if options.dry_run {
        return Ok(render_dry_run(&plan));
    }
    for command in &plan.commands {
        let (subcommand, args) = command
            .split_first()
            .expect("stream commands are non-empty");
        tmux_command(subcommand, args)
            .map_err(|error| format!("stream: tmux {subcommand} failed: {error}"))?;
    }
    Ok(format_result(&plan))
}

fn parse_args(args: &[String]) -> Result<(String, Options), String> {
    let mut options = Options::default();
    let mut target = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--help" | "-h" => return Err(USAGE.to_owned()),
            "--unlink" => options.unlink = true,
            "--dry-run" => options.dry_run = true,
            "--plan-json" => options.plan_json = true,
            "--into" | "--name" => {
                let flag = args[index].clone();
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("stream: missing {flag} value\n{USAGE}"))?
                    .clone();
                if flag == "--into" {
                    options.into = Some(value);
                } else {
                    options.name = Some(value);
                }
                index += 1;
            }
            argument if argument.starts_with("--into=") => {
                options.into = Some(argument[7..].to_owned());
            }
            argument if argument.starts_with("--name=") => {
                options.name = Some(argument[7..].to_owned());
            }
            argument if argument.starts_with('-') => {
                return Err(format!("stream: unknown argument {argument}\n{USAGE}"));
            }
            value if target.is_some() => {
                let _ = value;
                return Err(format!("stream: target already provided\n{USAGE}"));
            }
            value => target = Some(value.to_owned()),
        }
        index += 1;
    }
    target
        .map(|target| (target, options))
        .ok_or_else(|| USAGE.to_owned())
}

fn unlink_plan(target: &str) -> Result<Plan, String> {
    let (session, window) = parse_target(target).map_err(with_usage)?;
    let full_target = format!("{session}:{window}");
    Ok(Plan {
        source: None,
        into: session,
        name: window,
        target: full_target.clone(),
        created_destination: false,
        renamed_shared_window: false,
        unlinked: true,
        commands: vec![vec![
            "unlink-window".to_owned(),
            "-t".to_owned(),
            full_target,
        ]],
    })
}

fn link_plan(target: &str, options: &Options) -> Result<Plan, String> {
    let sessions = list_sessions()?;
    let source = resolve_source(&sessions, target)?;
    let destination = destination(options)?;
    if destination == source.session {
        return Err("stream: destination session must differ from source session".to_owned());
    }
    let alias = valid_name(
        "window alias",
        options.name.as_deref().unwrap_or(&source.name),
    )
    .map_err(with_usage)?;
    let destination_session = sessions.iter().find(|session| session.name == destination);
    if destination_session.is_none() && options.into.is_some() {
        return Err(format!(
            "stream: destination session '{destination}' not found"
        ));
    }
    let windows = destination_session.map_or(&[][..], |session| session.windows.as_slice());
    if windows.iter().any(|window| window.name == alias) {
        let hint = if options.name.is_some() {
            "choose a different --name"
        } else {
            "use --name <alias>"
        };
        return Err(format!(
            "stream: destination window '{destination}:{alias}' already exists; {hint}"
        ));
    }
    let base = tmux_command(
        "show-options",
        &[
            "-t".to_owned(),
            destination.clone(),
            "-gv".to_owned(),
            "base-index".to_owned(),
        ],
    )
    .ok()
    .and_then(|raw| raw.trim().parse::<u32>().ok())
    .unwrap_or(0);
    Ok(build_link_plan(
        source,
        &destination,
        &alias,
        destination_session.is_some(),
        windows,
        base,
    ))
}

fn build_link_plan(
    source: Source,
    destination: &str,
    alias: &str,
    exists: bool,
    windows: &[Window],
    base: u32,
) -> Plan {
    let used = windows
        .iter()
        .map(|window| window.index)
        .collect::<BTreeSet<_>>();
    let index = (base..10_000)
        .find(|index| !used.contains(index))
        .unwrap_or(base);
    let destination_index = format!("{destination}:{index}");
    let renamed = alias != source.name;
    let mut commands = Vec::new();
    if !exists {
        commands.push(strings(&[
            "new-session",
            "-d",
            "-s",
            destination,
            "-n",
            PLACEHOLDER,
        ]));
    }
    commands.push(vec![
        "link-window".to_owned(),
        "-d".to_owned(),
        "-s".to_owned(),
        source.target.clone(),
        "-t".to_owned(),
        destination_index.clone(),
    ]);
    if renamed {
        commands.push(vec![
            "rename-window".to_owned(),
            "-t".to_owned(),
            destination_index.clone(),
            alias.to_owned(),
        ]);
    }
    commands.push(vec![
        "set-window-option".to_owned(),
        "-t".to_owned(),
        destination_index,
        "@maw-linked-from".to_owned(),
        source.target.clone(),
    ]);
    if !exists {
        commands.push(vec![
            "kill-window".to_owned(),
            "-t".to_owned(),
            format!("{destination}:{PLACEHOLDER}"),
        ]);
    }
    Plan {
        source: Some(source.target),
        into: destination.to_owned(),
        name: alias.to_owned(),
        target: format!("{destination}:{alias}"),
        created_destination: !exists,
        renamed_shared_window: renamed,
        unlinked: false,
        commands,
    }
}

fn resolve_source(sessions: &[Session], target: &str) -> Result<Source, String> {
    let (session_name, window_name) = parse_target(target).map_err(with_usage)?;
    let windows = sessions
        .iter()
        .find(|session| session.name == session_name)
        .map(|session| session.windows.as_slice())
        .ok_or_else(|| format!("stream: source session '{session_name}' not found"))?;
    if window_name
        .chars()
        .all(|character| character.is_ascii_digit())
    {
        let index = window_name.parse::<u32>().unwrap_or(u32::MAX);
        let found = windows
            .iter()
            .find(|window| window.index == index)
            .ok_or_else(|| {
                format!("stream: source window '{session_name}:{window_name}' not found")
            })?;
        return Ok(Source {
            session: session_name.clone(),
            name: found.name.clone(),
            target: format!("{session_name}:{}", found.index),
        });
    }
    let exact = windows
        .iter()
        .filter(|window| window.name == window_name)
        .collect::<Vec<_>>();
    match exact.as_slice() {
        [found] => Ok(Source {
            session: session_name.clone(),
            name: found.name.clone(),
            target: format!("{session_name}:{}", found.index),
        }),
        [] => {
            let available = if windows.is_empty() {
                "(none)".to_owned()
            } else {
                windows
                    .iter()
                    .map(|window| format!("{}:{}", window.index, window.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            Err(format!(
                "stream: source window '{session_name}:{window_name}' not found; windows: {available}"
            ))
        }
        _ => Err(format!(
            "stream: source window '{session_name}:{window_name}' is ambiguous; use one of: {}",
            exact
                .iter()
                .map(|window| format!("{session_name}:{}", window.index))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn destination(options: &Options) -> Result<String, String> {
    if let Some(into) = options.into.as_deref() {
        return valid_name("destination session", into).map_err(with_usage);
    }
    let current = tmux_command(
        "display-message",
        &["-p".to_owned(), "#{session_name}".to_owned()],
    )
    .map_err(|error| format!("stream: --into is required outside tmux ({error})"))?;
    let current = current.trim();
    if current.is_empty() {
        Err("stream: --into is required outside tmux".to_owned())
    } else if current.ends_with("-view") {
        Ok(current.to_owned())
    } else {
        Ok(format!("{current}-view"))
    }
}

fn parse_target(target: &str) -> Result<(String, String), String> {
    let raw = target.trim();
    if raw.is_empty() || raw != target || raw.starts_with('-') || raw.chars().any(char::is_control)
    {
        return Err(USAGE.to_owned());
    }
    let (session, window) = raw
        .split_once(':')
        .ok_or_else(|| "stream: target must be <session>:<window>".to_owned())?;
    validate_part(session, "session")?;
    validate_part(window, "window")?;
    if window
        .rsplit_once('.')
        .is_some_and(|(_, pane)| pane.chars().all(|character| character.is_ascii_digit()))
    {
        return Err("stream: target must be a tmux window, not a pane".to_owned());
    }
    Ok((session.to_owned(), window.to_owned()))
}

fn valid_name(kind: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed != value
        || trimmed.starts_with('-')
        || trimmed.contains(':')
        || trimmed.chars().any(char::is_control)
    {
        return Err(format!(
            "stream: invalid {kind}: {}",
            if value.is_empty() { "(empty)" } else { value }
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_part(value: &str, kind: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        Err(format!("stream: invalid {kind}"))
    } else {
        Ok(())
    }
}

fn with_usage(error: String) -> String {
    if error == USAGE {
        error
    } else {
        format!("{error}\n{USAGE}")
    }
}

fn list_sessions() -> Result<Vec<Session>, String> {
    let response = host_call(maw_tmux_list_sessions, "{}".to_owned());
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(format!("stream: {}", host_error(&response)));
    }
    serde_json::from_value(
        response
            .get("value")
            .unwrap_or(&response)
            .get("sessions")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("stream: invalid tmux sessions response: {error}"))
}

fn tmux_command(subcommand: &str, args: &[String]) -> Result<String, String> {
    let response = host_call(
        maw_tmux_command,
        json!({"command": subcommand, "args": args}).to_string(),
    );
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(host_error(&response));
    }
    Ok(response
        .get("value")
        .unwrap_or(&response)
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned())
}

fn host_error(response: &Value) -> String {
    response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("tmux host call failed")
        .to_owned()
}

fn render_dry_run(plan: &Plan) -> String {
    let mut output = String::new();
    for command in &plan.commands {
        let _ = writeln!(output, "tmux {}", command.join(" "));
    }
    output
}

fn render_plan_json(plan: &Plan) -> String {
    format!(
        "{{\"command\":\"stream\",\"source\":{},\"into\":{},\"name\":{},\"target\":{},\"createdDestination\":{},\"renamedSharedWindow\":{},\"unlinked\":{},\"tmuxCommands\":{}}}\n",
        plan.source.as_ref().map_or("null".to_owned(), |source| json_string(source)),
        json_string(&plan.into),
        json_string(&plan.name),
        json_string(&plan.target),
        plan.created_destination,
        plan.renamed_shared_window,
        plan.unlinked,
        serde_json::to_string(&plan.commands).unwrap_or_else(|_| "[]".to_owned())
    )
}

fn format_result(plan: &Plan) -> String {
    if plan.unlinked {
        return format!("stream: unlinked {}\n", plan.target);
    }
    let created = if plan.created_destination {
        " (created destination)"
    } else {
        ""
    };
    let renamed = if plan.renamed_shared_window {
        " (renamed shared window)"
    } else {
        ""
    };
    format!(
        "stream: linked {} -> {}{created}{renamed}\n",
        plan.source.as_deref().unwrap_or(""),
        plan.target
    )
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlink_plan_matches_native_json() {
        let plan = unlink_plan("view:oracle").unwrap();
        assert_eq!(
            render_plan_json(&plan),
            "{\"command\":\"stream\",\"source\":null,\"into\":\"view\",\"name\":\"oracle\",\"target\":\"view:oracle\",\"createdDestination\":false,\"renamedSharedWindow\":false,\"unlinked\":true,\"tmuxCommands\":[[\"unlink-window\",\"-t\",\"view:oracle\"]]}\n"
        );
    }

    #[test]
    fn rejects_pane_targets() {
        assert!(parse_target("view:oracle.1").is_err());
    }

    #[test]
    fn link_plan_matches_native_command_vector() {
        let source = Source {
            session: "src".to_owned(),
            name: "work".to_owned(),
            target: "src:1".to_owned(),
        };
        let plan = build_link_plan(
            source,
            "dest",
            "alias",
            true,
            &[Window {
                index: 0,
                name: "home".to_owned(),
            }],
            0,
        );
        assert_eq!(
            format_result(&plan),
            "stream: linked src:1 -> dest:alias (renamed shared window)\n"
        );
        assert_eq!(plan.commands[0][0], "link-window");
        assert_eq!(plan.commands[1][0], "rename-window");
        assert_eq!(plan.commands[2][0], "set-window-option");
    }
}
