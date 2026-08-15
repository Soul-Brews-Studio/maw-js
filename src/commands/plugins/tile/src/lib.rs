#![allow(clippy::missing_panics_doc)]

use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::path::PathBuf;

const USAGE: &str = "usage: maw tile [N] [--border] [--wt <name>] [--layout nested|legacy] [--path <dir>] [--cmd <cmd>] [--shell] [--engine <name>] [--parent-session-id <id>] [--session-id <id>]";
const PANE_FMT: &str = "#{pane_id}|||#{pane_title}|||#{@maw_tile}";
const SWAP_FMT: &str = "#{pane_index}|||#{pane_id}|||#{pane_title}|||#{pane_top}";
const COLORS: &[(&str, &str)] = &[
    ("34", "blue"),
    ("32", "green"),
    ("33", "yellow"),
    ("36", "cyan"),
    ("35", "magenta"),
    ("31", "red"),
    ("37", "white"),
    ("38;5;208", "colour208"),
];

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.tmux.command"]
    fn maw_tmux_command(input: u64) -> u64;
}

#[derive(Default, Deserialize)]
struct Context {
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    home: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct Options {
    action: Action,
    count: usize,
    path: Option<String>,
    cmd: Option<String>,
    border: bool,
    engine: Option<String>,
    layout: Option<String>,
    wt: Wt,
    parent_id: Option<String>,
    session_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
enum Action {
    Help,
    Clean,
    Swap(String, String),
    Spawn,
}
#[derive(Debug, Clone, PartialEq, Eq)]
enum Wt {
    None,
    Anonymous,
    Named(String),
}
#[derive(Clone)]
struct Pane {
    index: String,
    id: String,
    title: String,
    top: i64,
}
struct CleanPane {
    id: String,
    title: String,
    marker: String,
}
struct Split<'a> {
    anchor: &'a str,
    prior: &'a [String],
    role: &'a str,
    cwd: &'a str,
    opts: &'a Options,
    parent: &'a str,
    window: &'a str,
    index: usize,
    total: usize,
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let context = serde_json::from_str::<Context>(&input).unwrap_or_default();
    Ok(match run(&context) {
        Ok(output) => json!({"ok":true,"output":output}),
        Err(error) => json!({"ok":false,"error":error}),
    }
    .to_string())
}

fn run(context: &Context) -> Result<String, String> {
    let anchor = tmux("display-message", &["-p", "#{pane_id}"])
        .map_err(|_| "\x1b[33m⚠\x1b[0m tile requires tmux".to_owned())?
        .trim()
        .to_owned();
    let opts = parse(&context.args)?;
    match &opts.action {
        Action::Help => Ok(help()),
        Action::Clean => clean(&anchor),
        Action::Swap(left, right) => swap(left, right),
        Action::Spawn => spawn(&anchor, &opts, context),
    }
}

fn parse(argv: &[String]) -> Result<Options, String> {
    let (args, wt) = extract_wt(argv)?;
    let mut opts = Options {
        action: Action::Spawn,
        count: 0,
        path: None,
        cmd: None,
        border: false,
        engine: None,
        layout: None,
        wt,
        parent_id: None,
        session_id: None,
    };
    let mut pos = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--" => return Err(with_usage("tile: -- separator is not supported")),
            "--help" | "-h" => opts.action = Action::Help,
            "--shell" => {}
            "--border" => opts.border = true,
            "--path" | "-p" => {
                i += 1;
                opts.path = Some(take(&args, i, "--path")?);
            }
            "--cmd" | "-c" => {
                i += 1;
                opts.cmd = Some(take(&args, i, "--cmd")?);
            }
            "--engine" | "-e" => {
                i += 1;
                opts.engine = Some(token(&take(&args, i, "--engine")?, "engine")?);
            }
            "--layout" => {
                i += 1;
                opts.layout = Some(take(&args, i, "--layout")?);
            }
            "--parent" | "--parent-session-id" => {
                i += 1;
                opts.parent_id = Some(token(
                    &take(&args, i, "--parent-session-id")?,
                    "parent session",
                )?);
            }
            "--session-id" => {
                i += 1;
                opts.session_id = Some(token(&take(&args, i, "--session-id")?, "session id")?);
            }
            value if value.starts_with('-') => {
                return Err(with_usage(&format!("tile: unknown argument {value}")))
            }
            value => pos.push(value.to_owned()),
        }
        i += 1;
    }
    if !matches!(opts.action, Action::Help) {
        match pos.first().map(String::as_str) {
            Some("clean") => opts.action = Action::Clean,
            Some("swap") => {
                let left = pos.get(1).ok_or("tile swap: two pane targets required")?;
                let right = pos.get(2).ok_or("tile swap: two pane targets required")?;
                opts.action = Action::Swap(pane_spec(left)?, pane_spec(right)?);
            }
            Some(value) => opts.count = count(value)?,
            None => {}
        }
    }
    if opts
        .layout
        .as_deref()
        .is_some_and(|v| !matches!(v, "nested" | "legacy"))
    {
        return Err("tile: --layout must be nested or legacy".to_owned());
    }
    if opts.count > 10 {
        return Err(format!("tile: max 10 panes (got {})", opts.count));
    }
    if opts.cmd.as_ref().is_some_and(|v| v.trim().is_empty()) {
        return Err("tile: --cmd cannot be empty".to_owned());
    }
    if opts.path.as_ref().is_some_and(|v| v.trim().is_empty()) {
        return Err("tile: --path cannot be empty".to_owned());
    }
    Ok(opts)
}

fn extract_wt(argv: &[String]) -> Result<(Vec<String>, Wt), String> {
    let (mut out, mut wt, mut i) = (Vec::new(), Wt::None, 0);
    while i < argv.len() {
        if argv[i] == "--wt" {
            if argv.get(i + 1).is_some_and(|v| !v.starts_with('-')) {
                i += 1;
                wt = Wt::Named(token(&argv[i], "worktree")?);
            } else {
                wt = Wt::Anonymous;
            }
        } else if let Some(value) = argv[i].strip_prefix("--wt=") {
            wt = Wt::Named(token(value, "worktree")?);
        } else {
            out.push(argv[i].clone());
        }
        i += 1;
    }
    Ok((out, wt))
}

fn spawn(anchor: &str, opts: &Options, context: &Context) -> Result<String, String> {
    let window = tmux("display-message", &["-p", "#{window_id}"])?
        .trim()
        .to_owned();
    if opts.count == 0 {
        tmux("select-layout", &["-t", &window, "tiled"])?;
        return Ok("\x1b[32m✓\x1b[0m tiled\n".to_owned());
    }
    let parent = tmux(
        "display-message",
        &[
            "-t",
            anchor,
            "-p",
            "#{session_name}:#{window_index}.#{pane_index}",
        ],
    )
    .unwrap_or_else(|_| anchor.to_owned())
    .trim()
    .to_owned();
    let address = tmux(
        "display-message",
        &["-t", anchor, "-p", "#{session_name}:#{window_index}"],
    )
    .unwrap_or_else(|_| window.clone())
    .trim()
    .to_owned();
    let existing = tmux("list-panes", &["-t", &window, "-F", PANE_FMT]).map_or(0, |raw| {
        raw.lines().filter_map(clean_row).filter(is_tile).count()
    });
    let cwd = resolve_path(opts.path.as_deref(), context)?;
    let mut ids = Vec::new();
    let mut out = String::new();
    for offset in 0..opts.count {
        let index = existing + offset + 1;
        let role = role(&parent, index);
        let split = Split {
            anchor,
            prior: &ids,
            role: &role,
            cwd: &cwd,
            opts,
            parent: &parent,
            window: &address,
            index,
            total: existing + opts.count,
        };
        let id = split_pane(&split)?;
        ids.push(id.clone());
        style(&id, &role, offset)?;
        tag(&id, &parent, &role)?;
        if opts.cmd.is_none() {
            send_engine(&id, opts.engine.as_deref())?;
        }
        out.push_str(&spawn_line(offset, &role, &id, &cwd, opts));
    }
    layout_after(&window, opts)?;
    out.push_str(&summary(opts, &cwd));
    Ok(out)
}

fn clean(anchor: &str) -> Result<String, String> {
    let window = tmux("display-message", &["-p", "#{window_id}"])?
        .trim()
        .to_owned();
    let raw = tmux("list-panes", &["-t", &window, "-F", PANE_FMT])?;
    let (mut killed, mut out) = (0, String::new());
    for row in raw.lines().filter_map(clean_row) {
        if row.id == anchor || !is_tile(&row) {
            continue;
        }
        if tmux("kill-pane", &["-t", &row.id]).is_ok() {
            let _ = writeln!(out, "  \x1b[31m✗\x1b[0m {} ({})", row.title, row.id);
            killed += 1;
        }
    }
    if killed == 0 {
        out.push_str("\x1b[90mno tile panes or worktrees to clean\x1b[0m\n");
    } else {
        let _ = writeln!(out, "\x1b[32m✓\x1b[0m cleaned {killed} tiles");
    }
    Ok(out)
}

fn swap(left: &str, right: &str) -> Result<String, String> {
    let window = tmux("display-message", &["-p", "#{window_id}"])?
        .trim()
        .to_owned();
    let raw = tmux("list-panes", &["-t", &window, "-F", SWAP_FMT])?;
    let rows = raw.lines().filter_map(pane_row).collect::<Vec<_>>();
    let source = resolve_pane(left, &rows)
        .ok_or_else(|| format!("tile swap: could not resolve pane '{left}'"))?;
    let target = resolve_pane(right, &rows)
        .ok_or_else(|| format!("tile swap: could not resolve pane '{right}'"))?;
    if source.id == target.id {
        return Err("tile swap: source and target are the same pane".to_owned());
    }
    tmux("swap-pane", &["-s", &source.id, "-t", &target.id])?;
    Ok(format!(
        "\x1b[32m✓\x1b[0m swapped {} ↔ {}\n",
        display(&source),
        display(&target)
    ))
}

fn split_pane(req: &Split<'_>) -> Result<String, String> {
    let target = req.prior.last().map_or(req.anchor, String::as_str);
    let shell = shell_command(req);
    let pane = tmux(
        "split-window",
        &["-t", target, "-h", "-P", "-F", "#{pane_id}", &shell],
    )?
    .trim()
    .to_owned();
    target_value(&pane)?;
    Ok(pane)
}

fn shell_command(req: &Split<'_>) -> String {
    let mut envs = vec![
        format!("MAW_TILE_PARENT={}", quote(req.parent)),
        format!("MAW_TILE_ROLE={}", quote(req.role)),
        format!("MAW_TILE_INDEX={}", quote(&req.index.to_string())),
        format!("MAW_TILE_TOTAL={}", quote(&req.total.to_string())),
        format!("MAW_TILE_WINDOW={}", quote(req.window)),
    ];
    if let Some(id) = &req.opts.parent_id {
        envs.push(format!("MAW_PARENT_SESSION_ID={}", quote(id)));
    }
    if req.opts.count == 1 {
        if let Some(id) = &req.opts.session_id {
            envs.push(format!("MAW_SESSION_ID={}", quote(id)));
        }
    }
    let body = req.opts.cmd.as_ref().map_or_else(
        || "exec zsh".to_owned(),
        |cmd| format!("exec zsh -ic {}", quote(&format!("{cmd}; exec zsh"))),
    );
    let shell = format!("export {}; {body}", envs.join(" "));
    if req.cwd.is_empty() {
        shell
    } else {
        format!("cd {} || exit $?; {shell}", quote(req.cwd))
    }
}

fn style(id: &str, role: &str, index: usize) -> Result<(), String> {
    let color = COLORS[index % COLORS.len()].1;
    tmux("select-pane", &["-t", id, "-T", role])?;
    tmux(
        "set-option",
        &[
            "-p",
            "-t",
            id,
            "pane-border-format",
            &format!("#[fg={color},bold] #{{pane_title}}"),
        ],
    )?;
    tmux(
        "set-option",
        &[
            "-p",
            "-t",
            id,
            "pane-active-border-style",
            &format!("fg={color}"),
        ],
    )?;
    Ok(())
}

fn tag(id: &str, parent: &str, role: &str) -> Result<(), String> {
    for (key, value) in [
        ("@maw_tile", "1"),
        ("@maw_tile_parent", parent),
        ("@maw_tile_role", role),
    ] {
        tmux("set-option", &["-p", "-t", id, key, value])?;
    }
    Ok(())
}

fn send_engine(id: &str, engine: Option<&str>) -> Result<(), String> {
    let Some(engine) = engine.filter(|v| !v.is_empty()) else {
        return Ok(());
    };
    for args in [
        vec!["-t", id, "C-u"],
        vec!["-t", id, "-l", engine],
        vec!["-t", id, "Enter"],
    ] {
        tmux("send-keys", &args)?;
    }
    Ok(())
}

fn layout_after(window: &str, opts: &Options) -> Result<(), String> {
    let count = tmux("list-panes", &["-t", window, "-F", "#{pane_id}"])?
        .lines()
        .filter(|line| !line.is_empty())
        .count();
    let layout = if count == 2 {
        "even-horizontal"
    } else if count <= 4 {
        "main-vertical"
    } else {
        "tiled"
    };
    tmux("select-layout", &["-t", window, layout])?;
    if opts.border {
        let heights =
            tmux("list-panes", &["-t", window, "-F", "#{pane_height}"]).unwrap_or_default();
        if heights
            .lines()
            .filter_map(|v| v.trim().parse::<i64>().ok())
            .all(|v| v >= 4)
        {
            let _ = tmux(
                "set-option",
                &["-w", "-t", window, "pane-border-status", "top"],
            );
        }
    }
    Ok(())
}

fn tmux(command: &str, args: &[&str]) -> Result<String, String> {
    let response = host_call(
        maw_tmux_command,
        json!({"command":command,"args":args}).to_string(),
    );
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response
            .get("error")
            .or_else(|| response.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("tmux command failed")
            .to_owned());
    }
    Ok(response
        .get("value")
        .unwrap_or(&response)
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned())
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

fn clean_row(line: &str) -> Option<CleanPane> {
    let mut p = line.split("|||");
    let id = p.next()?.to_owned();
    (!id.is_empty()).then(|| CleanPane {
        id,
        title: p.next().unwrap_or_default().to_owned(),
        marker: p.next().unwrap_or_default().to_owned(),
    })
}
fn pane_row(line: &str) -> Option<Pane> {
    let mut p = line.split("|||");
    let index = p.next()?.to_owned();
    let id = p.next()?.to_owned();
    (!id.is_empty()).then(|| Pane {
        index,
        id,
        title: p.next().unwrap_or_default().to_owned(),
        top: p.next().unwrap_or("0").parse().unwrap_or(0),
    })
}
fn is_tile(row: &CleanPane) -> bool {
    row.marker == "1"
        || row
            .title
            .strip_suffix(" 🌳")
            .unwrap_or(&row.title)
            .rsplit_once("tile-")
            .is_some_and(|(_, n)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}
fn resolve_pane(spec: &str, rows: &[Pane]) -> Option<Pane> {
    match spec {
        "top" => extreme(rows, true),
        "bottom" => extreme(rows, false),
        v if v.starts_with('%') => rows.iter().find(|r| r.id == v).cloned().or_else(|| {
            Some(Pane {
                index: String::new(),
                id: v.to_owned(),
                title: v.to_owned(),
                top: 0,
            })
        }),
        v if v.chars().all(|c| c.is_ascii_digit()) => rows.iter().find(|r| r.index == v).cloned(),
        v => rows
            .iter()
            .find(|r| r.title == v || r.title.starts_with(v))
            .cloned(),
    }
}
fn extreme(rows: &[Pane], first: bool) -> Option<Pane> {
    let mut rows = rows.to_vec();
    if first {
        rows.sort_by_key(|r| (r.top, r.index.parse::<i64>().unwrap_or(0)));
    } else {
        rows.sort_by_key(|r| {
            (
                std::cmp::Reverse(r.top),
                std::cmp::Reverse(r.index.parse::<i64>().unwrap_or(0)),
            )
        });
    }
    rows.into_iter().next()
}
fn display(row: &Pane) -> &str {
    if row.title.is_empty() {
        &row.id
    } else {
        &row.title
    }
}
fn role(parent: &str, index: usize) -> String {
    let scope = parent
        .split(':')
        .next()
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    let scope = scope.trim_matches('-');
    if scope.is_empty() {
        format!("tile-{index}")
    } else {
        format!("{scope}-tile-{index}")
    }
}
fn count(value: &str) -> Result<usize, String> {
    let digits = value
        .trim()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    if digits.is_empty() || value.trim().starts_with('-') {
        Err(format!("tile: expected a number, got '{value}'"))
    } else {
        digits.parse().map_err(|_| "tile: invalid count".to_owned())
    }
}
fn pane_spec(value: &str) -> Result<String, String> {
    let value = value.trim();
    if !value.is_empty()
        && (matches!(value, "top" | "bottom")
            || value.chars().all(|c| c.is_ascii_digit())
            || value
                .strip_prefix('%')
                .is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
            || value.chars().all(safe_char))
    {
        Ok(value.to_owned())
    } else {
        Err(format!("tile: invalid pane target {value:?}"))
    }
}
fn token(value: &str, label: &str) -> Result<String, String> {
    if value.is_empty()
        || value.trim() != value
        || value.starts_with('-')
        || !value.chars().all(safe_char)
    {
        Err(format!("tile: invalid {label} {value:?}"))
    } else {
        Ok(value.to_owned())
    }
}
fn target_value(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        Err("tmux target/session must be non-empty, unpadded, and not start with '-'".to_owned())
    } else {
        Ok(())
    }
}
fn safe_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')
}
fn take(args: &[String], index: usize, flag: &str) -> Result<String, String> {
    args.get(index)
        .filter(|v| !v.starts_with('-'))
        .cloned()
        .ok_or_else(|| with_usage(&format!("tile: {flag} requires a value")))
}
fn with_usage(message: &str) -> String {
    format!("{message}\n{USAGE}")
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn resolve_path(raw: Option<&str>, context: &Context) -> Result<String, String> {
    let Some(raw) = raw else {
        return Ok(String::new());
    };
    if raw.trim().is_empty() {
        return Err("tile: --path cannot be empty".to_owned());
    }
    if raw == "." {
        return Ok(context.cwd.clone().unwrap_or_else(|| ".".to_owned()));
    }
    let path = if raw == "~" {
        context.home.clone().unwrap_or_else(|| raw.to_owned())
    } else if let Some(rest) = raw.strip_prefix("~/") {
        format!("{}/{}", context.home.as_deref().unwrap_or("~"), rest)
    } else {
        raw.to_owned()
    };
    let path = PathBuf::from(path);
    Ok(if path.is_absolute() {
        path
    } else {
        PathBuf::from(context.cwd.as_deref().unwrap_or(".")).join(path)
    }
    .to_string_lossy()
    .into_owned())
}
fn spawn_line(index: usize, role: &str, id: &str, cwd: &str, opts: &Options) -> String {
    let mut extra = Vec::new();
    if !cwd.is_empty() {
        extra.push(format!("\x1b[90m{cwd}\x1b[0m"));
    }
    if opts.cmd.is_some() {
        extra.push("\x1b[90mcmd\x1b[0m".to_owned());
    } else if let Some(engine) = &opts.engine {
        extra.push(format!("\x1b[90m{engine}\x1b[0m"));
    }
    format!(
        "  \x1b[{}m●\x1b[0m {role} → {id}{}\n",
        COLORS[index % COLORS.len()].0,
        if extra.is_empty() {
            String::new()
        } else {
            format!("  {}", extra.join(" "))
        }
    )
}
fn summary(opts: &Options, cwd: &str) -> String {
    let mut flags = Vec::new();
    match &opts.wt {
        Wt::None => {}
        Wt::Anonymous => flags.push("worktree".to_owned()),
        Wt::Named(name) => flags.push(format!("worktree:{name}")),
    }
    if !cwd.is_empty() {
        flags.push("path".to_owned());
    }
    if opts.cmd.is_some() {
        flags.push("cmd".to_owned());
    } else if let Some(engine) = &opts.engine {
        flags.push(engine.clone());
    }
    format!(
        "\x1b[32m✓\x1b[0m {} panes tiled{}\n",
        opts.count,
        if flags.is_empty() {
            String::new()
        } else {
            format!(" ({})", flags.join(", "))
        }
    )
}
fn help() -> String {
    format!("{USAGE}\n       maw tile clean\n       maw tile swap <a> <b>\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }
    #[test]
    fn parses_spawn_and_swap_guards() {
        let opts = parse(&strings(&["3", "--border", "--wt", "feat", "-e", "claude"])).unwrap();
        assert_eq!(opts.count, 3);
        assert!(opts.border);
        assert_eq!(opts.wt, Wt::Named("feat".to_owned()));
        assert!(parse(&strings(&["--", "3"]))
            .unwrap_err()
            .contains("separator"));
    }
    #[test]
    fn split_request_builds_exact_argv_payload() {
        let opts = parse(&strings(&["1", "--cmd", "echo ok", "--session-id", "solo"])).unwrap();
        let split = Split {
            anchor: "%1",
            prior: &[],
            role: "alpha-tile-1",
            cwd: "/repo",
            opts: &opts,
            parent: "alpha:1.0",
            window: "alpha:1",
            index: 1,
            total: 1,
        };
        assert_eq!(shell_command(&split), "cd '/repo' || exit $?; export MAW_TILE_PARENT='alpha:1.0' MAW_TILE_ROLE='alpha-tile-1' MAW_TILE_INDEX='1' MAW_TILE_TOTAL='1' MAW_TILE_WINDOW='alpha:1' MAW_SESSION_ID='solo'; exec zsh -ic 'echo ok; exec zsh'");
    }
}
