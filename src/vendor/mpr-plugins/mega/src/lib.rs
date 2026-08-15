#![allow(clippy::missing_panics_doc)]

use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

const WINDOW_FORMAT: &str = "#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}";

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.paths.get"]
    fn maw_paths_get(input: u64) -> u64;
    #[link_name = "maw.fs.list"]
    fn maw_fs_list(input: u64) -> u64;
    #[link_name = "maw.fs.read"]
    fn maw_fs_read(input: u64) -> u64;
    #[link_name = "maw.tmux.command"]
    fn maw_tmux_command(input: u64) -> u64;
}

#[derive(Default, Deserialize)]
struct Context {
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Clone, Default, Deserialize)]
struct FleetSession {
    name: String,
    #[serde(default)]
    windows: Vec<FleetWindow>,
}

#[derive(Clone, Default, Deserialize)]
struct FleetWindow {
    #[serde(default)]
    name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Subcommand {
    Help,
    Ls,
    Status,
    Stop,
    Kill,
    Tree,
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    subcommand: Subcommand,
    team_lead: bool,
    yes: bool,
    targets: Vec<String>,
}

struct Window {
    index: i32,
    name: String,
    active: bool,
    panes: i32,
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

fn host_value(value: &Value) -> &Value {
    value.get("value").unwrap_or(value)
}

fn host_path(name: &str) -> Option<PathBuf> {
    let response = host_call(maw_paths_get, json!({"name": name}).to_string());
    host_value(&response)
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
}

fn list(path: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut offset = 0_u64;
    loop {
        let response = host_call(
            maw_fs_list,
            json!({
                "path": path, "recursive": recursive, "includeDirs": false,
                "maxEntries": 1000, "offset": offset
            })
            .to_string(),
        );
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            break;
        }
        let value = host_value(&response);
        if let Some(entries) = value.get("entries").and_then(Value::as_array) {
            files.extend(entries.iter().filter_map(|entry| {
                if entry.get("kind")?.as_str()? != "file" {
                    return None;
                }
                entry.get("path")?.as_str().map(PathBuf::from)
            }));
        }
        let Some(next) = value.get("nextOffset").and_then(Value::as_u64) else {
            break;
        };
        offset = next;
    }
    files
}

fn read(path: &Path) -> Option<String> {
    let response = host_call(
        maw_fs_read,
        json!({"path": path, "encoding": "utf8"}).to_string(),
    );
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    host_value(&response)
        .get("content")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn load_fleet() -> Vec<FleetSession> {
    let mut fleet = Vec::new();
    let mut seen_prior_roots = BTreeSet::new();
    for root_name in ["fleet-state", "fleet-legacy", "fleet-config"] {
        let Some(root) = host_path(root_name) else {
            continue;
        };
        let mut files = list(&root, false)
            .into_iter()
            .filter(|path| path.extension().and_then(std::ffi::OsStr::to_str) == Some("json"))
            .collect::<Vec<_>>();
        files.extend(
            list(&root.join("squads"), true)
                .into_iter()
                .filter(|path| path.ends_with("squad.json")),
        );
        files.sort();
        let mut seen_this_root = BTreeSet::new();
        for file in files {
            let Some(text) = read(&file) else { continue };
            let Ok(session) = serde_json::from_str::<FleetSession>(&text) else {
                continue;
            };
            if !session.name.is_empty() && !seen_prior_roots.contains(&session.name) {
                seen_this_root.insert(session.name.clone());
                fleet.push(session);
            }
        }
        seen_prior_roots.extend(seen_this_root);
    }
    fleet
}

fn tmux(command: &str, args: &[String]) -> Result<String, String> {
    let response = host_call(
        maw_tmux_command,
        json!({"command": command, "args": args}).to_string(),
    );
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("tmux host call failed")
            .to_owned());
    }
    Ok(host_value(&response)
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned())
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let context = serde_json::from_str::<Context>(&input).unwrap_or_default();
    Ok(match run(&context.args) {
        Ok(output) => json!({"ok": true, "output": output}),
        Err(error) => json!({"ok": false, "error": error}),
    }
    .to_string())
}

fn run(args: &[String]) -> Result<String, String> {
    let options = parse_args(args)?;
    if options.subcommand == Subcommand::Help {
        return Ok(usage());
    }
    if matches!(options.subcommand, Subcommand::Stop | Subcommand::Kill) && !options.yes {
        let verb = if options.subcommand == Subcommand::Stop {
            "stop"
        } else {
            "kill"
        };
        return Err(format!("mega: refusing to {verb} sessions without --yes"));
    }
    let fleet = target_sessions(load_fleet(), &options);
    match options.subcommand {
        Subcommand::Help => Ok(usage()),
        Subcommand::Ls => Ok(render_ls(&fleet)),
        Subcommand::Status => render_status(&fleet),
        Subcommand::Tree => render_tree(&fleet),
        Subcommand::Stop => stop_or_kill(&fleet, &options, "stop"),
        Subcommand::Kill => stop_or_kill(&fleet, &options, "kill"),
    }
}

fn usage() -> String {
    concat!(
        "usage: maw mega <ls|status|stop|kill|tree> [--team-lead] [--yes] [target...]\n\n",
        "Native mega overview/control for fleet tmux sessions.\n\nSubcommands:\n",
        "  ls                  list configured fleet sessions\n",
        "  status              show live tmux status for targets\n",
        "  tree                show session → window tree\n",
        "  stop                stop target sessions (requires --yes)\n",
        "  kill                alias for stop/kill-session (requires --yes)\n\n",
        "Team-lead variants: add --team-lead/--lead or prefix with team-lead.\n"
    )
    .to_owned()
}

fn parse_args(args: &[String]) -> Result<Options, String> {
    let mut subcommand = None;
    let mut team_lead = false;
    let mut yes = false;
    let mut targets = Vec::new();
    for arg in args {
        match arg.as_str() {
            "--help" | "-h" | "help" => subcommand = Some(Subcommand::Help),
            "ls" | "list" => subcommand = Some(Subcommand::Ls),
            "status" | "stat" => subcommand = Some(Subcommand::Status),
            "tree" => subcommand = Some(Subcommand::Tree),
            "stop" => subcommand = Some(Subcommand::Stop),
            "kill" => subcommand = Some(Subcommand::Kill),
            "team-lead" | "teamlead" | "lead" | "tl" | "--team-lead" | "--teamlead" | "--lead" => {
                team_lead = true
            }
            "team-lead-ls" | "lead-ls" | "tl-ls" => {
                team_lead = true;
                subcommand = Some(Subcommand::Ls);
            }
            "team-lead-status" | "lead-status" | "tl-status" => {
                team_lead = true;
                subcommand = Some(Subcommand::Status);
            }
            "team-lead-stop" | "lead-stop" | "tl-stop" => {
                team_lead = true;
                subcommand = Some(Subcommand::Stop);
            }
            "team-lead-kill" | "lead-kill" | "tl-kill" => {
                team_lead = true;
                subcommand = Some(Subcommand::Kill);
            }
            "team-lead-tree" | "lead-tree" | "tl-tree" => {
                team_lead = true;
                subcommand = Some(Subcommand::Tree);
            }
            "--yes" | "-y" => yes = true,
            value if value.starts_with('-') => {
                return Err(format!("mega: unknown argument {value}"))
            }
            value => {
                validate_target(value, "target")?;
                targets.push(value.to_owned());
            }
        }
    }
    Ok(Options {
        subcommand: subcommand.unwrap_or(Subcommand::Ls),
        team_lead,
        yes,
        targets,
    })
}

fn target_sessions(mut fleet: Vec<FleetSession>, options: &Options) -> Vec<FleetSession> {
    if options.team_lead {
        fleet.retain(is_team_lead);
    }
    if !options.targets.is_empty() {
        fleet.retain(|session| matches_target(&session.name, &options.targets));
    }
    fleet.sort_by(|a, b| a.name.cmp(&b.name));
    fleet
}

fn matches_target(session: &str, targets: &[String]) -> bool {
    targets.iter().any(|target| {
        session == target
            || oracle_name(session) == target
            || session.ends_with(&format!("-{target}"))
            || session.contains(&format!("-{target}-"))
    })
}

fn oracle_name(session: &str) -> &str {
    session
        .split_once('-')
        .filter(|(prefix, suffix)| {
            prefix.chars().all(|ch| ch.is_ascii_digit()) && !suffix.is_empty()
        })
        .map_or(session, |(_, suffix)| suffix)
}

fn is_team_lead(session: &FleetSession) -> bool {
    let name = session.name.to_ascii_lowercase();
    name.contains("team-lead")
        || name.contains("teamlead")
        || session
            .windows
            .iter()
            .any(|window| window.name.to_ascii_lowercase().contains("team-lead"))
}

fn render_ls(fleet: &[FleetSession]) -> String {
    if fleet.is_empty() {
        return "mega: no configured fleet sessions\n".to_owned();
    }
    let mut out = String::from("\x1b[36mmega fleet\x1b[0m\n");
    for session in fleet {
        let marker = if is_team_lead(session) { " lead" } else { "" };
        let _ = writeln!(
            out,
            "  {}{}  {} window{}",
            session.name,
            marker,
            session.windows.len(),
            if session.windows.len() == 1 { "" } else { "s" }
        );
    }
    out
}

fn session_windows(name: &str) -> Result<Vec<Window>, String> {
    validate_tmux_target(name)?;
    let raw = tmux(
        "list-windows",
        &[
            "-t".to_owned(),
            name.to_owned(),
            "-F".to_owned(),
            WINDOW_FORMAT.to_owned(),
        ],
    )
    .unwrap_or_default();
    Ok(parse_windows(&raw))
}

fn render_status(fleet: &[FleetSession]) -> Result<String, String> {
    if fleet.is_empty() {
        return Ok("mega: no matching sessions\n".to_owned());
    }
    let mut out = String::from("\x1b[36mmega status\x1b[0m\n");
    for session in fleet {
        let windows = session_windows(&session.name)?;
        let _ = writeln!(
            out,
            "  {}  {}  {} live / {} configured window{}",
            session.name,
            if windows.is_empty() { "down" } else { "live" },
            windows.len(),
            session.windows.len(),
            if session.windows.len() == 1 { "" } else { "s" }
        );
    }
    Ok(out)
}

fn render_tree(fleet: &[FleetSession]) -> Result<String, String> {
    if fleet.is_empty() {
        return Ok("mega: no matching sessions\n".to_owned());
    }
    let mut out = String::from("\x1b[36mmega tree\x1b[0m\n");
    for session in fleet {
        let _ = writeln!(out, "{}", session.name);
        let windows = session_windows(&session.name)?;
        if windows.is_empty() {
            out.push_str("  \x1b[90m(down)\x1b[0m\n");
        }
        for window in windows {
            let _ = writeln!(
                out,
                "  ├─ {}:{}{}  {} pane{}",
                window.index,
                window.name,
                if window.active { " *" } else { "" },
                window.panes,
                if window.panes == 1 { "" } else { "s" }
            );
        }
    }
    Ok(out)
}

fn stop_or_kill(fleet: &[FleetSession], options: &Options, verb: &str) -> Result<String, String> {
    if !options.yes {
        return Err(format!("mega: refusing to {verb} sessions without --yes"));
    }
    if fleet.is_empty() {
        return Ok("mega: no matching sessions\n".to_owned());
    }
    let mut out = format!("\x1b[36mmega {verb}\x1b[0m\n");
    for session in fleet {
        validate_tmux_target(&session.name)?;
        match tmux("kill-session", &["-t".to_owned(), session.name.clone()]) {
            Ok(_) => {
                let _ = writeln!(out, "  \x1b[32m✓\x1b[0m {}", session.name);
            }
            Err(error) => {
                let _ = writeln!(out, "  \x1b[33m⚠\x1b[0m {}: {error}", session.name);
            }
        }
    }
    Ok(out)
}

fn parse_windows(raw: &str) -> Vec<Window> {
    raw.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.split('\t');
            Window {
                index: parts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
                name: parts.next().unwrap_or_default().to_owned(),
                active: parts.next() == Some("1"),
                panes: parts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
            }
        })
        .collect()
}

fn validate_target(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.starts_with('-')
        || value.contains('\0')
        || value.contains("..")
    {
        Err(format!(
            "mega: {label} must be non-empty, unpadded, not start with '-', and not contain '..'"
        ))
    } else {
        Ok(())
    }
}

fn validate_tmux_target(value: &str) -> Result<(), String> {
    if value.is_empty() || value.trim() != value || value.starts_with('-') {
        Err(
            "mega: tmux target/session must be non-empty, unpadded, and not start with '-'"
                .to_owned(),
        )
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parses_aliases_and_team_lead_variants() {
        let parsed = parse_args(&strings(&["team-lead-status", "alpha"])).expect("parse");
        assert_eq!(parsed.subcommand, Subcommand::Status);
        assert!(parsed.team_lead);
        assert_eq!(parsed.targets, strings(&["alpha"]));
        assert_eq!(
            parse_args(&strings(&["tl", "tree"]))
                .expect("parse")
                .subcommand,
            Subcommand::Tree
        );
    }

    #[test]
    fn parses_tmux_window_format_and_guards_targets() {
        let windows = parse_windows("0\talpha-main\t1\t1\n1\tlead\t0\t2\n");
        assert_eq!(
            (
                windows[0].index,
                windows[0].name.as_str(),
                windows[0].active,
                windows[0].panes
            ),
            (0, "alpha-main", true, 1)
        );
        assert!(parse_args(&strings(&["status", "-Sbad"]))
            .unwrap_err()
            .contains("unknown argument"));
        assert!(validate_target("../bad", "target").is_err());
    }

    #[test]
    fn stop_refuses_before_host_io() {
        let options = parse_args(&strings(&["stop", "alpha"])).expect("parse");
        assert_eq!(
            stop_or_kill(&[], &options, "stop").unwrap_err(),
            "mega: refusing to stop sessions without --yes"
        );
    }
}
