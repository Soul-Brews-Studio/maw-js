#![allow(clippy::missing_panics_doc)]
use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::{Path, PathBuf};

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.paths.get"]
    fn maw_paths_get(input: u64) -> u64;
    #[link_name = "maw.fs.list"]
    fn maw_fs_list(input: u64) -> u64;
    #[link_name = "maw.fs.stat"]
    fn maw_fs_stat(input: u64) -> u64;
    #[link_name = "maw.fs.read"]
    fn maw_fs_read(input: u64) -> u64;
    #[link_name = "maw.fs.write"]
    fn maw_fs_write(input: u64) -> u64;
    #[link_name = "maw.exec.run"]
    fn maw_exec_run(input: u64) -> u64;
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
fn value(v: &Value) -> &Value {
    v.get("value").unwrap_or(v)
}
fn host_path(name: &str) -> PathBuf {
    let v = host_call(maw_paths_get, json!({"name":name}).to_string());
    value(&v)
        .get("path")
        .and_then(Value::as_str)
        .map_or_else(PathBuf::new, PathBuf::from)
}
fn host_list(path: &Path, kind: &str) -> Vec<PathBuf> {
    let v = host_call(
        maw_fs_list,
        json!({"path":path,"includeDirs":true,"maxEntries":1000}).to_string(),
    );
    value(&v)
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| e.get("kind").and_then(Value::as_str) == Some(kind))
        .filter_map(|e| e.get("path").and_then(Value::as_str).map(PathBuf::from))
        .collect()
}
fn host_is_dir(path: &Path) -> bool {
    let v = host_call(maw_fs_stat, json!({"path":path}).to_string());
    value(&v).get("kind").and_then(Value::as_str) == Some("dir")
}
fn host_read(path: impl AsRef<Path>) -> Option<String> {
    let v = host_call(
        maw_fs_read,
        json!({"path":path.as_ref(),"maxBytes":10485760u64}).to_string(),
    );
    value(&v)
        .get("content")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
fn host_write(path: &Path, content: &str) -> Result<(), String> {
    let v = host_call(
        maw_fs_write,
        json!({"path":path,"content":content,"mkdirp":true}).to_string(),
    );
    if v.get("ok").and_then(Value::as_bool) == Some(false) {
        Err(v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("write failed")
            .to_owned())
    } else {
        Ok(())
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    args: Vec<String>,
    cwd: Option<String>,
}
thread_local! { static CONTEXT: RefCell<Context> = RefCell::new(Context::default()); }
fn context() -> Context {
    CONTEXT.with(|c| c.borrow().clone())
}
fn dream_cwd() -> PathBuf {
    context()
        .cwd
        .map_or_else(|| host_path("cwd"), PathBuf::from)
}
fn dream_repos_root() -> PathBuf {
    host_path("repos")
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let ctx = serde_json::from_str::<Context>(&input).unwrap_or_default();
    let args = ctx.args.clone();
    CONTEXT.with(|c| *c.borrow_mut() = ctx);
    Ok(match dream_run(&args) {
        Ok(output) => json!({"ok":true,"output":output}),
        Err(error) => json!({"ok":false,"error":error}),
    }
    .to_string())
}
const DREAM_USAGE: &str = "usage: maw dream [--pain|--plan|--gain|--all|--speculate|--between] [--project <name>|--repo <slug>] [--json|--porcelain|--oneline] [--limit <n>]";
const DREAM_CATEGORIES: [&str; 6] = ["pain", "plan", "gain", "lost", "memory", "feeling"];

#[derive(Debug, Clone, Default)]
#[allow(clippy::struct_excessive_bools)]
struct DreamOptions {
    pain: bool,
    plan: bool,
    gain: bool,
    all: bool,
    speculate: bool,
    between: bool,
    json: bool,
    porcelain: bool,
    oneline: bool,
    limit: usize,
    project: Option<String>,
    repo: Option<String>,
    since: Option<String>,
    date: Option<String>,
    format: Option<String>,
    state: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
struct DreamRepo {
    name: String,
    dir_name: String,
    owner: String,
    slug: String,
    path: String,
    last_commit_msg: String,
    last_commit_date: String,
    stale_days: i64,
    uncommitted_files: usize,
    orphaned_worktrees: usize,
    recent_handoff: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
struct DreamItem {
    category: String,
    title: String,
    detail: String,
    source: String,
    project: String,
    confidence: String,
    days_ago: i64,
    action: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct DreamReport {
    date: String,
    repo_count: usize,
    oracle_kb: String,
    items: Vec<DreamItem>,
    insights: Vec<String>,
    saved: Option<String>,
    speculations: Option<String>,
}

fn dream_run(argv: &[String]) -> Result<String, String> {
    let opts = dream_parse_args(argv)?;
    if opts.speculate {
        return dream_speculate_existing(&opts);
    }
    let mut repos = dream_scan_repo_states(&opts);
    dream_filter_repos(&mut repos, &opts);
    let mut items = dream_classify_repos(&repos, &opts);
    dream_sort_items(&mut items);
    if opts.limit > 0 && !opts.all {
        items.truncate(opts.limit);
    }
    let insights = dream_generate_insights(&items, &repos);
    let date = dream_today(&opts);
    let saved = if opts.porcelain {
        None
    } else {
        Some(dream_save_report(
            &date,
            &items,
            &insights,
            repos.len(),
            &opts,
        )?)
    };
    let speculations = if opts.between {
        Some(dream_write_speculations(&date, &items, &repos)?)
    } else {
        None
    };
    let report = DreamReport {
        date,
        repo_count: repos.len(),
        oracle_kb: "offline".to_owned(),
        items,
        insights,
        saved,
        speculations,
    };
    dream_render_report(&report, &opts)
}

fn dream_parse_args(argv: &[String]) -> Result<DreamOptions, String> {
    let mut opts = DreamOptions {
        limit: 12,
        ..DreamOptions::default()
    };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--help" | "-h" => return Err(DREAM_USAGE.to_owned()),
            "--pain" => opts.pain = true,
            "--plan" => opts.plan = true,
            "--gain" => opts.gain = true,
            "--all" => opts.all = true,
            "--speculate" => opts.speculate = true,
            "--between" => opts.between = true,
            "--json" => opts.json = true,
            "--porcelain" => opts.porcelain = true,
            "--oneline" => opts.oneline = true,
            "--project" | "-p" => {
                i += 1;
                opts.project = Some(dream_required(argv, i, "--project")?);
            }
            "--repo" => {
                i += 1;
                opts.repo = Some(dream_required(argv, i, "--repo")?);
            }
            "--limit" => {
                i += 1;
                opts.limit = dream_parse_limit(&dream_required(argv, i, "--limit")?)?;
            }
            "--since" => {
                i += 1;
                opts.since = Some(dream_required(argv, i, "--since")?);
            }
            "--date" => {
                i += 1;
                opts.date = Some(dream_required(argv, i, "--date")?);
            }
            "--format" => {
                i += 1;
                opts.format = Some(dream_required(argv, i, "--format")?);
            }
            "--state" => {
                i += 1;
                opts.state = Some(dream_required(argv, i, "--state")?);
            }
            value if value.starts_with("--project=") => {
                opts.project = Some(dream_validate_value(&value[10..], "--project")?)
            }
            value if value.starts_with('-') => {
                return Err(format!("dream: unknown argument {value}"))
            }
            value => return Err(format!("dream: unknown argument {value}")),
        }
        i += 1;
    }
    Ok(opts)
}

fn dream_required(argv: &[String], index: usize, flag: &str) -> Result<String, String> {
    let value = argv
        .get(index)
        .ok_or_else(|| format!("dream: {flag} requires a value"))?;
    dream_validate_value(value, flag)
}

fn dream_validate_value(value: &str, flag: &str) -> Result<String, String> {
    if value.is_empty() || value.starts_with('-') {
        return Err(format!("dream: {flag} requires a value"));
    }
    if value.contains('\0') || value.contains('\n') || value.contains('\r') {
        return Err(format!("dream: invalid value for {flag}"));
    }
    Ok(value.to_owned())
}

fn dream_parse_limit(value: &str) -> Result<usize, String> {
    let n = value
        .parse::<usize>()
        .map_err(|_| "dream: --limit requires a positive integer".to_owned())?;
    if n == 0 || n > 100 {
        return Err("dream: --limit must be between 1 and 100".to_owned());
    }
    Ok(n)
}

fn dream_scan_repo_states(opts: &DreamOptions) -> Vec<DreamRepo> {
    let mut paths = Vec::new();
    dream_add_ghq_repo_paths(&mut paths);
    let now_days = dream_now_days(opts);
    let mut repos = Vec::new();
    for path in paths {
        if !host_is_dir(&path) || !dream_safe_path(&path) {
            continue;
        }
        repos.push(dream_repo_state(&path, now_days));
    }
    repos.sort_by(|a, b| a.stale_days.cmp(&b.stale_days).then(a.name.cmp(&b.name)));
    repos
}

fn dream_add_ghq_repo_paths(paths: &mut Vec<std::path::PathBuf>) {
    let root = dream_repos_root();
    let mut seen = paths
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    for owner in host_list(&root, "dir") {
        for repo in host_list(&owner, "dir") {
            if host_is_dir(&repo.join("ψ")) && seen.insert(repo.clone()) {
                paths.push(repo);
            }
        }
    }
}

fn dream_repo_state(path: &std::path::Path, now_days: i64) -> DreamRepo {
    let dir_name = path
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or_default()
        .to_owned();
    let name = dir_name
        .strip_suffix("-oracle")
        .unwrap_or(&dir_name)
        .to_owned();
    let owner = path
        .parent()
        .and_then(std::path::Path::file_name)
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("unknown")
        .to_owned();
    let slug = format!("{owner}/{dir_name}");
    let (last_commit_msg, last_commit_date, stale_days) = dream_git_last_commit(path, now_days);
    let uncommitted_files = dream_git_status_count(path);
    let orphaned_worktrees = dream_git_worktree_count(path).saturating_sub(1);
    let recent_handoff = dream_latest_file(&path.join("ψ/inbox/handoff"), 7);
    DreamRepo {
        name,
        dir_name,
        owner,
        slug,
        path: path.display().to_string(),
        last_commit_msg,
        last_commit_date,
        stale_days,
        uncommitted_files,
        orphaned_worktrees,
        recent_handoff,
    }
}

fn dream_git_last_commit(path: &std::path::Path, now_days: i64) -> (String, String, i64) {
    let msg = dream_git(path, &["log", "-1", "--format=%s"]).unwrap_or_default();
    let ts = dream_git(path, &["log", "-1", "--format=%ct"])
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(0);
    if ts <= 0 {
        return (msg.trim().to_owned(), "unknown".to_owned(), 999);
    }
    let days = ts / 86_400;
    (
        msg.trim().to_owned(),
        dream_date_from_days(days),
        now_days.saturating_sub(days),
    )
}

fn dream_git_status_count(path: &std::path::Path) -> usize {
    dream_git(path, &["status", "--porcelain"]).map_or(0, |out| {
        out.lines().filter(|line| !line.trim().is_empty()).count()
    })
}

fn dream_git_worktree_count(path: &std::path::Path) -> usize {
    dream_git(path, &["worktree", "list", "--porcelain"]).map_or(1, |out| {
        out.split("\n\n")
            .filter(|chunk| chunk.contains("worktree ") && !chunk.contains("bare"))
            .count()
    })
}

fn dream_git(path: &std::path::Path, args: &[&str]) -> Option<String> {
    if !dream_safe_path(path) {
        return None;
    }
    let v = host_call(
        maw_exec_run,
        json!({"cmd":"git","cwd":path,"args":args}).to_string(),
    );
    let out = value(&v);
    (out.get("status").and_then(Value::as_i64) == Some(0)).then(|| {
        out.get("stdout")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    })
}

fn dream_safe_path(_path: &std::path::Path) -> bool {
    true
}

fn dream_filter_repos(repos: &mut Vec<DreamRepo>, opts: &DreamOptions) {
    if let Some(project) = &opts.project {
        repos.retain(|repo| dream_matches_project(repo, project));
    }
    if let Some(slug) = &opts.repo {
        repos.retain(|repo| repo.slug == *slug || repo.name == *slug || repo.dir_name == *slug);
    }
    if let Some(state) = &opts.state {
        dream_filter_state(repos, state);
    }
}

fn dream_matches_project(repo: &DreamRepo, project: &str) -> bool {
    let needle = project.to_lowercase().replace("-oracle", "");
    let name = repo.name.to_lowercase();
    let dir = repo.dir_name.to_lowercase().replace("-oracle", "");
    name == needle || dir == needle || name.contains(&needle) || needle.contains(&name)
}

fn dream_filter_state(repos: &mut Vec<DreamRepo>, state: &str) {
    match state {
        "active" => repos.retain(|repo| repo.stale_days < 14),
        "stale" | "lost" => repos.retain(|repo| repo.stale_days > 90),
        "dirty" => repos.retain(|repo| repo.uncommitted_files > 0),
        _ => {}
    }
}

fn dream_classify_repos(repos: &[DreamRepo], opts: &DreamOptions) -> Vec<DreamItem> {
    let mut items = Vec::new();
    for repo in repos {
        dream_push_repo_items(&mut items, repo, opts);
        if let Some(path) = &repo.recent_handoff {
            dream_push_handoff_items(&mut items, repo, path);
        }
    }
    dream_deduplicate(items)
}

fn dream_push_repo_items(items: &mut Vec<DreamItem>, repo: &DreamRepo, opts: &DreamOptions) {
    let focused = opts.pain || opts.plan || opts.gain;
    if (!focused || opts.pain) && repo.uncommitted_files > 5 {
        items.push(dream_item(
            "pain",
            repo,
            format!(
                "{} — {} uncommitted files",
                repo.name, repo.uncommitted_files
            ),
            format!("Last: \"{}\"", repo.last_commit_msg),
            Some(format!("cd {} && git status", repo.path)),
            0,
        ));
    }
    if (!focused || opts.pain) && repo.orphaned_worktrees > 0 {
        items.push(dream_item(
            "pain",
            repo,
            format!(
                "{} — {} orphaned worktree(s)",
                repo.name, repo.orphaned_worktrees
            ),
            "Worktrees without active windows — run maw done or git worktree prune".to_owned(),
            Some(format!("git -C {} worktree list", repo.path)),
            0,
        ));
    }
    if (!focused || opts.gain) && repo.stale_days <= 7 && !repo.last_commit_msg.is_empty() {
        items.push(dream_item(
            "gain",
            repo,
            format!("{} — {}", repo.name, repo.last_commit_msg),
            format!("Last commit: {}", repo.last_commit_date),
            None,
            repo.stale_days,
        ));
    }
    if (!focused || opts.plan) && repo.recent_handoff.is_some() {
        items.push(dream_item(
            "plan",
            repo,
            format!("{} — handoff ready", repo.name),
            "Recent ψ/inbox/handoff file found".to_owned(),
            Some(format!("maw workon {}", repo.name)),
            repo.stale_days,
        ));
    }
    if repo.stale_days > 90 {
        items.push(dream_item(
            "lost",
            repo,
            format!("{} — silent {}d", repo.name, repo.stale_days),
            format!(
                "Last: {} — \"{}\"",
                repo.last_commit_date, repo.last_commit_msg
            ),
            None,
            repo.stale_days,
        ));
    }
}

fn dream_item(
    category: &str,
    repo: &DreamRepo,
    title: String,
    detail: String,
    action: Option<String>,
    days_ago: i64,
) -> DreamItem {
    DreamItem {
        category: category.to_owned(),
        title,
        detail,
        source: repo.path.clone(),
        project: repo.name.clone(),
        confidence: dream_confidence(category).to_owned(),
        days_ago,
        action,
    }
}

fn dream_confidence(category: &str) -> &str {
    match category {
        "pain" | "gain" | "lost" => "high",
        "plan" => "medium",
        _ => "low",
    }
}

fn dream_push_handoff_items(items: &mut Vec<DreamItem>, repo: &DreamRepo, path: &str) {
    let Some(text) = host_read(path) else {
        return;
    };
    for line in text.lines().filter_map(dream_parse_handoff_line).take(5) {
        items.push(DreamItem {
            category: "plan".to_owned(),
            title: line,
            detail: "Soon: handoff pending".to_owned(),
            source: path.to_owned(),
            project: repo.name.clone(),
            confidence: "high".to_owned(),
            days_ago: repo.stale_days,
            action: Some(format!("maw workon {}", repo.name)),
        });
    }
}

fn dream_parse_handoff_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix("- [ ]") {
        return Some(rest.trim().chars().take(100).collect());
    }
    if trimmed.starts_with('|') && !trimmed.contains("---") && !trimmed.contains("Priority") {
        return trimmed
            .split('|')
            .nth(2)
            .map(|v| v.trim().chars().take(100).collect())
            .filter(|v: &String| !v.is_empty());
    }
    None
}

fn dream_deduplicate(items: Vec<DreamItem>) -> Vec<DreamItem> {
    let mut seen = std::collections::BTreeSet::new();
    items
        .into_iter()
        .filter(|item| {
            seen.insert(format!(
                "{}:{}:{}",
                item.category,
                item.project,
                item.title.to_lowercase()
            ))
        })
        .collect()
}

fn dream_sort_items(items: &mut [DreamItem]) {
    items.sort_by(|a, b| {
        dream_category_rank(&a.category)
            .cmp(&dream_category_rank(&b.category))
            .then(a.days_ago.cmp(&b.days_ago))
            .then(a.title.cmp(&b.title))
    });
}

fn dream_category_rank(category: &str) -> usize {
    DREAM_CATEGORIES
        .iter()
        .position(|value| *value == category)
        .unwrap_or(99)
}

fn dream_generate_insights(items: &[DreamItem], repos: &[DreamRepo]) -> Vec<String> {
    let active = repos.iter().filter(|repo| repo.stale_days < 7).count();
    let stale = repos.iter().filter(|repo| repo.stale_days > 90).count();
    let dirty = repos
        .iter()
        .filter(|repo| repo.uncommitted_files > 5)
        .count();
    let mut insights = vec![format!("Active: {active} repos touched this week")];
    if stale > 0 {
        insights.push(format!("Forgotten: {stale} repos silent >90d"));
    }
    if dirty > 0 {
        insights.push(format!(
            "At risk: {dirty} repos have large uncommitted sets"
        ));
    }
    let plans = items.iter().filter(|item| item.category == "plan").count();
    if plans > 0 {
        insights.push(format!("Plans: {plans} handoff signal(s) found"));
    }
    insights
}

fn dream_render_report(report: &DreamReport, opts: &DreamOptions) -> Result<String, String> {
    if opts.json {
        return serde_json::to_string_pretty(report)
            .map(|value| format!("{value}\n"))
            .map_err(|error| error.to_string());
    }
    if opts.porcelain {
        return Ok(dream_render_porcelain(report));
    }
    if opts.oneline {
        return Ok(dream_render_oneline(report));
    }
    Ok(dream_render_text(report, opts))
}

fn dream_render_porcelain(report: &DreamReport) -> String {
    report
        .items
        .iter()
        .map(|item| {
            format!(
                "{}\t{}\t{}\t{}",
                item.category, item.project, item.days_ago, item.title
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn dream_render_oneline(report: &DreamReport) -> String {
    format!(
        "dream {} repos={} items={} kb={}\n",
        report.date,
        report.repo_count,
        report.items.len(),
        report.oracle_kb
    )
}

fn dream_render_text(report: &DreamReport, opts: &DreamOptions) -> String {
    use std::fmt::Write as _;
    let mut out = format!(
        "\n  \x1b[35m☾\x1b[0m \x1b[1mDream\x1b[0m — {}\n\n  \x1b[90mdreaming...\x1b[0m\n",
        report.date
    );
    for category in DREAM_CATEGORIES {
        dream_push_category_text(&mut out, category, &report.items, opts);
    }
    for insight in &report.insights {
        let _ = writeln!(out, "  \x1b[33m💡\x1b[0m {insight}");
    }
    let _ = writeln!(
        out,
        "\n  \x1b[90m📊 {} repos | oracle KB {}\x1b[0m",
        report.repo_count, report.oracle_kb
    );
    if let Some(saved) = &report.saved {
        let _ = writeln!(out, "  \x1b[32m✓\x1b[0m saved → {saved}");
    }
    if let Some(path) = &report.speculations {
        let _ = writeln!(out, "  \x1b[32m✓\x1b[0m speculations → {path}");
    }
    out.push('\n');
    out
}

fn dream_push_category_text(
    out: &mut String,
    category: &str,
    items: &[DreamItem],
    opts: &DreamOptions,
) {
    use std::fmt::Write as _;
    let focused = opts.pain || opts.plan || opts.gain;
    if focused && !dream_category_enabled(category, opts) {
        return;
    }
    let cat_items = items
        .iter()
        .filter(|item| item.category == category)
        .collect::<Vec<_>>();
    if cat_items.is_empty() {
        return;
    }
    let _ = writeln!(
        out,
        "\n  {} \x1b[1m{}\x1b[0m ({})",
        dream_icon(category),
        dream_header(category),
        cat_items.len()
    );
    let limit = if opts.all {
        cat_items.len()
    } else {
        cat_items.len().min(8)
    };
    for item in cat_items.into_iter().take(limit) {
        dream_push_item_text(out, item, opts);
    }
}

fn dream_push_item_text(out: &mut String, item: &DreamItem, opts: &DreamOptions) {
    use std::fmt::Write as _;
    let age = if item.days_ago <= 1 {
        "today".to_owned()
    } else {
        format!("{}d", item.days_ago)
    };
    let _ = writeln!(out, "    ▸ {} \x1b[90m({age})\x1b[0m", item.title);
    if opts.all && !item.detail.is_empty() {
        let _ = writeln!(out, "      \x1b[90m{}\x1b[0m", item.detail);
    }
    if opts.all {
        if let Some(action) = &item.action {
            let _ = writeln!(out, "      \x1b[36m→ {action}\x1b[0m");
        }
    }
}

fn dream_category_enabled(category: &str, opts: &DreamOptions) -> bool {
    matches!(
        (category, opts.pain, opts.plan, opts.gain),
        ("pain", true, _, _) | ("plan", _, true, _) | ("gain", _, _, true)
    )
}

fn dream_icon(category: &str) -> &str {
    match category {
        "pain" => "\x1b[31m●\x1b[0m",
        "plan" => "\x1b[36m●\x1b[0m",
        "gain" => "\x1b[32m●\x1b[0m",
        "lost" => "\x1b[90m●\x1b[0m",
        "memory" => "\x1b[35m●\x1b[0m",
        _ => "\x1b[33m●\x1b[0m",
    }
}

fn dream_header(category: &str) -> &str {
    match category {
        "pain" => "PAIN — blocking or broken",
        "plan" => "PLAN — next steps from retros",
        "gain" => "GAIN — shipped this period",
        "lost" => "LOST — abandoned >90 days",
        "memory" => "MEMORY — patterns that repeat",
        _ => "FEELING — emotional signals",
    }
}

fn dream_save_report(
    date: &str,
    items: &[DreamItem],
    insights: &[String],
    repo_count: usize,
    opts: &DreamOptions,
) -> Result<String, String> {
    let dir = dream_cwd().join("ψ/writing/dreams");
    let suffix = opts.project.as_deref().unwrap_or("dream").replace('/', "_");
    let path = dir.join(format!("{date}_{suffix}.md"));
    let text = dream_markdown(date, items, insights, repo_count);
    host_write(&path, &text)
        .map_err(|error| format!("dream: cannot write {}: {error}", path.display()))?;
    Ok(path.display().to_string())
}

fn dream_markdown(
    date: &str,
    items: &[DreamItem],
    insights: &[String],
    repo_count: usize,
) -> String {
    let mut lines = vec![
        format!("# Dream — {date}"),
        String::new(),
        format!("**Scanned**: {repo_count} repos | **Oracle KB**: offline"),
        String::new(),
    ];
    for category in DREAM_CATEGORIES {
        dream_markdown_category(&mut lines, category, items);
    }
    if !insights.is_empty() {
        lines.push("## Insights".to_owned());
        lines.push(String::new());
        for insight in insights {
            lines.push(format!("- {insight}"));
        }
    }
    lines.join("\n")
}

fn dream_markdown_category(lines: &mut Vec<String>, category: &str, items: &[DreamItem]) {
    let selected = items
        .iter()
        .filter(|item| item.category == category)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return;
    }
    lines.push(format!(
        "## {} ({})",
        dream_header(category),
        selected.len()
    ));
    lines.push(String::new());
    for item in selected {
        lines.push(format!(
            "- **{}** [{}, {}d ago]",
            item.title, item.confidence, item.days_ago
        ));
        if !item.detail.is_empty() {
            lines.push(format!("  {}", item.detail));
        }
    }
    lines.push(String::new());
}

fn dream_write_speculations(
    date: &str,
    items: &[DreamItem],
    repos: &[DreamRepo],
) -> Result<String, String> {
    let dir = dream_cwd().join("ψ/memory/morpheus");
    let path = dir.join(format!("{date}_speculations.md"));
    let mut lines = vec![
        "# Morpheus — Speculations".to_owned(),
        String::new(),
        "## Likely next session".to_owned(),
        String::new(),
    ];
    for repo in repos.iter().filter(|repo| repo.stale_days < 3).take(5) {
        lines.push(format!(
            "- [HIGH] {} — last: \"{}\"",
            repo.name, repo.last_commit_msg
        ));
    }
    for item in items.iter().filter(|item| item.category == "plan").take(3) {
        lines.push(format!("- [MEDIUM] {}", item.title));
    }
    host_write(&path, &lines.join("\n"))
        .map_err(|error| format!("dream: cannot write {}: {error}", path.display()))?;
    Ok(path.display().to_string())
}

fn dream_speculate_existing(opts: &DreamOptions) -> Result<String, String> {
    let cwd = dream_cwd();
    let mut out =
        "\n  \x1b[35m☾\x1b[0m \x1b[1mMorpheus\x1b[0m — speculating from existing knowledge\n\n"
            .to_owned();
    for (label, dir) in [
        ("Latest dream", cwd.join("ψ/writing/dreams")),
        ("Latest speculation", cwd.join("ψ/memory/morpheus")),
    ] {
        if let Some(path) = dream_latest_file(&dir, 30) {
            out.push_str(&dream_speculate_file(label, &path, opts));
        }
    }
    Ok(out)
}

fn dream_speculate_file(label: &str, path: &str, opts: &DreamOptions) -> String {
    use std::fmt::Write as _;
    if opts.json {
        return format!("{}\n", serde_json::json!({"label":label,"path":path}));
    }
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or(path);
    let mut out = format!("  \x1b[36m{label}:\x1b[0m \x1b[90m{name}\x1b[0m\n");
    if let Some(text) = host_read(path) {
        for line in text.lines().filter(|line| line.starts_with("- ")).take(5) {
            let _ = writeln!(out, "    {line}");
        }
    }
    out.push('\n');
    out
}

fn dream_latest_file(dir: &std::path::Path, _max_days_old: i64) -> Option<String> {
    let mut files = host_list(dir, "file")
        .into_iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .collect::<Vec<_>>();
    files.sort();
    files.pop().map(|path| path.display().to_string())
}

fn dream_today(opts: &DreamOptions) -> String {
    opts.date
        .clone()
        .unwrap_or_else(|| dream_date_from_days(dream_now_days(opts)))
}

fn dream_now_days(opts: &DreamOptions) -> i64 {
    opts.date
        .as_deref()
        .and_then(dream_days_from_date)
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |duration| {
                    i64::try_from(duration.as_secs()).unwrap_or(i64::MAX) / 86_400
                })
        })
}

fn dream_days_from_date(date: &str) -> Option<i64> {
    let mut parts = date.split('-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * shifted_month + 2) / 5 + day - 1;
    Some(era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468)
}

fn dream_date_from_days(days: i64) -> String {
    let (year, month, day) = dream_civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn dream_civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + i64::from(m <= 2), m, d)
}
