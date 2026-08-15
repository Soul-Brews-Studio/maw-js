#![allow(clippy::missing_panics_doc)]

use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fmt::Write as _;

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.tmux.command"]
    fn maw_tmux_command(input: u64) -> u64;
}

#[derive(Default, Deserialize)]
struct Context {
    #[serde(default)]
    args: Vec<String>,
}

fn host_call(input: String) -> Value {
    let Ok(memory) = Memory::from_bytes(input.as_bytes()) else {
        return Value::Null;
    };
    let offset = memory.offset();
    let output = unsafe { maw_tmux_command(offset) };
    memory.free();
    Memory::find(output)
        .and_then(|memory| {
            let bytes = memory.to_vec();
            memory.free();
            serde_json::from_slice(&bytes).ok()
        })
        .unwrap_or(Value::Null)
}

fn tmux(command: &str, args: Vec<String>) -> Result<String, String> {
    let response = host_call(json!({"command": command, "args": args}).to_string());
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response
            .get("error")
            .or_else(|| response.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("maw.tmux.command failed")
            .to_owned());
    }
    response
        .pointer("/value/stdout")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "maw.tmux.command returned no stdout".to_owned())
}

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let context = serde_json::from_str::<Context>(&input).unwrap_or_default();
    Ok(match run(&context.args) {
        Ok(output) => json!({"ok": true, "output": output}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    })
}

fn run(args: &[String]) -> Result<String, String> {
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        return Ok(help_text());
    }
    let fast = args.iter().any(|arg| arg == "--fast");
    let caller = match tmux(
        "display-message",
        vec!["-p".to_owned(), "#{pane_id}".to_owned()],
    ) {
        Ok(pane) => pane.trim().to_owned(),
        Err(_) => return Ok(no_tmux_text()),
    };
    validate_target(&caller)?;
    showcase(&caller, fast)
}

fn showcase(caller: &str, fast: bool) -> Result<String, String> {
    let mut out = String::new();
    header(&mut out, "🎬  maw demo — simulated multi-agent session");
    line(
        &mut out,
        &format!(
            "  {}No API key required. Zero real Claude calls.{}",
            dim(),
            reset()
        ),
    );
    line(
        &mut out,
        &format!(
            "  {}Two mock agents will work on a canned task.{}",
            dim(),
            reset()
        ),
    );
    step(&mut out, "writing agent scripts...");

    let mut pane1 = None;
    let mut pane2 = None;
    let result = (|| {
        step(&mut out, "spawning agent-1 in left pane...");
        let before = pane_ids();
        split(caller, "-h", &agent_script(1, fast), "agent-1")?;
        let after = pane_ids();
        pane1 = new_pane(&before, &after);
        ok(
            &mut out,
            &format!("agent-1 spawned{}", pane_suffix(pane1.as_deref())),
        );

        step(&mut out, "spawning agent-2 in right pane...");
        let before = pane_ids();
        let target = pane1.as_deref().unwrap_or(caller);
        split(target, "-v", &agent_script(2, fast), "agent-2")?;
        let after = pane_ids();
        pane2 = new_pane(&before, &after);
        ok(
            &mut out,
            &format!("agent-2 spawned{}", pane_suffix(pane2.as_deref())),
        );

        header(&mut out, "📡  broadcasting task to both agents");
        step(
            &mut out,
            "task: \"summarize this repo and suggest improvements\"",
        );
        header(&mut out, "⏳  agents working...");
        line(
            &mut out,
            &format!(
                "  {}Watch the side panes for their output.{}",
                dim(),
                reset()
            ),
        );
        header(&mut out, "💰  gathering cost data...");
        out.push_str(&cost_report());
        out.push_str(&closing_text());
        Ok(())
    })();
    cleanup(pane2.as_deref());
    cleanup(pane1.as_deref());
    result.map(|()| out)
}

fn pane_ids() -> BTreeSet<String> {
    tmux(
        "list-panes",
        vec!["-a".to_owned(), "-F".to_owned(), "#{pane_id}".to_owned()],
    )
    .unwrap_or_default()
    .lines()
    .filter(|line| validate_target(line).is_ok())
    .map(ToOwned::to_owned)
    .collect()
}

fn split(target: &str, orientation: &str, script: &str, label: &str) -> Result<(), String> {
    validate_target(target)?;
    let script = script.replace('\n', "; ");
    let command = format!(
        "bash -lc {}; echo \"  [{label}] session ended\"; read -p \"\" 2>/dev/null || true",
        shell_quote(&script)
    );
    tmux(
        "split-window",
        vec![
            "-t".to_owned(),
            target.to_owned(),
            orientation.to_owned(),
            "-l".to_owned(),
            "50%".to_owned(),
            command,
        ],
    )
    .map(|_| ())
    .map_err(|error| format!("demo: split pane: {error}"))
}

fn cleanup(pane: Option<&str>) {
    if let Some(pane) = pane.filter(|pane| validate_target(pane).is_ok()) {
        let _ = tmux("kill-pane", vec!["-t".to_owned(), pane.to_owned()]);
    }
}

fn new_pane(before: &BTreeSet<String>, after: &BTreeSet<String>) -> Option<String> {
    after.iter().find(|pane| !before.contains(*pane)).cloned()
}

fn validate_target(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        Err("demo: tmux target must be non-empty, unpadded, and not start with '-'".to_owned())
    } else {
        Ok(())
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn pane_suffix(pane: Option<&str>) -> String {
    pane.map_or_else(String::new, |pane| format!(" ({pane})"))
}

fn agent_script(agent: u8, fast: bool) -> String {
    let fast = if fast { "1" } else { "" };
    let (color, initial, lines) = if agent == 1 {
        (
            "36",
            "",
            vec![
                "● session started",
                "→ reading task: 'summarize this repo and suggest improvements'",
                "  scanning source tree...",
                "  found 57 command plugins across src/commands/plugins/",
                "  found 94 test files (test/ + test/isolated/)",
                "  found 19 API endpoints in src/api/",
                "✓ summary ready — handing off to agent-2 for improvements pass",
            ],
        )
    } else {
        (
            "33",
            if fast == "1" { "" } else { "sleep 4\n" },
            vec![
                "● session started",
                "→ received handoff from agent-1",
                "  analysing improvement opportunities...",
                "  [1] ship maw init wizard — reduce setup from 6 steps to 30 seconds",
                "  [2] add asciinema to README — first-5-minute retention lever",
                "  [3] maw costs --daily sparkline — 80% already built",
                "✓ improvements filed — 3 issues created",
            ],
        )
    };
    let mut script = format!("set -euo pipefail\nFAST=\"{fast}\"\n{initial}pause() {{ [ -n \"$FAST\" ] && return 0; sleep \"$1\"; }}\necho \"\"");
    for text in lines {
        let _ = write!(
            script,
            "\necho \"  \\033[{color}m[agent-{agent}]\\033[0m {text}\"\npause 2"
        );
    }
    script.push_str("\necho \"\"");
    script
}

fn help_text() -> String {
    concat!("maw demo — simulated multi-agent session\n\n", "Usage: maw demo [--fast]\n\n",
        "Spawns two mock agents in tmux panes, streams scripted output with\n",
        "realistic pauses, then shows $0.00 cost. No API key required.\n\n",
        "Flags:\n  --fast   Skip sleep delays (CI / screenshot mode)\n  --help   Show this message\n\n",
        "Requires an active tmux session.\n  Run: tmux new-session -s demo\n  Then: maw demo\n").to_owned()
}

fn no_tmux_text() -> String {
    concat!(
        "\n  \x1b[36mmaw demo\x1b[0m — simulated multi-agent session\n\n",
        "  \x1b[90mThis demo requires an active tmux session.\x1b[0m\n",
        "  Run: \x1b[36mtmux new-session -s demo\x1b[0m\n",
        "  Then re-run: \x1b[36mmaw demo\x1b[0m\n\n"
    )
    .to_owned()
}

fn cost_report() -> String {
    let sep = "─".repeat(52);
    format!("\n  {sep}\n  {}COST REPORT — demo session{}\n  {sep}\n  {:>20}  {:>12}  {}$0.00{}\n  {:>20}  {:>12}  {}$0.00{}\n  {sep}\n  {:>20}  {:>12}  {}$0.00{}  {}(demo mode — no real Claude calls){}\n  {sep}\n\n",
        cyan(), reset(), "agent-1", "0 tokens", green(), reset(), "agent-2", "0 tokens", green(), reset(),
        "TOTAL", "0 tokens", green(), reset(), dim(), reset())
}

fn closing_text() -> String {
    format!("  {}✓ demo complete.{}\n\n  {}For the real thing:{}\n    {}maw wake <your-repo>{}   — spawn a real agent from any GitHub repo\n    {}maw hey <agent> \"...\"{}   — send it a task\n    {}maw peek <agent>{}         — watch its screen\n    {}maw costs{}                — see what it spent\n\n  {}Install: curl -fsSL https://github.com/Soul-Brews-Studio/maw-js/install.sh | bash{}\n\n",
        green(), reset(), dim(), reset(), cyan(), reset(), cyan(), reset(), cyan(), reset(), cyan(), reset(), dim(), reset())
}

fn header(out: &mut String, text: &str) {
    line(out, &format!("\n{}{text}{}", cyan(), reset()));
}
fn step(out: &mut String, text: &str) {
    line(out, &format!("  {}→{} {text}", dim(), reset()));
}
fn ok(out: &mut String, text: &str) {
    line(out, &format!("  {}✓{} {text}", green(), reset()));
}
fn line(out: &mut String, text: &str) {
    out.push_str(text);
    out.push('\n');
}
fn cyan() -> &'static str {
    "\x1b[36m"
}
fn green() -> &'static str {
    "\x1b[32m"
}
fn dim() -> &'static str {
    "\x1b[90m"
}
fn reset() -> &'static str {
    "\x1b[0m"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_text_and_guards_match_native_contract() {
        assert_eq!(
            no_tmux_text(),
            "\n  \x1b[36mmaw demo\x1b[0m — simulated multi-agent session\n\n  \x1b[90mThis demo requires an active tmux session.\x1b[0m\n  Run: \x1b[36mtmux new-session -s demo\x1b[0m\n  Then re-run: \x1b[36mmaw demo\x1b[0m\n\n"
        );
        assert!(help_text().starts_with("maw demo — simulated multi-agent session\n"));
        assert!(validate_target("%42").is_ok());
        assert!(validate_target("-tbad").is_err());
        assert!(agent_script(1, true).contains("FAST=\"1\""));
        assert!(cost_report().contains("COST REPORT — demo session"));
    }
}
