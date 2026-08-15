#![allow(clippy::missing_panics_doc)]
use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

const USAGE: &str = "usage: maw broadcast [--dry-run] [--session <name>] [--team <name>] [--fleet <name>] [--] <message>";

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.paths.get"]
    fn maw_paths_get(input: u64) -> u64;
    #[link_name = "maw.fs.list"]
    fn maw_fs_list(input: u64) -> u64;
    #[link_name = "maw.fs.read"]
    fn maw_fs_read(input: u64) -> u64;
    #[link_name = "maw.tmux.list_sessions"]
    fn maw_tmux_list_sessions(input: u64) -> u64;
    #[link_name = "maw.tmux.command"]
    fn maw_tmux_command(input: u64) -> u64;
    #[link_name = "maw.tmux.send_keys"]
    fn maw_tmux_send_keys(input: u64) -> u64;
}

fn call(f: unsafe extern "C" fn(u64) -> u64, input: Value) -> Value {
    let Ok(mem) = Memory::from_bytes(input.to_string().as_bytes()) else {
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
fn value(v: &Value) -> &Value {
    v.get("value").unwrap_or(v)
}
fn ok(v: &Value) -> bool {
    v.get("ok").and_then(Value::as_bool) != Some(false)
}

#[derive(Default, Deserialize)]
struct Context {
    args: Vec<String>,
}
#[derive(Default)]
struct Scope {
    session: Option<String>,
    team: Option<String>,
    fleet: Option<String>,
}
struct Options {
    message: String,
    scope: Scope,
    dry_run: bool,
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let ctx = serde_json::from_str::<Context>(&input).unwrap_or_default();
    if has_help(&ctx.args) {
        return Ok(json!({"ok":true,"output":format!("{USAGE}\n")}).to_string());
    }
    Ok(match parse(&ctx.args).and_then(|options| run(&options)) {
        Ok(output) => json!({"ok":true,"output":output}),
        Err(error) => json!({"ok":false,"error":error}),
    }
    .to_string())
}

fn has_help(args: &[String]) -> bool {
    for arg in args {
        if arg == "--" {
            return false;
        }
        if matches!(arg.as_str(), "--help" | "-h") {
            return true;
        }
    }
    false
}
fn parse(args: &[String]) -> Result<Options, String> {
    let mut scope = Scope::default();
    let mut dry_run = false;
    let mut parts = Vec::new();
    let mut flags = true;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if flags && arg == "--" {
            flags = false;
        } else if flags && arg == "--dry-run" {
            dry_run = true;
        } else if flags && matches!(arg.as_str(), "--session" | "--team" | "--fleet") {
            index += 1;
            let Some(v) = args.get(index) else {
                return Err(format!("{arg} requires a value\n{USAGE}"));
            };
            validate_target(v).map_err(|_| format!("{arg} requires a value\n{USAGE}"))?;
            match arg.as_str() {
                "--session" => scope.session = Some(v.clone()),
                "--team" => scope.team = Some(v.clone()),
                "--fleet" => scope.fleet = Some(v.clone()),
                _ => {}
            }
        } else if flags && arg.starts_with('-') {
            return Err(format!(
                "broadcast: unknown flag or dash-prefixed message {arg}\n{USAGE}"
            ));
        } else {
            parts.push(arg.clone());
        }
        index += 1;
    }
    let message = parts.join(" ").trim().to_owned();
    if message.is_empty() {
        return Err(USAGE.to_owned());
    }
    Ok(Options {
        message,
        scope,
        dry_run,
    })
}

fn run(options: &Options) -> Result<String, String> {
    let sender = tmux_command(
        "display-message",
        vec!["-p".to_owned(), "#{window_name}".to_owned()],
    )
    .unwrap_or_else(|| "unknown".to_owned());
    let message = format!("[broadcast from {}] {}", sender.trim(), options.message);
    let team = options.scope.team.as_deref().map(team_members);
    let fleet = options.scope.fleet.as_deref().map(fleet_sessions);
    let response = call(maw_tmux_list_sessions, json!({}));
    if !ok(&response) {
        return Err("broadcast: tmux list failed".to_owned());
    }
    let sessions = value(&response)
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut sent = 0usize;
    let mut skipped = 0usize;
    let mut reasons = BTreeMap::<String, usize>::new();
    let mut out = String::new();
    for session in sessions {
        let name = session
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if skip_session(name)
            || options
                .scope
                .session
                .as_deref()
                .is_some_and(|wanted| wanted != name)
            || fleet.as_ref().is_some_and(|names| !names.contains(name))
        {
            continue;
        }
        validate_target(name)?;
        for window in session
            .get("windows")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = window.get("index").and_then(Value::as_u64).unwrap_or(0);
            let window_name = window
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if team
                .as_ref()
                .is_some_and(|members| !window_matches(name, window_name, members))
            {
                continue;
            }
            let target = format!("{name}:{index}");
            validate_target(&target)?;
            match tmux_command(
                "display-message",
                vec![
                    "-t".to_owned(),
                    target.clone(),
                    "-p".to_owned(),
                    "#{pane_current_command}".to_owned(),
                ],
            ) {
                Some(command) if is_agent(&command) => {
                    if options.dry_run {
                        let _ = writeln!(out, "would send → {target}");
                        sent += 1;
                    } else if send_text(&target, &message) {
                        let _ = writeln!(out, "\x1b[32msent\x1b[0m → {name}:{window_name}");
                        sent += 1;
                    } else {
                        skipped += 1;
                        *reasons.entry("exception".to_owned()).or_default() += 1;
                    }
                }
                Some(_) => {
                    skipped += 1;
                    *reasons.entry("non-agent-pane".to_owned()).or_default() += 1;
                }
                None => {
                    skipped += 1;
                    *reasons.entry("exception".to_owned()).or_default() += 1;
                }
            }
        }
    }
    let action = if options.dry_run {
        "Dry-run broadcast to"
    } else {
        "Broadcast to"
    };
    let _ = writeln!(
        out,
        "\n\x1b[32m✓\x1b[0m {action} {sent} windows ({skipped} skipped) [scope: {}]",
        scope_description(&options.scope)
    );
    if skipped > 0 {
        out.push_str("  \x1b[90mskipped breakdown:\x1b[0m\n");
        for (reason, count) in reasons {
            let _ = writeln!(out, "    \x1b[90m{reason}: {count}\x1b[0m");
        }
    }
    Ok(out)
}

fn tmux_command(command: &str, args: Vec<String>) -> Option<String> {
    let response = call(maw_tmux_command, json!({"command":command,"args":args}));
    ok(&response).then(|| {
        value(&response)
            .get("stdout")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    })
}
fn send_text(target: &str, text: &str) -> bool {
    ok(&call(
        maw_tmux_send_keys,
        json!({"target":target,"keys":[text],"literal":true,"enter":false,"allowDestructive":false,"force":false,"allowAiPane":true}),
    ))
}
fn validate_target(target: &str) -> Result<(), String> {
    if target.is_empty() || target.trim() != target || target.starts_with('-') {
        Err("tmux target/session must be non-empty, unpadded, and not start with '-'".to_owned())
    } else {
        Ok(())
    }
}
fn skip_session(name: &str) -> bool {
    name == "99-overview" || name == "scratch" || name.ends_with("-view")
}
fn is_agent(command: &str) -> bool {
    let c = command.to_ascii_lowercase();
    ["claude", "codex", "node", "thclaws"]
        .iter()
        .any(|v| c.contains(v))
}
fn scope_description(scope: &Scope) -> String {
    let mut p = Vec::new();
    if let Some(v) = &scope.session {
        p.push(format!("session={v}"));
    }
    if let Some(v) = &scope.team {
        p.push(format!("team={v}"));
    }
    if let Some(v) = &scope.fleet {
        p.push(format!("fleet={v}"));
    }
    if p.is_empty() {
        "all agents".to_owned()
    } else {
        p.join(", ")
    }
}
fn strip_prefix(v: &str) -> String {
    v.split_once('-')
        .filter(|(h, _)| h.chars().all(|c| c.is_ascii_digit()))
        .map_or_else(|| v.to_owned(), |(_, t)| t.to_owned())
}
fn strip_oracle(v: &str) -> String {
    v.strip_suffix("-oracle")
        .or_else(|| v.strip_suffix("-ORACLE"))
        .unwrap_or(v)
        .to_owned()
}
fn names(v: &str) -> BTreeSet<String> {
    let v = v.trim();
    if v.is_empty() {
        return BTreeSet::new();
    }
    let stripped = strip_prefix(v);
    [
        v.to_owned(),
        stripped.clone(),
        strip_oracle(v),
        strip_oracle(&stripped),
        format!("{stripped}-oracle"),
    ]
    .into_iter()
    .filter(|v| !v.is_empty())
    .collect()
}
fn window_matches(session: &str, window: &str, members: &BTreeSet<String>) -> bool {
    names(session)
        .into_iter()
        .chain(names(window))
        .any(|name| members.contains(&name))
}

fn host_path(name: &str) -> Option<PathBuf> {
    let response = call(maw_paths_get, json!({"name":name}));
    value(&response)
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
}
fn read(path: &Path) -> Option<Value> {
    let response = call(maw_fs_read, json!({"path":path,"maxBytes":10_485_760}));
    serde_json::from_str(value(&response).get("content")?.as_str()?).ok()
}
fn list_json(root: &Path) -> Vec<(String, Value)> {
    let response = call(
        maw_fs_list,
        json!({"path":root,"includeDirs":false,"maxEntries":1000}),
    );
    value(&response)
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let path = PathBuf::from(entry.get("path")?.as_str()?);
            if path.extension()?.to_str()? != "json" {
                return None;
            }
            Some((path.file_name()?.to_str()?.to_owned(), read(&path)?))
        })
        .collect()
}
fn team_members(team: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    if let Some(root) = host_path("teams") {
        if let Some(json) = read(&root.join(team).join("config.json")) {
            for member in json
                .get("members")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if member.get("agentType").and_then(Value::as_str) != Some("team-lead")
                    && member.get("role").and_then(Value::as_str) != Some("lead")
                    && member.get("name").and_then(Value::as_str) != Some("team-lead")
                {
                    if let Some(name) = member.get("name").and_then(Value::as_str) {
                        out.extend(names(name));
                    }
                }
            }
        }
    }
    if let Some(cwd) = host_path("cwd") {
        if let Some(json) = read(
            &cwd.join("ψ/memory/mailbox/teams")
                .join(team)
                .join("manifest.json"),
        ) {
            for entry in json
                .get("members")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(name) = entry
                    .as_str()
                    .or_else(|| entry.get("name").and_then(Value::as_str))
                {
                    out.extend(names(name));
                }
            }
            if let Some(values) = json.pointer("/charter/members").and_then(Value::as_array) {
                for entry in values {
                    if let Some(name) = entry
                        .get("name")
                        .and_then(Value::as_str)
                        .or_else(|| entry.get("role").and_then(Value::as_str))
                    {
                        out.extend(names(name));
                    }
                }
            }
        }
    }
    out
}
fn fleet_sessions(fleet: &str) -> BTreeSet<String> {
    let wanted = names(fleet);
    let mut out = BTreeSet::new();
    for root_name in ["fleet-state", "fleet-legacy", "fleet-config"] {
        let Some(root) = host_path(root_name) else {
            continue;
        };
        for (file, json) in list_json(&root) {
            let name = json
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_else(|| file.strip_suffix(".json").unwrap_or(&file));
            let squad = json
                .get("squadName")
                .or_else(|| json.get("groupName"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let stripped = strip_prefix(name);
            if [
                squad,
                file.strip_suffix(".json").unwrap_or(&file),
                name,
                &stripped,
            ]
            .iter()
            .any(|candidate| wanted.contains(*candidate))
                && !name.is_empty()
            {
                out.insert(name.to_owned());
            }
        }
    }
    out
}
