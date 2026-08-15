#![allow(clippy::missing_panics_doc)]

use base64::Engine as _;
use extism_pdk::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fmt::Write as _;

const USAGE: &str = "usage: maw art [ls|get|write|attach|init] [--json] [--team <team>]";

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.paths.get"]
    fn maw_paths_get(input: u64) -> u64;
    #[link_name = "maw.fs.read"]
    fn maw_fs_read(input: u64) -> u64;
    #[link_name = "maw.fs.write"]
    fn maw_fs_write(input: u64) -> u64;
    #[link_name = "maw.fs.mkdir"]
    fn maw_fs_mkdir(input: u64) -> u64;
    #[link_name = "maw.fs.list"]
    fn maw_fs_list(input: u64) -> u64;
    #[link_name = "maw.fs.stat"]
    fn maw_fs_stat(input: u64) -> u64;
    #[link_name = "maw.exec.run"]
    fn maw_exec_run(input: u64) -> u64;
}

type HostFn = unsafe extern "C" fn(u64) -> u64;

#[derive(Deserialize)]
struct Context {
    #[serde(default)]
    args: Vec<String>,
    now: Option<String>,
}

#[derive(Debug, Default)]
struct Options {
    subcommand: String,
    args: Vec<String>,
    json: bool,
    team: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    team: String,
    task_id: String,
    subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    team: String,
    task_id: String,
    subject: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    files: usize,
    has_result: bool,
    created_at: String,
}

#[derive(Serialize)]
struct Full {
    meta: Meta,
    spec: String,
    result: Option<String>,
    attachments: Vec<String>,
    dir: String,
}

struct Roots {
    cache: String,
    legacy: Option<String>,
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let context: Context = serde_json::from_str(&input).unwrap_or(Context {
        args: Vec::new(),
        now: None,
    });
    Ok(match run(&context) {
        Ok(output) => json!({"ok":true,"output":output}).to_string(),
        Err(error) => json!({"ok":false,"error":format!("{error}\n")}).to_string(),
    })
}

fn run(context: &Context) -> Result<String, String> {
    let options = parse_args(&context.args)?;
    let roots = roots()?;
    match options.subcommand.as_str() {
        "ls" | "list" => run_list(&roots, &options),
        "get" | "show" => run_get(&roots, &options),
        "write" => run_write(&roots, &options, context.now.as_deref()),
        "attach" => run_attach(&roots, &options),
        "init" | "create" => run_create(&roots, &options, context.now.as_deref()),
        _ => Err(USAGE.to_owned()),
    }
}

fn parse_args(argv: &[String]) -> Result<Options, String> {
    let mut options = Options {
        subcommand: "ls".to_owned(),
        ..Options::default()
    };
    let mut positionals = Vec::new();
    let mut index = 0;
    while let Some(arg) = argv.get(index) {
        if arg == "--" {
            for value in &argv[index + 1..] {
                validate_value(value, "argument")?;
                positionals.push(value.clone());
            }
            break;
        }
        match arg.as_str() {
            "--help" | "-h" => return Err(USAGE.to_owned()),
            "--json" => options.json = true,
            "--team" => {
                let value = argv
                    .get(index + 1)
                    .ok_or("artifact-manager: missing value for --team".to_owned())?;
                validate_value(value, "--team")?;
                options.team = Some(value.clone());
                index += 1;
            }
            value if value.starts_with("--team=") => {
                let value = value.split_once('=').map_or("", |(_, value)| value);
                validate_value(value, "--team")?;
                options.team = Some(value.to_owned());
            }
            value if value.starts_with('-') => {
                return Err(format!("artifact-manager: unknown argument {value}"));
            }
            value => {
                validate_value(value, "argument")?;
                positionals.push(value.to_owned());
            }
        }
        index += 1;
    }
    if let Some(subcommand) = positionals.first() {
        options.subcommand.clone_from(subcommand);
    }
    options.args = positionals;
    Ok(options)
}

fn validate_value(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("artifact-manager: empty value for {label}"));
    }
    if value.starts_with('-') {
        return Err(format!(
            "artifact-manager: {label} value must not start with '-'"
        ));
    }
    if value.bytes().any(|byte| matches!(byte, 0 | b'\n' | b'\r')) {
        return Err(format!(
            "artifact-manager: invalid control character in {label}"
        ));
    }
    Ok(())
}

fn validate_slug(value: &str, label: &str) -> Result<(), String> {
    validate_value(value, label)?;
    if value.contains('/') || value.contains('\\') || matches!(value, "." | "..") {
        return Err(format!("artifact-manager: invalid {label}"));
    }
    Ok(())
}

fn team_task(options: &Options, usage: &str) -> Result<(String, String), String> {
    let team = options.args.get(1).ok_or_else(|| usage.to_owned())?;
    let task = options.args.get(2).ok_or_else(|| usage.to_owned())?;
    validate_slug(team, "team")?;
    validate_slug(task, "task-id")?;
    Ok((team.clone(), task.clone()))
}

fn run_list(roots: &Roots, options: &Options) -> Result<String, String> {
    let team = options.args.get(1).or(options.team.as_ref());
    if let Some(team) = team {
        validate_slug(team, "team")?;
    }
    let items = list_artifacts(roots, team.map(String::as_str));
    if options.json {
        return pretty(&items);
    }
    if items.is_empty() {
        return Ok("No artifacts.\n".to_owned());
    }
    Ok(render_list(&items))
}

fn run_get(roots: &Roots, options: &Options) -> Result<String, String> {
    let (team, task) = team_task(options, "usage: maw art get <team> <task-id>")?;
    let artifact =
        get_artifact(roots, &team, &task).ok_or_else(|| format!("not found: {team}/{task}"))?;
    if options.json {
        pretty(&artifact)
    } else {
        Ok(render_get(&artifact))
    }
}

fn run_write(roots: &Roots, options: &Options, now: Option<&str>) -> Result<String, String> {
    let usage = "usage: maw art write <team> <task-id> <message...>";
    let (team, task) = team_task(options, usage)?;
    let rest = options.args.get(3..).unwrap_or_default();
    if rest.is_empty() {
        return Err(usage.to_owned());
    }
    let dir =
        existing_dir(roots, &team, &task).unwrap_or_else(|| artifact_dir(roots, &team, &task));
    write_text(&format!("{dir}/result.md"), &rest.join(" "))?;
    update_status(&dir, now)?;
    Ok(format!(
        "\x1b[32m✓\x1b[0m result written → {dir}/result.md\n"
    ))
}

fn run_attach(roots: &Roots, options: &Options) -> Result<String, String> {
    let usage = "usage: maw art attach <team> <task-id> <file-path>";
    let (team, task) = team_task(options, usage)?;
    let path = options.args.get(3).ok_or_else(|| usage.to_owned())?;
    validate_value(path, "file-path")?;
    let data = read_external(path)?;
    let name = path.rsplit(['/', '\\']).next().unwrap_or("attachment");
    let dir =
        existing_dir(roots, &team, &task).unwrap_or_else(|| artifact_dir(roots, &team, &task));
    let dest = format!("{dir}/attachments/{}", safe_name(name));
    write_bytes(&dest, &data)?;
    Ok(format!("\x1b[32m✓\x1b[0m attached → {dest}\n"))
}

fn run_create(roots: &Roots, options: &Options, now: Option<&str>) -> Result<String, String> {
    let usage = "usage: maw art init <team> <task-id> <subject> [description...]";
    let (team, task) = team_task(options, usage)?;
    let subject = options.args.get(3).ok_or_else(|| usage.to_owned())?;
    validate_value(subject, "subject")?;
    let description = options
        .args
        .get(4..)
        .map_or_else(|| subject.clone(), |parts| parts.join(" "));
    let dir = artifact_dir(roots, &team, &task);
    mkdir(&format!("{dir}/attachments"))?;
    write_text(
        &format!("{dir}/spec.md"),
        &format!("# {subject}\n\n{description}\n"),
    )?;
    let now = current_time(now)?;
    let meta = Meta {
        team,
        task_id: task,
        subject: subject.clone(),
        owner: None,
        status: "pending".to_owned(),
        created_at: now.clone(),
        updated_at: now,
        commit_hash: None,
    };
    write_meta(&dir, &meta)?;
    write_meta(&dir, &meta)?;
    Ok(format!("\x1b[32m✓\x1b[0m artifact created → {dir}\n"))
}

fn roots() -> Result<Roots, String> {
    let value = host_value(maw_paths_get, json!({"name":"maw-cache"}))?;
    let cache = value
        .get("path")
        .and_then(Value::as_str)
        .ok_or("artifact-manager: maw-cache path missing".to_owned())?;
    let legacy = value
        .get("legacyPath")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    Ok(Roots {
        cache: format!("{cache}/artifacts"),
        legacy,
    })
}

fn read_roots(roots: &Roots) -> Vec<&str> {
    let mut values = vec![roots.cache.as_str()];
    if let Some(legacy) = roots.legacy.as_deref() {
        values.push(legacy);
    }
    values
}

fn artifact_dir(roots: &Roots, team: &str, task: &str) -> String {
    format!("{}/{team}/{task}", roots.cache)
}

fn existing_dir(roots: &Roots, team: &str, task: &str) -> Option<String> {
    read_roots(roots).into_iter().find_map(|root| {
        let dir = format!("{root}/{team}/{task}");
        exists(&format!("{dir}/meta.json")).then_some(dir)
    })
}

fn list_artifacts(roots: &Roots, team_filter: Option<&str>) -> Vec<Summary> {
    let mut items = Vec::new();
    let mut seen = BTreeSet::new();
    for root in read_roots(roots) {
        let teams = team_filter.map_or_else(
            || list_kind(root, "dir"),
            |team| vec![format!("{root}/{team}")],
        );
        for team_dir in teams {
            let team = base(&team_dir).to_owned();
            for task_dir in list_kind(&team_dir, "dir") {
                if let Some(item) = summary(&team, &task_dir) {
                    let key = format!("{}\0{}", item.team, item.task_id);
                    if seen.insert(key) {
                        items.push(item);
                    }
                }
            }
        }
    }
    items.sort_by(|a, b| a.team.cmp(&b.team).then(a.task_id.cmp(&b.task_id)));
    items
}

fn summary(team: &str, dir: &str) -> Option<Summary> {
    let meta = read_meta(dir)?;
    let direct = list_kind(dir, "any").len();
    let attachments = list_kind(&format!("{dir}/attachments"), "any").len();
    Some(Summary {
        team: team.to_owned(),
        task_id: base(dir).to_owned(),
        subject: meta.subject,
        status: meta.status,
        owner: meta.owner,
        files: direct + attachments,
        has_result: exists(&format!("{dir}/result.md")),
        created_at: meta.created_at,
    })
}

fn get_artifact(roots: &Roots, team: &str, task: &str) -> Option<Full> {
    let dir = existing_dir(roots, team, task)?;
    let meta = read_meta(&dir)?;
    let spec = read_text(&format!("{dir}/spec.md")).unwrap_or_default();
    let result = read_text(&format!("{dir}/result.md"));
    let mut attachments = list_kind(&format!("{dir}/attachments"), "any")
        .into_iter()
        .map(|path| base(&path).to_owned())
        .collect::<Vec<_>>();
    attachments.sort();
    Some(Full {
        meta,
        spec,
        result,
        attachments,
        dir,
    })
}

fn read_meta(dir: &str) -> Option<Meta> {
    serde_json::from_str(&read_text(&format!("{dir}/meta.json"))?).ok()
}

fn write_meta(dir: &str, meta: &Meta) -> Result<(), String> {
    let text = serde_json::to_string_pretty(meta).map_err(|error| error.to_string())?;
    write_text(&format!("{dir}/meta.json"), &text)
}

fn update_status(dir: &str, now: Option<&str>) -> Result<(), String> {
    let Some(mut meta) = read_meta(dir) else {
        return Ok(());
    };
    meta.status = "completed".to_owned();
    meta.updated_at = current_time(now)?;
    write_meta(dir, &meta)
}

fn list_kind(path: &str, kind: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut offset = 0_u64;
    while let Ok(value) = host_value(
        maw_fs_list,
        json!({"path":path,"recursive":false,"includeDirs":true,"maxEntries":1000,"offset":offset}),
    ) {
        if let Some(entries) = value.get("entries").and_then(Value::as_array) {
            for entry in entries {
                let matches =
                    kind == "any" || entry.get("kind").and_then(Value::as_str) == Some(kind);
                if matches {
                    if let Some(path) = entry.get("path").and_then(Value::as_str) {
                        paths.push(path.to_owned());
                    }
                }
            }
        }
        let Some(next) = value.get("nextOffset").and_then(Value::as_u64) else {
            break;
        };
        offset = next;
    }
    paths
}

fn exists(path: &str) -> bool {
    host_value(maw_fs_stat, json!({"path":path}))
        .ok()
        .and_then(|value| value.get("exists").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn read_text(path: &str) -> Option<String> {
    String::from_utf8(read_bytes(path)?).ok()
}

fn read_bytes(path: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut offset = 0_u64;
    loop {
        let value = host_value(
            maw_fs_read,
            json!({"path":path,"encoding":"base64","maxBytes":10485760u64,"offset":offset}),
        )
        .ok()?;
        let content = value.get("content").and_then(Value::as_str)?;
        bytes.extend(
            base64::engine::general_purpose::STANDARD
                .decode(content)
                .ok()?,
        );
        let Some(next) = value.get("nextOffset").and_then(Value::as_u64) else {
            break;
        };
        offset = next;
    }
    Some(bytes)
}

fn write_text(path: &str, content: &str) -> Result<(), String> {
    host_value(
        maw_fs_write,
        json!({"path":path,"content":content,"mode":"overwrite","mkdirp":true}),
    )
    .map(|_| ())
}

fn write_bytes(path: &str, bytes: &[u8]) -> Result<(), String> {
    host_value(
        maw_fs_write,
        json!({
            "path":path,
            "content":base64::engine::general_purpose::STANDARD.encode(bytes),
            "encoding":"base64",
            "mode":"overwrite",
            "mkdirp":true
        }),
    )
    .map(|_| ())
}

fn mkdir(path: &str) -> Result<(), String> {
    host_value(maw_fs_mkdir, json!({"path":path})).map(|_| ())
}

fn read_external(path: &str) -> Result<Vec<u8>, String> {
    let mut value = run_base64(&[path])?;
    if value.get("status").and_then(Value::as_i64) != Some(0) {
        value = run_base64(&["-i", path])?;
    }
    if value.get("status").and_then(Value::as_i64) != Some(0) {
        return Err(value
            .get("stderr")
            .and_then(Value::as_str)
            .unwrap_or("failed to read attachment")
            .trim()
            .to_owned());
    }
    let encoded = value
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())
}

fn run_base64(args: &[&str]) -> Result<Value, String> {
    host_value(
        maw_exec_run,
        json!({"cmd":"base64","args":args,"allowNonZero":true}),
    )
}

fn current_time(injected: Option<&str>) -> Result<String, String> {
    if let Some(now) = injected {
        return Ok(now.to_owned());
    }
    let value = host_value(maw_exec_run, json!({"cmd":"date","args":["-u","+%s"]}))?;
    let seconds = value
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .parse::<i64>()
        .map_err(|error| error.to_string())?;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        day_seconds / 3_600,
        (day_seconds % 3_600) / 60,
        day_seconds % 60
    ))
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn host_value(function: HostFn, request: Value) -> Result<Value, String> {
    let text = host_call(function, request.to_string());
    let value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(value.get("value").cloned().unwrap_or(Value::Null))
    } else {
        Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("host call failed")
            .to_owned())
    }
}

fn host_call(function: HostFn, input: String) -> String {
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

fn pretty<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string_pretty(value)
        .map(|text| format!("{text}\n"))
        .map_err(|error| error.to_string())
}

fn render_list(items: &[Summary]) -> String {
    let mut output = String::new();
    let _ = writeln!(
        output,
        "{}{}{}{}{}{}SUBJECT",
        col("TEAM", 16),
        col("ID", 6),
        col("STATUS", 12),
        col("OWNER", 14),
        col("FILES", 6),
        col("RESULT", 8)
    );
    let _ = writeln!(output, "{}", "─".repeat(80));
    for item in items {
        let status = match item.status.as_str() {
            "completed" => "\x1b[32m✓\x1b[0m done",
            "in_progress" => "\x1b[33m⚡\x1b[0m wip",
            _ => "pending",
        };
        let result = if item.has_result {
            "\x1b[32myes\x1b[0m"
        } else {
            "\x1b[90m—\x1b[0m"
        };
        let _ = writeln!(
            output,
            "{}{}{}{}{}{}{}",
            col(&item.team, 16),
            col(&item.task_id, 6),
            col(status, 12),
            col(item.owner.as_deref().unwrap_or("—"), 14),
            col(&item.files.to_string(), 6),
            col(result, 8),
            clip(&item.subject, 36)
        );
    }
    output
}

fn render_get(artifact: &Full) -> String {
    let mut output = format!(
        "\x1b[1m{}\x1b[0m\n{} / {} · {} · {}\n",
        artifact.meta.subject,
        artifact.meta.team,
        artifact.meta.task_id,
        artifact.meta.status,
        artifact.meta.owner.as_deref().unwrap_or("unowned")
    );
    if let Some(commit) = &artifact.meta.commit_hash {
        let _ = writeln!(output, "commit: {commit}");
    }
    output.push_str("\n\x1b[36m─── spec ───\x1b[0m\n");
    output.push_str(&clip(artifact.spec.trim(), 500));
    if let Some(result) = &artifact.result {
        output.push_str("\n\n\x1b[32m─── result ───\x1b[0m\n");
        output.push_str(&clip(result.trim(), 1000));
    }
    if !artifact.attachments.is_empty() {
        let _ = writeln!(
            output,
            "\n\x1b[33m─── attachments ({}) ───\x1b[0m",
            artifact.attachments.len()
        );
        for name in &artifact.attachments {
            let _ = writeln!(output, "  📎 {name}");
        }
    }
    let _ = writeln!(output, "\n\x1b[90m{}\x1b[0m", artifact.dir);
    output
}

fn col(value: &str, width: usize) -> String {
    let visible = visible_len(value);
    if visible >= width {
        value.to_owned()
    } else {
        format!("{value}{}", " ".repeat(width - visible))
    }
}

fn visible_len(value: &str) -> usize {
    let mut count = 0;
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            while chars.next().is_some_and(|next| next != 'm') {}
        } else {
            count += 1;
        }
    }
    count
}

fn clip(value: &str, width: usize) -> String {
    value.chars().take(width).collect()
}

fn safe_name(value: &str) -> String {
    let safe = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        "attachment".to_owned()
    } else {
        safe
    }
}

fn base(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parses_aliases_flags_and_guards() {
        let parsed = parse_args(&args(&["list", "--json", "--team", "team-a"])).expect("parse");
        assert_eq!(parsed.subcommand, "list");
        assert!(parsed.json);
        assert_eq!(parsed.team.as_deref(), Some("team-a"));
        assert!(parse_args(&args(&["ls", "--team", "--bad"]))
            .expect_err("dash")
            .contains("must not start"));
        assert!(parse_args(&args(&["get", "--", "team-a", "t1"])).is_ok());
    }

    #[test]
    fn rendering_matches_native_width_and_ansi_rules() {
        let item = Summary {
            team: "team-a".to_owned(),
            task_id: "t1".to_owned(),
            subject: "First".to_owned(),
            status: "completed".to_owned(),
            owner: None,
            files: 3,
            has_result: true,
            created_at: "then".to_owned(),
        };
        let output = render_list(&[item]);
        assert!(output.starts_with(
            "TEAM            ID    STATUS      OWNER         FILES RESULT  SUBJECT\n"
        ));
        assert!(output.contains("\x1b[32m✓\x1b[0m done"));
    }

    #[test]
    fn sanitizes_attachment_names() {
        assert_eq!(safe_name("source file?.txt"), "source_file_.txt");
        assert_eq!(safe_name(""), "attachment");
    }
}
