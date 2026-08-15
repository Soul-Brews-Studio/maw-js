#![allow(clippy::missing_panics_doc)]

use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

const PULSE_DEFAULT_REPO: &str = "laris-co/pulse-oracle";

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.paths.get"]
    fn maw_paths_get(input: u64) -> u64;
    #[link_name = "maw.fs.list"]
    fn maw_fs_list(input: u64) -> u64;
    #[link_name = "maw.exec.run"]
    fn maw_exec_run(input: u64) -> u64;
    #[link_name = "maw.tmux.list_sessions"]
    fn maw_tmux_list_sessions(input: u64) -> u64;
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

fn host_list_dirs(path: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut offset = 0_u64;
    loop {
        let response = host_call(
            maw_fs_list,
            json!({
                "path": path,
                "recursive": false,
                "includeDirs": true,
                "maxEntries": 1000,
                "offset": offset
            })
            .to_string(),
        );
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            break;
        }
        let value = host_value(&response);
        if let Some(entries) = value.get("entries").and_then(Value::as_array) {
            dirs.extend(entries.iter().filter_map(|entry| {
                let entry = serde_json::from_value::<HostEntry>(entry.clone()).ok()?;
                (entry.kind == "dir").then_some(entry.path)
            }));
        }
        let Some(next) = value.get("nextOffset").and_then(Value::as_u64) else {
            break;
        };
        offset = next;
    }
    dirs
}

fn pulse_exec(program: &str, args: &[String], allow_non_zero: bool) -> Result<HostExec, String> {
    let response = host_call(
        maw_exec_run,
        json!({
            "cmd": program,
            "args": args,
            "timeoutMs": 10_000,
            "allowNonZero": allow_non_zero
        })
        .to_string(),
    );
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response
            .get("error")
            .or_else(|| response.get("message"))
            .and_then(Value::as_str)
            .map_or_else(|| format!("pulse: {program} failed"), ToOwned::to_owned));
    }
    serde_json::from_value(host_value(&response).clone())
        .map_err(|error| format!("pulse: parse {program} result: {error}"))
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    #[serde(default)]
    args: Vec<String>,
    pulse_repo: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostEntry {
    path: PathBuf,
    kind: String,
}

#[derive(Debug, Deserialize)]
struct HostExec {
    status: i32,
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PulseIssue {
    number: u64,
    title: String,
    labels: Vec<PulseLabel>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct PulseLabel {
    name: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct PulseGhIssue {
    number: u64,
    title: String,
    #[serde(default)]
    labels: Vec<PulseLabel>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct PulseGhIssueWithUrl {
    number: u64,
    title: String,
    url: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct PulseComment {
    id: Value,
    #[serde(default)]
    body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PulseAddOptions {
    title: String,
    oracle: Option<String>,
    priority: Option<String>,
    wt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PulseWorktree {
    path: PathBuf,
    branch: String,
    repo: String,
    main_repo: String,
    main_path: PathBuf,
    name: String,
    status: PulseWorktreeStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PulseWorktreeStatus {
    Active,
    Stale,
    Orphan,
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let context = serde_json::from_str::<Context>(&input).unwrap_or_default();
    Ok(match pulse_run(&context.args, &context) {
        Ok(output) => json!({"ok": true, "output": output}),
        Err(error) => json!({"ok": false, "error": error}),
    }
    .to_string())
}

fn pulse_run(argv: &[String], context: &Context) -> Result<String, String> {
    match argv.first().map(String::as_str) {
        Some("add") => pulse_add(&pulse_parse_add_args(&argv[1..])?, context),
        Some("ls" | "list") => pulse_list(argv.iter().any(|arg| arg == "--sync"), context),
        Some("cleanup" | "clean") => pulse_cleanup(argv.iter().any(|arg| arg == "--dry-run")),
        Some("active") => pulse_list_filtered(PulseWorktreeStatus::Active),
        Some("stale") => pulse_list_filtered(PulseWorktreeStatus::Stale),
        Some("orphan") => pulse_list_filtered(PulseWorktreeStatus::Orphan),
        _ => Err(pulse_usage()),
    }
}

fn pulse_usage() -> String {
    "usage: maw pulse <add|ls|cleanup> [opts]".to_owned()
}

fn pulse_parse_add_args(argv: &[String]) -> Result<PulseAddOptions, String> {
    let mut oracle = None::<String>;
    let mut priority = None::<String>;
    let mut wt = None::<String>;
    let mut title = None::<String>;
    let mut index = 0_usize;
    while index < argv.len() {
        match argv[index].as_str() {
            "--oracle" => {
                let Some(value) = argv.get(index + 1) else {
                    return Err("pulse: --oracle requires a value".to_owned());
                };
                pulse_validate_target_arg(value, "oracle")?;
                oracle = Some(value.clone());
                index += 2;
            }
            value if value.starts_with("--oracle=") => {
                let value = &value["--oracle=".len()..];
                pulse_validate_target_arg(value, "oracle")?;
                oracle = Some(value.to_owned());
                index += 1;
            }
            "--priority" => {
                let Some(value) = argv.get(index + 1) else {
                    return Err("pulse: --priority requires a value".to_owned());
                };
                pulse_validate_target_arg(value, "priority")?;
                priority = Some(value.clone());
                index += 2;
            }
            value if value.starts_with("--priority=") => {
                let value = &value["--priority=".len()..];
                pulse_validate_target_arg(value, "priority")?;
                priority = Some(value.to_owned());
                index += 1;
            }
            "--wt" | "--worktree" => {
                let Some(value) = argv.get(index + 1) else {
                    return Err("pulse: --wt requires a value".to_owned());
                };
                pulse_validate_path_arg(value, "worktree")?;
                wt = Some(value.clone());
                index += 2;
            }
            value if value.starts_with("--wt=") => {
                let value = &value["--wt=".len()..];
                pulse_validate_path_arg(value, "worktree")?;
                wt = Some(value.to_owned());
                index += 1;
            }
            value if value.starts_with("--worktree=") => {
                let value = &value["--worktree=".len()..];
                pulse_validate_path_arg(value, "worktree")?;
                wt = Some(value.to_owned());
                index += 1;
            }
            value if value.starts_with("--") => {
                return Err(format!("pulse: unknown argument {value}"))
            }
            value => {
                if title.is_none() {
                    title = Some(value.to_owned());
                }
                index += 1;
            }
        }
    }
    let Some(title) = title.filter(|value| !value.is_empty()) else {
        return Err("usage: maw pulse add \"task title\" --oracle <name> [--wt <repo>]".to_owned());
    };
    Ok(PulseAddOptions {
        title,
        oracle,
        priority,
        wt,
    })
}

fn pulse_add(options: &PulseAddOptions, context: &Context) -> Result<String, String> {
    let repo = pulse_repo(context)?;
    let repo = repo.as_str();
    let period = pulse_time_period();
    let thread = pulse_find_or_create_daily_thread(repo)?;
    let mut stdout = String::new();
    if thread.2 {
        let _ = writeln!(
            stdout,
            "\x1b[32m+\x1b[0m daily thread #{}: {}",
            thread.1, thread.0
        );
    }

    let mut args = vec![
        "issue".to_owned(),
        "create".to_owned(),
        "--repo".to_owned(),
        repo.to_owned(),
        "-t".to_owned(),
        options.title.clone(),
        "-b".to_owned(),
        format!("Parent: #{}", thread.1),
    ];
    if let Some(oracle) = &options.oracle {
        args.push("-l".to_owned());
        args.push(format!("oracle:{oracle}"));
    }
    if let Some(priority) = &options.priority {
        args.push("-l".to_owned());
        args.push(priority.clone());
    }
    let issue_url = pulse_command_stdout("gh", &args)?.trim().to_owned();
    let issue_num = pulse_parse_trailing_number(&issue_url);
    let _ = writeln!(
        stdout,
        "\x1b[32m+\x1b[0m issue #{issue_num} ({period}): {issue_url}"
    );

    pulse_add_task_to_period_comment(
        repo,
        thread.1,
        &period,
        issue_num,
        &options.title,
        options.oracle.as_deref(),
    )?;
    let _ = writeln!(
        stdout,
        "\x1b[32m+\x1b[0m added to {period} in daily thread #{}",
        thread.1
    );

    match pulse_command_stdout(
        "gh",
        &[
            "project".to_owned(),
            "item-add".to_owned(),
            "6".to_owned(),
            "--owner".to_owned(),
            "laris-co".to_owned(),
            "--url".to_owned(),
            issue_url.clone(),
        ],
    ) {
        Ok(_) => stdout.push_str("\x1b[32m+\x1b[0m added to Master Board (#6)\n"),
        Err(error) => {
            let _ = writeln!(
                stdout,
                "\x1b[33mwarn:\x1b[0m could not add to project board: {error}"
            );
        }
    }

    if let Some(oracle) = &options.oracle {
        pulse_validate_target_arg(oracle, "oracle")?;
        let prompt = format!(
            "/recap --deep — You have been assigned issue #{issue_num}: {}. Issue URL: {issue_url}. Orient yourself, then wait for human instructions.",
            options.title
        );
        let mut wake_args = vec!["wake".to_owned(), oracle.clone()];
        if let Some(wt) = &options.wt {
            wake_args.push("--wt".to_owned());
            wake_args.push(wt.clone());
        }
        wake_args.push("--prompt".to_owned());
        wake_args.push(prompt);
        let target = pulse_command_stdout("maw", &wake_args)?.trim().to_owned();
        let target = if target.is_empty() {
            oracle.as_str()
        } else {
            target.as_str()
        };
        let _ = writeln!(
            stdout,
            "\x1b[32m🚀\x1b[0m {target}: waking up with /recap --deep → then --continue"
        );
    }

    Ok(stdout)
}

fn pulse_list(sync: bool, context: &Context) -> Result<String, String> {
    let repo = pulse_repo(context)?;
    let repo = repo.as_str();
    let issues_json = pulse_command_stdout(
        "gh",
        &[
            "issue".to_owned(),
            "list".to_owned(),
            "--repo".to_owned(),
            repo.to_owned(),
            "--state".to_owned(),
            "open".to_owned(),
            "--json".to_owned(),
            "number,title,labels".to_owned(),
            "--limit".to_owned(),
            "50".to_owned(),
        ],
    )?;
    let parsed: Vec<PulseGhIssue> =
        serde_json::from_str(pulse_str_or_default(issues_json.trim(), "[]"))
            .map_err(|error| format!("pulse: parse gh issue list json: {error}"))?;
    let issues = parsed
        .into_iter()
        .map(|issue| PulseIssue {
            number: issue.number,
            title: issue.title,
            labels: issue.labels,
        })
        .collect::<Vec<_>>();
    let (projects, tools, active, threads) = pulse_categorize_issues(&issues);
    let mut stdout = pulse_render_board(
        &projects,
        &tools,
        &active,
        issues.len().saturating_sub(threads.len()),
    );
    if sync {
        stdout.push_str(&pulse_sync_daily_thread(
            repo, &projects, &tools, &active, &threads,
        )?);
    }
    Ok(stdout)
}

fn pulse_list_filtered(status: PulseWorktreeStatus) -> Result<String, String> {
    let mut out = String::new();
    for worktree in pulse_scan_worktrees()?
        .into_iter()
        .filter(|worktree| worktree.status == status)
    {
        let _ = writeln!(
            out,
            "{}  {} ({}) [{}]",
            pulse_status_name(worktree.status),
            worktree.name,
            worktree.main_repo,
            worktree.branch
        );
    }
    Ok(out)
}

fn pulse_cleanup(dry_run: bool) -> Result<String, String> {
    let worktrees = pulse_scan_worktrees()?;
    let stale = worktrees
        .iter()
        .filter(|worktree| worktree.status != PulseWorktreeStatus::Active)
        .cloned()
        .collect::<Vec<_>>();
    if stale.is_empty() {
        return Ok("\x1b[32m✓\x1b[0m All worktrees are active. Nothing to clean.\n".to_owned());
    }
    let mut stdout = String::new();
    stdout.push_str("\n\x1b[36mWorktree Cleanup\x1b[0m\n\n");
    let active_count = worktrees
        .iter()
        .filter(|worktree| worktree.status == PulseWorktreeStatus::Active)
        .count();
    let stale_count = worktrees
        .iter()
        .filter(|worktree| worktree.status == PulseWorktreeStatus::Stale)
        .count();
    let orphan_count = worktrees
        .iter()
        .filter(|worktree| worktree.status == PulseWorktreeStatus::Orphan)
        .count();
    let _ = writeln!(stdout, "  \x1b[32m{active_count} active\x1b[0m | \x1b[33m{stale_count} stale\x1b[0m | \x1b[31m{orphan_count} orphan\x1b[0m\n");
    for worktree in stale {
        let color = if worktree.status == PulseWorktreeStatus::Orphan {
            "\x1b[31m"
        } else {
            "\x1b[33m"
        };
        let _ = writeln!(
            stdout,
            "{color}{}\x1b[0m  {} ({}) [{}]",
            pulse_status_name(worktree.status),
            worktree.name,
            worktree.main_repo,
            worktree.branch
        );
        if !dry_run {
            for line in pulse_cleanup_worktree(&worktree)? {
                let _ = writeln!(stdout, "  \x1b[32m✓\x1b[0m {line}");
            }
        }
    }
    if dry_run {
        stdout.push_str("\n\x1b[90m(dry run — use without --dry-run to clean)\x1b[0m\n");
    }
    stdout.push('\n');
    Ok(stdout)
}

fn pulse_categorize_issues(
    issues: &[PulseIssue],
) -> (
    Vec<PulseIssue>,
    Vec<PulseIssue>,
    Vec<PulseIssue>,
    Vec<PulseIssue>,
) {
    let mut projects = Vec::new();
    let mut today = Vec::new();
    let mut threads = Vec::new();
    for issue in issues {
        let labels = issue
            .labels
            .iter()
            .map(|label| label.name.as_str())
            .collect::<Vec<_>>();
        if labels.contains(&"daily-thread") {
            threads.push(issue.clone());
        } else if issue.title.starts_with('P')
            && issue
                .title
                .chars()
                .skip(1)
                .take(3)
                .all(|ch| ch.is_ascii_digit())
        {
            projects.push(issue.clone());
        } else {
            today.push(issue.clone());
        }
    }
    let thread_floor = threads.first().map_or(0, |issue| issue.number);
    let mut tools = Vec::new();
    let mut active = Vec::new();
    for issue in today {
        let is_today = issue.title.contains("Daily") || issue.number > thread_floor;
        if is_today && !issue.title.contains("Daily") {
            active.push(issue);
        } else {
            tools.push(issue);
        }
    }
    (projects, tools, active, threads)
}

fn pulse_render_board(
    projects: &[PulseIssue],
    tools: &[PulseIssue],
    active: &[PulseIssue],
    open_count: usize,
) -> String {
    let mut stdout = "\n\x1b[36m📋 Pulse Board\x1b[0m\n\n".to_owned();
    pulse_render_issue_table(&mut stdout, "Projects", projects);
    pulse_render_issue_table(&mut stdout, "Tools/Infra", tools);
    if !active.is_empty() {
        let _ = writeln!(stdout, "\n\x1b[33mActive Today ({})\x1b[0m", active.len());
        let mut sorted = active.to_vec();
        sorted.sort_by_key(|issue| issue.number);
        for issue in &sorted {
            let _ = writeln!(
                stdout,
                "  \x1b[33m🟡\x1b[0m #{} {} → {}",
                issue.number,
                issue.title,
                pulse_issue_oracle(issue)
            );
        }
    }
    let _ = writeln!(stdout, "\n\x1b[36m{open_count} open\x1b[0m\n");
    stdout
}

fn pulse_render_issue_table(stdout: &mut String, title: &str, issues: &[PulseIssue]) {
    if issues.is_empty() {
        return;
    }
    let _ = writeln!(stdout, "\x1b[33m{title} ({})\x1b[0m", issues.len());
    stdout.push_str("┌──────┬──────────────────────────────────────────────────┬──────────────┐\n");
    let mut sorted = issues.to_vec();
    sorted.sort_by_key(|issue| issue.number);
    for issue in &sorted {
        let title = pulse_pad_end(&pulse_truncate_chars(&issue.title, 48), 48);
        let oracle = pulse_pad_end(&pulse_issue_oracle(issue), 12);
        let _ = writeln!(
            stdout,
            "│ \x1b[32m#{:<3}\x1b[0m │ {title} │ {oracle} │",
            issue.number
        );
    }
    stdout.push_str("└──────┴──────────────────────────────────────────────────┴──────────────┘\n");
}

fn pulse_issue_oracle(issue: &PulseIssue) -> String {
    issue
        .labels
        .iter()
        .find_map(|label| label.name.strip_prefix("oracle:").map(ToOwned::to_owned))
        .unwrap_or_else(|| "—".to_owned())
}

fn pulse_find_or_create_daily_thread(repo: &str) -> Result<(String, u64, bool), String> {
    let date = pulse_today_date();
    let label = pulse_today_label();
    let search = format!("📅 {date} in:title");
    let raw = pulse_command_stdout(
        "gh",
        &[
            "issue".to_owned(),
            "list".to_owned(),
            "--repo".to_owned(),
            repo.to_owned(),
            "--search".to_owned(),
            search,
            "--state".to_owned(),
            "open".to_owned(),
            "--json".to_owned(),
            "number,url,title".to_owned(),
            "--limit".to_owned(),
            "1".to_owned(),
        ],
    )?;
    let parsed: Vec<PulseGhIssueWithUrl> =
        serde_json::from_str(pulse_str_or_default(raw.trim(), "[]"))
            .map_err(|error| format!("pulse: parse daily thread json: {error}"))?;
    if let Some(thread) = parsed
        .into_iter()
        .find(|thread| thread.title.contains(&date))
    {
        return Ok((thread.url, thread.number, false));
    }
    let title = format!("📅 {label} Daily Thread");
    let url = pulse_command_stdout(
        "gh",
        &[
            "issue".to_owned(),
            "create".to_owned(),
            "--repo".to_owned(),
            repo.to_owned(),
            "-t".to_owned(),
            title,
            "-b".to_owned(),
            format!("Tasks for {label}"),
            "-l".to_owned(),
            "daily-thread".to_owned(),
        ],
    )?
    .trim()
    .to_owned();
    Ok((url.clone(), pulse_parse_trailing_number(&url), true))
}

fn pulse_add_task_to_period_comment(
    repo: &str,
    thread_num: u64,
    period: &str,
    issue_num: u64,
    title: &str,
    oracle: Option<&str>,
) -> Result<(), String> {
    let mut comments = pulse_ensure_period_comments(repo, thread_num)?;
    let Some(comment) = comments.remove(period) else {
        return Ok(());
    };
    let oracle_tag = oracle.map_or(String::new(), |value| format!(" → {value}"));
    let task_line = format!(
        "- [ ] #{issue_num} {title} ({}{})",
        pulse_current_hhmm(),
        oracle_tag
    );
    let body = if comment.body.contains("_(no tasks yet)_") {
        comment.body.replace("_(no tasks yet)_", &task_line)
    } else {
        format!("{}\n{task_line}", comment.body)
    };
    pulse_patch_comment(repo, &comment.id, &body)
}

fn pulse_ensure_period_comments(
    repo: &str,
    thread_num: u64,
) -> Result<BTreeMap<String, PulseComment>, String> {
    let raw = pulse_command_stdout(
        "gh",
        &[
            "api".to_owned(),
            format!("repos/{repo}/issues/{thread_num}/comments"),
            "--jq".to_owned(),
            "[.[] | {id: .id, body: .body}]".to_owned(),
        ],
    )?;
    let comments: Vec<PulseComment> = serde_json::from_str(pulse_str_or_default(raw.trim(), "[]"))
        .map_err(|error| format!("pulse: parse comments json: {error}"))?;
    let mut result = BTreeMap::new();
    for (key, label) in pulse_periods() {
        if let Some(comment) = comments
            .iter()
            .find(|comment| comment.body.starts_with(label))
            .cloned()
        {
            result.insert((*key).to_owned(), comment);
        } else {
            let body = format!("{label}\n\n_(no tasks yet)_");
            let id = pulse_command_stdout(
                "gh",
                &[
                    "api".to_owned(),
                    format!("repos/{repo}/issues/{thread_num}/comments"),
                    "-f".to_owned(),
                    format!("body={body}"),
                    "--jq".to_owned(),
                    ".id".to_owned(),
                ],
            )?
            .trim()
            .to_owned();
            result.insert(
                (*key).to_owned(),
                PulseComment {
                    id: serde_json::Value::String(id),
                    body,
                },
            );
        }
    }
    Ok(result)
}

fn pulse_sync_daily_thread(
    repo: &str,
    projects: &[PulseIssue],
    tools: &[PulseIssue],
    active: &[PulseIssue],
    threads: &[PulseIssue],
) -> Result<String, String> {
    let date = pulse_today_date();
    let Some(thread) = threads.iter().find(|thread| thread.title.contains(&date)) else {
        return Ok("No daily thread found for today\n".to_owned());
    };
    let mut lines = vec![
        format!("## 📋 Pulse Board Index ({})", pulse_today_label()),
        String::new(),
    ];
    pulse_push_sync_section(&mut lines, "Projects", projects, false);
    pulse_push_sync_section(&mut lines, "Tools/Infra", tools, false);
    pulse_push_sync_section(&mut lines, "Active Today", active, true);
    lines.push(format!(
        "**{} open** — Homekeeper Oracle 🤖",
        projects.len() + tools.len() + active.len()
    ));
    let body = lines.join("\n");
    let raw = pulse_command_stdout(
        "gh",
        &[
            "api".to_owned(),
            format!("repos/{repo}/issues/{}/comments", thread.number),
            "--jq".to_owned(),
            "[.[] | {id: .id, body: .body}]".to_owned(),
        ],
    )?;
    let comments: Vec<PulseComment> = serde_json::from_str(pulse_str_or_default(raw.trim(), "[]"))
        .map_err(|error| format!("pulse: parse comments json: {error}"))?;
    if let Some(comment) = comments
        .iter()
        .find(|comment| comment.body.contains("Pulse Board Index"))
    {
        pulse_patch_comment(repo, &comment.id, &body)?;
        Ok(format!(
            "\x1b[32m✅\x1b[0m synced to daily thread #{}\n",
            thread.number
        ))
    } else {
        pulse_command_stdout(
            "gh",
            &[
                "api".to_owned(),
                format!("repos/{repo}/issues/{}/comments", thread.number),
                "-f".to_owned(),
                format!("body={body}"),
            ],
        )?;
        Ok(format!(
            "\x1b[32m+\x1b[0m index posted to daily thread #{}\n",
            thread.number
        ))
    }
}

fn pulse_patch_comment(repo: &str, id: &serde_json::Value, body: &str) -> Result<(), String> {
    let id = match id {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) => value.to_string(),
        _ => return Err("pulse: invalid comment id".to_owned()),
    };
    pulse_validate_target_arg(&id, "comment id")?;
    pulse_command_stdout(
        "gh",
        &[
            "api".to_owned(),
            format!("repos/{repo}/issues/comments/{id}"),
            "-X".to_owned(),
            "PATCH".to_owned(),
            "-f".to_owned(),
            format!("body={body}"),
        ],
    )?;
    Ok(())
}

fn pulse_push_sync_section(
    lines: &mut Vec<String>,
    title: &str,
    issues: &[PulseIssue],
    active: bool,
) {
    if issues.is_empty() {
        return;
    }
    lines.push(format!("### {title} ({})", issues.len()));
    lines.push(String::new());
    let mut sorted = issues.to_vec();
    sorted.sort_by_key(|issue| issue.number);
    for issue in sorted {
        let suffix = if active { " 🟡" } else { "" };
        lines.push(format!(
            "- [ ] #{} {} → {}{suffix}",
            issue.number,
            issue.title,
            pulse_issue_oracle(&issue)
        ));
    }
    lines.push(String::new());
}

fn pulse_scan_worktrees() -> Result<Vec<PulseWorktree>, String> {
    let repos_root =
        host_path("repos").ok_or_else(|| "pulse: repos path is unavailable".to_owned())?;
    let mut worktrees = Vec::new();
    pulse_collect_worktree_dirs(&repos_root, &repos_root, 0, &mut worktrees)?;
    let windows = pulse_tmux_window_names();
    let mut out = Vec::new();
    for path in worktrees {
        if let Some(mut parsed) = pulse_parse_worktree_path(&repos_root, &path) {
            parsed.branch = pulse_git_branch(&parsed.path).unwrap_or_else(|| "unknown".to_owned());
            parsed.status = if windows.contains(&parsed.name)
                || windows.iter().any(|window| window.contains(&parsed.name))
            {
                PulseWorktreeStatus::Active
            } else {
                PulseWorktreeStatus::Stale
            };
            out.push(parsed);
        }
    }
    for main_repo in out
        .iter()
        .map(|worktree| worktree.main_path.clone())
        .collect::<BTreeSet<_>>()
    {
        for orphan in pulse_prunable_worktrees(&main_repo) {
            if let Some(existing) = out.iter_mut().find(|worktree| worktree.path == orphan) {
                existing.status = PulseWorktreeStatus::Orphan;
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    Ok(out)
}

fn pulse_collect_worktree_dirs(
    root: &Path,
    current: &Path,
    depth: usize,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > 4 {
        return Ok(());
    }
    for path in host_list_dirs(current) {
        let name = path
            .file_name()
            .map_or_else(String::new, |value| value.to_string_lossy().into_owned());
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        if name.contains(".wt-")
            || (rel.len() >= 4 && rel.get(rel.len() - 2).is_some_and(|part| part == "agents"))
        {
            out.push(path.clone());
        }
        pulse_collect_worktree_dirs(root, &path, depth + 1, out)?;
    }
    Ok(())
}

fn pulse_parse_worktree_path(
    repos_root: &std::path::Path,
    path: &std::path::Path,
) -> Option<PulseWorktree> {
    let parts = path
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if parts.len() >= 4 && parts[parts.len() - 2] == "agents" {
        let org = &parts[parts.len() - 4];
        let repo_name = &parts[parts.len() - 3];
        let main_repo = format!("{org}/{repo_name}");
        let repo = main_repo.clone();
        let name = parts.last()?.clone();
        return Some(PulseWorktree {
            path: path.to_path_buf(),
            branch: String::new(),
            repo,
            main_repo,
            main_path: repos_root.join(org).join(repo_name),
            name,
            status: PulseWorktreeStatus::Stale,
        });
    }
    let dir = path.file_name()?.to_string_lossy();
    let (main_name, name) = dir.split_once(".wt-")?;
    let org = path.parent()?.file_name()?.to_string_lossy().into_owned();
    let main_repo = format!("{org}/{main_name}");
    Some(PulseWorktree {
        path: path.to_path_buf(),
        branch: String::new(),
        repo: format!("{org}/{dir}"),
        main_repo,
        main_path: repos_root.join(org).join(main_name),
        name: name.to_owned(),
        status: PulseWorktreeStatus::Stale,
    })
}

fn pulse_git_branch(path: &std::path::Path) -> Option<String> {
    pulse_validate_path_arg(&path.display().to_string(), "worktree path").ok()?;
    let args = ["-C", path.to_str()?, "rev-parse", "--abbrev-ref", "HEAD"].map(ToOwned::to_owned);
    pulse_exec("git", &args, true)
        .ok()
        .filter(|out| out.status == 0)
        .map(|out| out.stdout.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn pulse_prunable_worktrees(main_path: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Some(path) = main_path.to_str() else {
        return Vec::new();
    };
    if pulse_validate_path_arg(path, "main repo path").is_err() {
        return Vec::new();
    }
    let args = ["-C", path, "worktree", "list", "--porcelain"].map(ToOwned::to_owned);
    let Ok(output) = pulse_exec("git", &args, true) else {
        return Vec::new();
    };
    if output.status != 0 {
        return Vec::new();
    }
    let mut current = None::<std::path::PathBuf>;
    let mut out = Vec::new();
    for line in output.stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current = Some(std::path::PathBuf::from(path));
        }
        if line == "prunable" {
            if let Some(path) = current.take() {
                out.push(path);
            }
        }
    }
    out
}

fn pulse_cleanup_worktree(worktree: &PulseWorktree) -> Result<Vec<String>, String> {
    pulse_validate_path_arg(&worktree.path.display().to_string(), "worktree path")?;
    pulse_validate_path_arg(&worktree.main_path.display().to_string(), "main repo path")?;
    if worktree.branch.starts_with('-') {
        return Err("pulse: branch must not start with '-'".to_owned());
    }
    let mut log = Vec::new();
    let main = worktree
        .main_path
        .to_str()
        .ok_or_else(|| "pulse: non-utf8 main repo path".to_owned())?;
    let wt = worktree
        .path
        .to_str()
        .ok_or_else(|| "pulse: non-utf8 worktree path".to_owned())?;
    let remove_args = ["-C", main, "worktree", "remove", wt, "--force"].map(ToOwned::to_owned);
    match pulse_exec("git", &remove_args, true) {
        Ok(output) if output.status == 0 => log.push(format!(
            "removed worktree {}",
            worktree
                .path
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .unwrap_or(&worktree.name)
        )),
        Ok(output) => log.push(format!("worktree remove failed: {}", output.stderr.trim())),
        Err(error) => log.push(format!("worktree remove failed: {error}")),
    }
    let prune_args = ["-C", main, "worktree", "prune"].map(ToOwned::to_owned);
    let _ = pulse_exec("git", &prune_args, true);
    if !matches!(
        worktree.branch.as_str(),
        "" | "main" | "HEAD" | "unknown" | "(prunable)"
    ) {
        let branch_args = ["-C", main, "branch", "-d", &worktree.branch].map(ToOwned::to_owned);
        let _ = pulse_exec("git", &branch_args, true);
        log.push(format!("deleted branch {}", worktree.branch));
    }
    let _ = &worktree.repo;
    Ok(log)
}

fn pulse_tmux_window_names() -> BTreeSet<String> {
    let response = host_call(maw_tmux_list_sessions, "{}".to_owned());
    host_value(&response)
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|session| session.get("windows").and_then(Value::as_array))
        .flatten()
        .filter_map(|window| window.get("name").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect()
}

fn pulse_command_stdout(program: &str, args: &[String]) -> Result<String, String> {
    pulse_validate_exec_name(program)?;
    let output = pulse_exec(program, args, false)?;
    if output.status == 0 {
        Ok(output.stdout)
    } else {
        let stderr = output.stderr.trim().to_owned();
        Err(if stderr.is_empty() {
            format!("{program} exited {}", output.status)
        } else {
            stderr
        })
    }
}

fn pulse_repo(context: &Context) -> Result<String, String> {
    let repo = context
        .pulse_repo
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| PULSE_DEFAULT_REPO.to_owned());
    pulse_validate_repo_arg(&repo)?;
    Ok(repo)
}

fn pulse_validate_repo_arg(value: &str) -> Result<(), String> {
    let Some((owner, name)) = value.split_once('/') else {
        return Err("pulse: MAW_PULSE_REPO must be owner/repo".to_owned());
    };
    let safe = |part: &str| {
        !part.is_empty()
            && !part.starts_with('-')
            && part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    };
    if value.trim() != value || name.contains('/') || !safe(owner) || !safe(name) {
        Err("pulse: MAW_PULSE_REPO must be owner/repo with safe GitHub name characters".to_owned())
    } else {
        Ok(())
    }
}

fn pulse_validate_exec_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.starts_with('-')
        || value.contains('/')
        || value.chars().any(char::is_control)
    {
        Err("pulse: executable name is not allowed".to_owned())
    } else {
        Ok(())
    }
}

fn pulse_validate_target_arg(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.starts_with('-')
        || value.chars().any(char::is_control)
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ':' | '/'))
    {
        Err(format!("pulse: {label} must be non-empty, unpadded, not start with '-', and contain only safe target characters"))
    } else {
        Ok(())
    }
}

fn pulse_validate_path_arg(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.starts_with('-')
        || value.chars().any(char::is_control)
        || value.split('/').any(|part| part == "..")
    {
        Err(format!("pulse: {label} must be non-empty, unpadded, not start with '-', and contain no '..' segments"))
    } else {
        Ok(())
    }
}

fn pulse_parse_trailing_number(value: &str) -> u64 {
    value
        .rsplit('/')
        .next()
        .and_then(|tail| tail.parse::<u64>().ok())
        .unwrap_or(0)
}

fn pulse_periods() -> &'static [(&'static str, &'static str)] {
    &[
        ("morning", "🌅 Morning (06:00-12:00)"),
        ("afternoon", "☀️ Afternoon (12:00-18:00)"),
        ("evening", "🌆 Evening (18:00-24:00)"),
        ("midnight", "🌙 Midnight (00:00-06:00)"),
    ]
}

fn pulse_status_name(status: PulseWorktreeStatus) -> &'static str {
    match status {
        PulseWorktreeStatus::Active => "active",
        PulseWorktreeStatus::Stale => "stale",
        PulseWorktreeStatus::Orphan => "orphan",
    }
}

fn pulse_time_period() -> String {
    let hour = pulse_current_hour();
    if (6..12).contains(&hour) {
        "morning"
    } else if (12..18).contains(&hour) {
        "afternoon"
    } else if hour >= 18 {
        "evening"
    } else {
        "midnight"
    }
    .to_owned()
}

fn pulse_today_date() -> String {
    pulse_date_output("+%Y-%m-%d").unwrap_or_else(|| "1970-01-01".to_owned())
}

fn pulse_today_label() -> String {
    let date = pulse_today_date();
    let day = match pulse_date_output("+%w").as_deref() {
        Some("0") => "อาทิตย์",
        Some("1") => "จันทร์",
        Some("2") => "อังคาร",
        Some("3") => "พุธ",
        Some("4") => "พฤหัสบดี",
        Some("5") => "ศุกร์",
        Some("6") => "เสาร์",
        _ => "?",
    };
    format!("{date} ({day})")
}

fn pulse_current_hhmm() -> String {
    pulse_date_output("+%H:%M").unwrap_or_else(|| "00:00".to_owned())
}

fn pulse_current_hour() -> u32 {
    pulse_date_output("+%H")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn pulse_date_output(format: &str) -> Option<String> {
    let output = pulse_exec("date", &[format.to_owned()], false).ok()?;
    (output.status == 0).then(|| output.stdout.trim().to_owned())
}

fn pulse_truncate_chars(value: &str, width: usize) -> String {
    value.chars().take(width).collect()
}

fn pulse_pad_end(value: &str, width: usize) -> String {
    let len = value.chars().count();
    if len >= width {
        value.to_owned()
    } else {
        format!("{value}{}", " ".repeat(width - len))
    }
}

fn pulse_str_or_default<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() {
        fallback
    } else {
        value
    }
}

#[cfg(test)]
mod pulse_tests {
    use super::*;

    fn pulse_strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn pulse_add_parser_matches_plugin_flags_and_guards_targets() {
        let parsed = pulse_parse_add_args(&pulse_strings(&[
            "ship native",
            "--oracle",
            "nova",
            "--priority=P1",
            "--worktree",
            "repo/task",
        ]))
        .expect("parse");
        assert_eq!(parsed.title, "ship native");
        assert_eq!(parsed.oracle.as_deref(), Some("nova"));
        assert_eq!(parsed.priority.as_deref(), Some("P1"));
        assert_eq!(parsed.wt.as_deref(), Some("repo/task"));
        assert!(pulse_parse_add_args(&pulse_strings(&["ship", "--oracle", "-bad"])).is_err());
        assert!(pulse_parse_add_args(&pulse_strings(&["ship", "--wt", "../bad"])).is_err());
    }

    #[test]
    fn pulse_board_renderer_matches_maw_js_sections() {
        let issues = vec![
            PulseIssue {
                number: 10,
                title: "📅 2026-06-25 Daily Thread".to_owned(),
                labels: vec![PulseLabel {
                    name: "daily-thread".to_owned(),
                }],
            },
            PulseIssue {
                number: 11,
                title: "P001 launch board".to_owned(),
                labels: vec![PulseLabel {
                    name: "oracle:nova".to_owned(),
                }],
            },
            PulseIssue {
                number: 9,
                title: "old tool".to_owned(),
                labels: vec![],
            },
            PulseIssue {
                number: 13,
                title: "fresh task".to_owned(),
                labels: vec![PulseLabel {
                    name: "oracle:pulse".to_owned(),
                }],
            },
        ];
        let (projects, tools, active, threads) = pulse_categorize_issues(&issues);
        let stdout = pulse_render_board(&projects, &tools, &active, issues.len() - threads.len());
        assert!(stdout.contains("Projects (1)"));
        assert!(stdout.contains("Tools/Infra (1)"));
        assert!(stdout.contains("Active Today (1)"));
        assert!(stdout.contains("#13 fresh task → pulse"));
        assert!(stdout.contains("3 open"));
    }

    #[test]
    fn pulse_worktree_parser_tolerates_canonicalized_host_paths() {
        let root = Path::new("/var/tmp/repos");
        let canonical = Path::new("/private/var/tmp/repos/acme/widgets/agents/1-old");
        let parsed = pulse_parse_worktree_path(root, canonical).expect("worktree");
        assert_eq!(parsed.main_repo, "acme/widgets");
        assert_eq!(parsed.name, "1-old");
        assert_eq!(parsed.main_path, root.join("acme/widgets"));
    }
}
