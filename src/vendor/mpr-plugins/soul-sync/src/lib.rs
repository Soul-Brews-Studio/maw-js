#![allow(clippy::missing_panics_doc)]

use base64::Engine as _;
use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.paths.get"]
    fn maw_paths_get(input: u64) -> u64;
    #[link_name = "maw.fs.list"]
    fn maw_fs_list(input: u64) -> u64;
    #[link_name = "maw.fs.read"]
    fn maw_fs_read(input: u64) -> u64;
    #[link_name = "maw.fs.write"]
    fn maw_fs_write(input: u64) -> u64;
    #[link_name = "maw.fs.stat"]
    fn maw_fs_stat(input: u64) -> u64;
    #[link_name = "maw.exec.run"]
    fn maw_exec_run(input: u64) -> u64;
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

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    #[serde(default)]
    fleet: Option<Vec<FleetSession>>,
    now: Option<String>,
    repos_root: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
struct FleetSession {
    name: String,
    #[serde(default)]
    windows: Vec<FleetWindow>,
    #[serde(default, alias = "syncPeers")]
    sync_peers: Vec<String>,
    #[serde(default, alias = "projectRepos")]
    project_repos: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
struct FleetWindow {
    #[serde(default)]
    name: String,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    kind: Option<RepoKind>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RepoKind {
    Oracle,
    Project,
}

#[derive(Clone, Debug)]
struct HostEntry {
    path: PathBuf,
    kind: String,
}

struct SystemHost {
    context: Context,
}

impl SystemHost {
    fn new(context: Context) -> Self {
        Self { context }
    }

    fn current_dir(&self) -> PathBuf {
        self.context.cwd.as_deref().map_or_else(
            || host_path("cwd").unwrap_or_else(|| PathBuf::from(".")),
            PathBuf::from,
        )
    }

    fn repos_root(&self) -> PathBuf {
        self.context.repos_root.as_deref().map_or_else(
            || host_path("repos").unwrap_or_else(|| PathBuf::from(".")),
            PathBuf::from,
        )
    }

    fn exec(&self, command: &str, args: &[String], cwd: Option<&Path>) -> Option<String> {
        let response = host_call(
            maw_exec_run,
            json!({
                "cmd": command,
                "args": args,
                "cwd": cwd.map(|path| path.to_string_lossy().into_owned()),
                "timeoutMs": 10_000
            })
            .to_string(),
        );
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        host_value(&response)
            .get("stdout")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned)
    }

    fn git_path(&self, cwd: &Path, flag: &str) -> Option<PathBuf> {
        validate_exec_path(cwd).ok()?;
        self.exec(
            "git",
            &["rev-parse".to_owned(), flag.to_owned(), "--".to_owned()],
            Some(cwd),
        )
        .and_then(|text| first_non_separator_line(&text).map(PathBuf::from))
    }

    fn now(&self) -> String {
        self.context.now.clone().unwrap_or_else(|| {
            self.exec(
                "date",
                &["-u".to_owned(), "+%Y-%m-%dT%H:%M:%SZ".to_owned()],
                None,
            )
            .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned())
        })
    }

    fn list(&self, path: &Path, recursive: bool) -> Vec<HostEntry> {
        let mut entries = Vec::new();
        let mut offset = 0_u64;
        loop {
            let response = host_call(
                maw_fs_list,
                json!({
                    "path": path,
                    "recursive": recursive,
                    "includeDirs": true,
                    "maxEntries": 1000,
                    "offset": offset
                })
                .to_string(),
            );
            let value = host_value(&response);
            if let Some(page) = value.get("entries").and_then(Value::as_array) {
                entries.extend(page.iter().filter_map(|entry| {
                    Some(HostEntry {
                        path: PathBuf::from(entry.get("path")?.as_str()?),
                        kind: entry.get("kind")?.as_str()?.to_owned(),
                    })
                }));
            }
            let Some(next) = value.get("nextOffset").and_then(Value::as_u64) else {
                break;
            };
            offset = next;
        }
        entries
    }

    fn exists(&self, path: &Path) -> bool {
        let response = host_call(maw_fs_stat, json!({"path": path}).to_string());
        host_value(&response)
            .get("exists")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn is_dir(&self, path: &Path) -> bool {
        let response = host_call(maw_fs_stat, json!({"path": path}).to_string());
        host_value(&response).get("kind").and_then(Value::as_str) == Some("dir")
    }

    fn read_bytes(&self, path: &Path) -> Option<Vec<u8>> {
        let mut bytes = Vec::new();
        let mut offset = 0_u64;
        loop {
            let response = host_call(
                maw_fs_read,
                json!({
                    "path": path,
                    "encoding": "base64",
                    "maxBytes": 10_485_760_u64,
                    "offset": offset
                })
                .to_string(),
            );
            if response.get("ok").and_then(Value::as_bool) != Some(true) {
                return None;
            }
            let value = host_value(&response);
            let chunk = base64::engine::general_purpose::STANDARD
                .decode(value.get("content")?.as_str()?)
                .ok()?;
            bytes.extend(chunk);
            let Some(next) = value.get("nextOffset").and_then(Value::as_u64) else {
                break;
            };
            offset = next;
        }
        Some(bytes)
    }

    fn read_text(&self, path: &Path) -> Option<String> {
        String::from_utf8(self.read_bytes(path)?).ok()
    }

    fn write_new(&self, path: &Path, bytes: &[u8]) -> bool {
        let response = host_call(
            maw_fs_write,
            json!({
                "path": path,
                "content": base64::engine::general_purpose::STANDARD.encode(bytes),
                "encoding": "base64",
                "mode": "create",
                "mkdirp": true
            })
            .to_string(),
        );
        response.get("ok").and_then(Value::as_bool) == Some(true)
    }

    fn append(&self, path: &Path, text: &str) -> bool {
        let response = host_call(
            maw_fs_write,
            json!({
                "path": path,
                "content": text,
                "mode": "append",
                "mkdirp": true
            })
            .to_string(),
        );
        response.get("ok").and_then(Value::as_bool) == Some(true)
    }

    fn load_fleet(&self) -> Vec<FleetSession> {
        if let Some(fleet) = &self.context.fleet {
            return fleet.clone();
        }
        let mut fleet = Vec::new();
        let mut seen = BTreeSet::new();
        for root_name in ["fleet-state", "fleet-legacy", "fleet-config"] {
            let Some(root) = host_path(root_name) else {
                continue;
            };
            let mut files = self
                .list(&root, false)
                .into_iter()
                .filter(|entry| {
                    entry.kind == "file"
                        && entry.path.extension().and_then(std::ffi::OsStr::to_str) == Some("json")
                })
                .map(|entry| entry.path)
                .collect::<Vec<_>>();
            files.extend(
                self.list(&root.join("squads"), true)
                    .into_iter()
                    .filter(|entry| entry.kind == "file" && entry.path.ends_with("squad.json"))
                    .map(|entry| entry.path),
            );
            files.sort();
            for file in files {
                let Some(text) = self.read_text(&file) else {
                    continue;
                };
                let Ok(mut session) = serde_json::from_str::<FleetSession>(&text) else {
                    continue;
                };
                if session.name.is_empty() || seen.contains(&session.name) {
                    continue;
                }
                self.apply_role_markers(&mut session);
                seen.insert(session.name.clone());
                fleet.push(session);
            }
        }
        fleet
    }

    fn apply_role_markers(&self, session: &mut FleetSession) {
        for window in &mut session.windows {
            if window.kind.is_some() || window.repo.trim().is_empty() {
                continue;
            }
            let repo = window
                .repo
                .trim()
                .strip_prefix("github.com/")
                .unwrap_or(window.repo.trim());
            window.kind = self.repo_marker_kind(&self.repos_root().join(repo));
        }
    }

    fn repo_marker_kind(&self, repo: &Path) -> Option<RepoKind> {
        match self.read_text(&repo.join(".maw/role"))?.trim() {
            "oracle" => Some(RepoKind::Oracle),
            "project" => Some(RepoKind::Project),
            _ => None,
        }
    }
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let context = serde_json::from_str::<Context>(&input).unwrap_or_default();
    let args = context.args.clone();
    let host = SystemHost::new(context);
    let fleet = host.load_fleet();
    Ok(match run(&args, &host, &fleet) {
        Ok(output) => json!({"ok": true, "output": output}),
        Err(error) => json!({"ok": false, "error": error}),
    }
    .to_string())
}

const USAGE: &str = "usage: maw soul-sync [peer] [--from <peer>] [--project]";
const SYNC_DIRS: &[&str] = &[
    "memory/learnings",
    "memory/retrospectives",
    "memory/traces",
    "memory/collaborations",
];

#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    Oracle,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Args {
    target: Option<String>,
    from: Option<String>,
    mode: Mode,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SyncResult {
    from: String,
    to: String,
    synced: Vec<(String, usize)>,
    total: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ProjectResult {
    project: String,
    oracle: String,
    synced: Vec<(String, usize)>,
    total: usize,
}

fn run(argv: &[String], host: &SystemHost, fleet: &[FleetSession]) -> Result<String, String> {
    let args = parse_args(argv)?;
    match args.mode {
        Mode::Oracle => run_oracle(&args, host, fleet),
        Mode::Project => Ok(run_project(host, fleet)),
    }
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut target = None;
    let mut from = None;
    let mut project = false;
    let mut index = 0;
    while index < argv.len() {
        match argv[index].as_str() {
            "--help" | "-h" | "help" => return Err(USAGE.to_owned()),
            "--" => return Err("soul-sync: -- separator is not supported".to_owned()),
            "--project" => project = true,
            "--from" => {
                let value = next_value(argv, index, "--from")?;
                from = Some(validate_name(value, "from")?);
                index += 1;
            }
            value if value.starts_with("--from=") => {
                from = Some(validate_name(&value["--from=".len()..], "from")?);
            }
            value if value.starts_with('-') => {
                return Err(format!("soul-sync: unknown argument {value}"));
            }
            value => {
                if target.is_some() {
                    return Err(USAGE.to_owned());
                }
                target = Some(validate_name(value, "target")?);
            }
        }
        index += 1;
    }
    if project && (target.is_some() || from.is_some()) {
        return Err("soul-sync: --project cannot be combined with peer targets".to_owned());
    }
    Ok(Args {
        target,
        from,
        mode: if project { Mode::Project } else { Mode::Oracle },
    })
}

fn next_value<'a>(argv: &'a [String], index: usize, flag: &str) -> Result<&'a str, String> {
    let Some(value) = argv.get(index + 1).map(String::as_str) else {
        return Err(format!("soul-sync: missing value for {flag}"));
    };
    if value.starts_with('-') {
        return Err(format!("soul-sync: missing value for {flag}"));
    }
    Ok(value)
}

fn run_oracle(args: &Args, host: &SystemHost, fleet: &[FleetSession]) -> Result<String, String> {
    let cwd = host.current_dir();
    let oracle_path = oracle_path_from_cwd(host, &cwd);
    let oracle_name = repo_base(&cwd).trim_end_matches("-oracle").to_owned();
    validate_name(&oracle_name, "oracle")?;
    let peers = oracle_peers(args, &oracle_name, fleet);
    if peers.is_empty() {
        return Ok(render_no_peers(&oracle_name));
    }
    let pulling = args.from.is_some();
    let mut output = render_oracle_header(pulling, &oracle_name, &peers);
    let mut total = 0;
    for peer in peers {
        validate_name(&peer, "peer")?;
        let repos_root = repos_root_from_repo(&oracle_path, host);
        let Some(peer_path) = resolve_oracle_path(&peer, fleet, &repos_root, host) else {
            let _ = writeln!(
                output,
                "  \x1b[33m⚠\x1b[0m {peer}: repo not found, skipping"
            );
            continue;
        };
        let result = if pulling {
            sync_oracle_vaults(&peer_path, &oracle_path, &peer, &oracle_name, host)
        } else {
            sync_oracle_vaults(&oracle_path, &peer_path, &oracle_name, &peer, host)
        };
        total += result.total;
        render_oracle_result(&mut output, &result);
    }
    render_total(&mut output, total, "synced");
    Ok(output)
}

fn run_project(host: &SystemHost, fleet: &[FleetSession]) -> String {
    let cwd = host.current_dir();
    let current_repo = host.git_path(&cwd, "--show-toplevel").unwrap_or(cwd);
    let github_root = repos_root_from_repo(&current_repo, host);
    let repo_slug = project_slug(&current_repo, &github_root);
    let base = repo_base(&current_repo);
    let is_oracle = repo_is_oracle(&current_repo, &base, fleet, host);
    let mut output = format!(
        "\n  \x1b[36m⚡ Soul Sync (project)\x1b[0m — {} {base}\n\n",
        if is_oracle {
            "absorbing into"
        } else {
            "exporting from"
        }
    );
    let mut totals = Vec::new();
    if is_oracle {
        project_from_oracle(&mut output, &current_repo, &base, fleet, host, &mut totals);
    } else {
        project_from_repo(
            &mut output,
            &current_repo,
            &github_root,
            repo_slug.as_deref(),
            fleet,
            host,
            &mut totals,
        );
    }
    render_total(&mut output, totals.iter().sum(), "absorbed");
    output
}

fn project_from_oracle(
    output: &mut String,
    oracle_repo: &Path,
    base: &str,
    fleet: &[FleetSession],
    host: &SystemHost,
    totals: &mut Vec<usize>,
) {
    let oracle_name = base.trim_end_matches("-oracle");
    let projects = projects_for_oracle(oracle_name, fleet);
    if projects.is_empty() {
        let _ = writeln!(
            output,
            "  \x1b[33m⚠\x1b[0m no project_repos configured for '{oracle_name}'"
        );
        let _ = writeln!(output, "  \x1b[90mAdd \"project_repos\": [\"org/repo\"] to fleet config for {oracle_name}.\x1b[0m");
        return;
    }
    let github_root = repos_root_from_repo(oracle_repo, host);
    for project in projects {
        let project_path = github_root.join(&project);
        if !host.is_dir(&project_path) {
            let _ = writeln!(
                output,
                "  \x1b[33m⚠\x1b[0m {project}: not found at {}, skipping",
                project_path.display()
            );
            continue;
        }
        let result = sync_project_vault(&project_path, oracle_repo, &project, oracle_name, host);
        totals.push(result.total);
        render_project_result(output, &result);
    }
}

fn project_from_repo(
    output: &mut String,
    project_repo: &Path,
    github_root: &Path,
    repo_slug: Option<&str>,
    fleet: &[FleetSession],
    host: &SystemHost,
    totals: &mut Vec<usize>,
) {
    let Some(slug) = repo_slug else {
        let _ = writeln!(
            output,
            "  \x1b[33m⚠\x1b[0m cannot resolve project slug from {} (not under repos root {})",
            project_repo.display(),
            github_root.display()
        );
        return;
    };
    let Some(oracle_name) = oracle_for_project(slug, fleet) else {
        let _ = writeln!(output, "  \x1b[33m⚠\x1b[0m no oracle owns project '{slug}'");
        let _ = writeln!(
            output,
            "  \x1b[90mAdd \"project_repos\": [\"{slug}\"] to an oracle's fleet config.\x1b[0m"
        );
        return;
    };
    let Some(oracle_path) = resolve_oracle_path(&oracle_name, fleet, github_root, host) else {
        let _ = writeln!(
            output,
            "  \x1b[33m⚠\x1b[0m oracle '{oracle_name}' repo not found locally"
        );
        return;
    };
    let result = sync_project_vault(project_repo, &oracle_path, slug, &oracle_name, host);
    totals.push(result.total);
    render_project_result(output, &result);
}

fn oracle_path_from_cwd(host: &SystemHost, cwd: &Path) -> PathBuf {
    host.git_path(cwd, "--git-common-dir")
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .filter(|path| path.file_name().and_then(std::ffi::OsStr::to_str) != Some(".git"))
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn oracle_peers(args: &Args, oracle_name: &str, fleet: &[FleetSession]) -> Vec<String> {
    if let Some(source) = &args.from {
        return vec![source.clone()];
    }
    args.target.as_ref().map_or_else(
        || peers_for_oracle(oracle_name, fleet),
        |target| vec![target.clone()],
    )
}

fn peers_for_oracle(oracle_name: &str, fleet: &[FleetSession]) -> Vec<String> {
    fleet
        .iter()
        .find(|session| session_name(&session.name) == oracle_name)
        .map_or_else(Vec::new, |session| session.sync_peers.clone())
}

fn projects_for_oracle(oracle_name: &str, fleet: &[FleetSession]) -> Vec<String> {
    fleet
        .iter()
        .find(|session| session_name(&session.name) == oracle_name)
        .map_or_else(Vec::new, |session| session.project_repos.clone())
}

fn oracle_for_project(project_repo: &str, fleet: &[FleetSession]) -> Option<String> {
    fleet
        .iter()
        .find(|session| {
            session
                .project_repos
                .iter()
                .any(|repo| repo == project_repo)
        })
        .map(|session| session_name(&session.name))
}

fn resolve_oracle_path(
    name: &str,
    fleet: &[FleetSession],
    repos_root: &Path,
    host: &SystemHost,
) -> Option<PathBuf> {
    let stem = name.trim_end_matches("-oracle");
    if let Some(path) = declared_oracle_path(stem, fleet, repos_root, host) {
        return Some(path);
    }
    if let Some(path) = find_oracle_repo(repos_root, stem, fleet, host) {
        return Some(path);
    }
    fleet
        .iter()
        .find(|session| session_name(&session.name) == stem)
        .and_then(|session| {
            session
                .windows
                .iter()
                .find(|window| window.kind != Some(RepoKind::Project))
        })
        .map(|window| {
            repos_root.join(
                window
                    .repo
                    .trim()
                    .strip_prefix("github.com/")
                    .unwrap_or(window.repo.trim()),
            )
        })
        .filter(|path| host.is_dir(path))
}

fn repo_is_oracle(
    repo: &Path,
    fallback_name: &str,
    fleet: &[FleetSession],
    host: &SystemHost,
) -> bool {
    match repo_kind_for_path(repo, fleet, host) {
        Some(RepoKind::Oracle) => true,
        Some(RepoKind::Project) => false,
        None => fallback_name.ends_with("-oracle"),
    }
}

fn repo_kind_for_path(repo: &Path, fleet: &[FleetSession], host: &SystemHost) -> Option<RepoKind> {
    let slugs = repo_slugs_for_path(repo, &host.repos_root());
    for session in fleet {
        for window in &session.windows {
            if window.kind.is_some() && window_matches_slugs(window, &slugs) {
                return window.kind;
            }
        }
    }
    host.repo_marker_kind(repo)
}

fn declared_oracle_path(
    name: &str,
    fleet: &[FleetSession],
    repos_root: &Path,
    host: &SystemHost,
) -> Option<PathBuf> {
    for session in fleet {
        let fleet_name = session_name(&session.name);
        for window in &session.windows {
            if window.kind != Some(RepoKind::Oracle) {
                continue;
            }
            let Some(oracle_name) = window_oracle_name(window) else {
                continue;
            };
            if oracle_name == name || fleet_name == name {
                let repo = window
                    .repo
                    .trim()
                    .strip_prefix("github.com/")
                    .unwrap_or(window.repo.trim());
                let path = repos_root.join(repo);
                if host.is_dir(&path) {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn find_oracle_repo(
    repos_root: &Path,
    stem: &str,
    fleet: &[FleetSession],
    host: &SystemHost,
) -> Option<PathBuf> {
    let wanted = format!("{stem}-oracle").to_lowercase();
    for org in host
        .list(repos_root, false)
        .into_iter()
        .filter(|entry| entry.kind == "dir")
    {
        for repo in host
            .list(&org.path, false)
            .into_iter()
            .filter(|entry| entry.kind == "dir")
        {
            let name = repo
                .path
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .unwrap_or_default();
            if name.eq_ignore_ascii_case(&wanted) && repo_is_oracle(&repo.path, name, fleet, host) {
                return Some(repo.path);
            }
        }
    }
    None
}

fn sync_oracle_vaults(
    from_path: &Path,
    to_path: &Path,
    from_name: &str,
    to_name: &str,
    host: &SystemHost,
) -> SyncResult {
    let synced = sync_dirs(from_path, to_path, host);
    let total = synced.iter().map(|(_, count)| *count).sum();
    let result = SyncResult {
        from: from_name.to_owned(),
        to: to_name.to_owned(),
        synced,
        total,
    };
    if total > 0 {
        append_log(
            to_path,
            &format!("{from_name} → {to_name}"),
            total,
            &result.synced,
            host,
        );
    }
    result
}

fn sync_project_vault(
    project_path: &Path,
    oracle_path: &Path,
    project_repo: &str,
    oracle_name: &str,
    host: &SystemHost,
) -> ProjectResult {
    let synced = sync_dirs(project_path, oracle_path, host);
    let total = synced.iter().map(|(_, count)| *count).sum();
    let result = ProjectResult {
        project: project_repo.to_owned(),
        oracle: oracle_name.to_owned(),
        synced,
        total,
    };
    if total > 0 {
        append_log(
            oracle_path,
            &format!("project:{project_repo} → {oracle_name}"),
            total,
            &result.synced,
            host,
        );
    }
    result
}

fn sync_dirs(from_path: &Path, to_path: &Path, host: &SystemHost) -> Vec<(String, usize)> {
    let mut synced = Vec::new();
    for dir in SYNC_DIRS {
        let count = sync_dir(
            &from_path.join("ψ").join(dir),
            &to_path.join("ψ").join(dir),
            host,
        );
        if count > 0 {
            synced.push(((*dir).to_owned(), count));
        }
    }
    synced
}

fn sync_dir(src: &Path, dst: &Path, host: &SystemHost) -> usize {
    let mut count = 0;
    for entry in host
        .list(src, true)
        .into_iter()
        .filter(|entry| entry.kind == "file")
    {
        let Ok(relative) = entry.path.strip_prefix(src) else {
            continue;
        };
        let destination = dst.join(relative);
        if host.exists(&destination) {
            continue;
        }
        if let Some(bytes) = host.read_bytes(&entry.path) {
            count += usize::from(host.write_new(&destination, &bytes));
        }
    }
    count
}

fn append_log(
    to_path: &Path,
    label: &str,
    total: usize,
    synced: &[(String, usize)],
    host: &SystemHost,
) {
    let line = format!(
        "{} | {label} | {total} files | {}\n",
        host.now(),
        summary(synced)
    );
    let _ = host.append(&to_path.join("ψ/.soul-sync/sync.log"), &line);
}

fn render_no_peers(oracle_name: &str) -> String {
    format!("  \x1b[33m⚠\x1b[0m soul-sync: no sync_peers configured for '{oracle_name}'\n  \x1b[90mAdd \"sync_peers\": [\"name\"] to fleet config, or run: maw ss <peer>\x1b[0m\n")
}

fn render_oracle_header(pulling: bool, oracle_name: &str, peers: &[String]) -> String {
    let label = if pulling {
        format!(
            "pulling {} → {oracle_name}",
            peers.first().map_or("", String::as_str)
        )
    } else {
        format!("pushing {oracle_name} → {}", peers.join(", "))
    };
    format!("\n  \x1b[36m⚡ Soul Sync\x1b[0m — {label}\n\n")
}

fn render_oracle_result(output: &mut String, result: &SyncResult) {
    if result.total == 0 {
        let _ = writeln!(
            output,
            "  \x1b[90m○\x1b[0m {} → {}: nothing new",
            result.from, result.to
        );
    } else {
        let _ = writeln!(
            output,
            "  \x1b[32m✓\x1b[0m {} → {}: {}",
            result.from,
            result.to,
            summary(&result.synced)
        );
    }
}

fn render_project_result(output: &mut String, result: &ProjectResult) {
    if result.total == 0 {
        let _ = writeln!(
            output,
            "  \x1b[90m○\x1b[0m project:{} → {}: nothing new",
            result.project, result.oracle
        );
    } else {
        let _ = writeln!(
            output,
            "  \x1b[32m✓\x1b[0m project:{} → {}: {}",
            result.project,
            result.oracle,
            summary(&result.synced)
        );
    }
}

fn render_total(output: &mut String, total: usize, verb: &str) {
    if total > 0 {
        let _ = writeln!(output, "\n  \x1b[32m{total} file(s) {verb}.\x1b[0m\n");
    } else {
        output.push('\n');
    }
}

fn summary(synced: &[(String, usize)]) -> String {
    synced
        .iter()
        .map(|(dir, count)| format!("{count} {}", dir.rsplit('/').next().unwrap_or(dir)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn repos_root_from_repo(repo_root: &Path, host: &SystemHost) -> PathBuf {
    let mut output = PathBuf::new();
    for component in repo_root.components() {
        output.push(component.as_os_str());
        if component.as_os_str() == "github.com" {
            return output;
        }
    }
    host.repos_root()
}

fn project_slug(project_repo: &Path, github_root: &Path) -> Option<String> {
    let relative = project_repo
        .strip_prefix(github_root)
        .ok()?
        .components()
        .filter_map(|item| item.as_os_str().to_str())
        .collect::<Vec<_>>();
    if relative.len() >= 4 && relative[2] == "agents" {
        return Some(format!("{}/{}", relative[0], relative[1]));
    }
    if relative.len() < 2 {
        return None;
    }
    Some(format!(
        "{}/{}",
        relative[0],
        relative[1]
            .replace(".wt-", "#")
            .split('#')
            .next()
            .unwrap_or(relative[1])
    ))
}

fn repo_base(path: &Path) -> String {
    let parts = path
        .components()
        .filter_map(|part| part.as_os_str().to_str())
        .collect::<Vec<_>>();
    if parts.len() >= 3 && parts[parts.len() - 2] == "agents" {
        return parts[parts.len() - 3].to_owned();
    }
    let base = path
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or_default();
    base.split(".wt-").next().unwrap_or(base).to_owned()
}

fn session_name(name: &str) -> String {
    name.split_once('-')
        .filter(|(prefix, suffix)| {
            prefix.chars().all(|character| character.is_ascii_digit()) && !suffix.is_empty()
        })
        .map_or(name, |(_, suffix)| suffix)
        .trim_end_matches("-oracle")
        .to_owned()
}

fn validate_name(value: &str, label: &str) -> Result<String, String> {
    if value.is_empty()
        || value.trim() != value
        || value.starts_with('-')
        || value.contains('/')
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(format!("soul-sync: invalid {label} {value:?}"));
    }
    Ok(value.to_owned())
}

fn validate_exec_path(path: &Path) -> Result<(), String> {
    let text = path.to_string_lossy();
    if text.is_empty()
        || text.starts_with('-')
        || text
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err("soul-sync: invalid exec path".to_owned());
    }
    Ok(())
}

fn first_non_separator_line(text: &str) -> Option<&str> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "--")
}

fn repo_slugs_for_path(path: &Path, repos_root: &Path) -> BTreeSet<String> {
    let mut slugs = BTreeSet::new();
    if let Ok(relative) = path.strip_prefix(repos_root) {
        let parts = relative
            .components()
            .take(2)
            .map(|part| part.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        if parts.len() == 2 {
            slugs.insert(format!("{}/{}", parts[0], parts[1]));
            slugs.insert(format!("github.com/{}/{}", parts[0], parts[1]));
        }
    }
    slugs
}

fn window_matches_slugs(window: &FleetWindow, slugs: &BTreeSet<String>) -> bool {
    let repo = window.repo.trim();
    !repo.is_empty()
        && (slugs.contains(repo)
            || repo
                .strip_prefix("github.com/")
                .is_some_and(|stripped| slugs.contains(stripped)))
}

fn window_oracle_name(window: &FleetWindow) -> Option<String> {
    if window.kind != Some(RepoKind::Oracle) {
        return None;
    }
    let source = if window.name.trim().is_empty() {
        window.repo.rsplit('/').next().unwrap_or_default()
    } else {
        window.name.trim()
    };
    let without_slot = source
        .split_once('-')
        .filter(|(prefix, suffix)| {
            !prefix.is_empty()
                && !suffix.is_empty()
                && prefix.chars().all(|character| character.is_ascii_digit())
        })
        .map_or(source, |(_, suffix)| suffix);
    let name = without_slot
        .strip_suffix("-oracle")
        .unwrap_or(without_slot)
        .trim();
    (!name.is_empty()).then(|| name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parse_rejects_injection_before_io() {
        assert!(parse_args(&strings(&["--from", "-bad"]))
            .unwrap_err()
            .contains("missing value"));
        assert!(parse_args(&strings(&["--"]))
            .unwrap_err()
            .contains("separator"));
        assert!(parse_args(&strings(&["-bad"]))
            .unwrap_err()
            .contains("unknown"));
    }

    #[test]
    fn project_slug_collapses_agent_worktrees() {
        let root = Path::new("/Code/github.com");
        assert_eq!(
            project_slug(Path::new("/Code/github.com/org/app/agents/task"), root).as_deref(),
            Some("org/app")
        );
    }

    #[test]
    fn aliases_share_native_session_normalization() {
        assert_eq!(session_name("03-neo-oracle"), "neo");
        assert_eq!(session_name("neo-oracle"), "neo");
    }
}
