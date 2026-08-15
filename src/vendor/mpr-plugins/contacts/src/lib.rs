#![allow(clippy::missing_panics_doc)]

use extism_pdk::*;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::fmt::Write as _;

#[link(wasm_import_module = "extism:host/user")]
extern "C" {
    #[link_name = "maw.paths.get"]
    fn maw_paths_get(input: u64) -> u64;
    #[link_name = "maw.time.now"]
    fn maw_time_now(input: u64) -> u64;
    #[link_name = "maw.fs.read"]
    fn maw_fs_read(input: u64) -> u64;
    #[link_name = "maw.fs.write"]
    fn maw_fs_write(input: u64) -> u64;
}

#[derive(Default, Deserialize)]
struct Context {
    #[serde(default)]
    args: Vec<String>,
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

#[plugin_fn]
pub unsafe fn handle(input: String) -> FnResult<String> {
    let context: Context = serde_json::from_str(&input).unwrap_or_default();
    Ok(match run(&context.args) {
        Ok(output) => json!({"ok": true, "output": output}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    })
}

fn run(args: &[String]) -> Result<String, String> {
    match args
        .first()
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("add") if args.get(1).is_some() => add(&args[1], &args[2..], now_millis()?),
        Some("rm" | "remove") => args.get(1).map_or_else(
            || Err("usage: maw contacts rm <name>".to_owned()),
            |name| remove(name, now_millis()?),
        ),
        _ => list(),
    }
}

fn list() -> Result<String, String> {
    let (_, data) = load()?;
    let Some(contacts) = data.get("contacts").and_then(Value::as_object) else {
        return Ok("\u{1b}[90mno contacts\u{1b}[0m\n".to_owned());
    };
    let active = contacts
        .iter()
        .filter(|(_, contact)| {
            !contact
                .get("retired")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    if active.is_empty() {
        return Ok("\u{1b}[90mno contacts\u{1b}[0m\n".to_owned());
    }

    let mut output = format!("\n\u{1b}[36mCONTACTS\u{1b}[0m ({}):\n\n", active.len());
    for (name, contact) in active {
        let parts = [
            field(contact, "maw").map(|value| format!("maw: \u{1b}[33m{value}\u{1b}[0m")),
            field(contact, "thread").map(|value| format!("thread: \u{1b}[90m{value}\u{1b}[0m")),
            field(contact, "inbox").map(|value| format!("inbox: \u{1b}[90m{value}\u{1b}[0m")),
            field(contact, "repo").map(|value| format!("repo: \u{1b}[90m{value}\u{1b}[0m")),
            field(contact, "notes").map(|value| format!("\u{1b}[90m\"{value}\"\u{1b}[0m")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("    ");
        let _ = writeln!(output, "  \u{1b}[32m{name:<12}\u{1b}[0m  {parts}");
    }
    output.push('\n');
    Ok(output)
}

fn add(name: &str, args: &[String], now_millis: u64) -> Result<String, String> {
    let (path, mut data) = load()?;
    ensure_root(&mut data, now_millis);
    let contact = data["contacts"]
        .as_object_mut()
        .expect("contacts object ensured")
        .entry(name.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !contact.is_object() {
        *contact = Value::Object(Map::new());
    }
    let contact = contact.as_object_mut().expect("contact object ensured");
    for flag in ["--maw", "--thread", "--inbox", "--repo", "--notes"] {
        if let Some(value) = string_flag(args, flag)? {
            contact.insert(flag[2..].to_owned(), Value::String(value));
        }
    }
    contact.remove("retired");
    save(&path, &mut data, now_millis)?;
    Ok(format!(
        "\u{1b}[32m✓\u{1b}[0m contact \u{1b}[33m{name}\u{1b}[0m saved\n"
    ))
}

fn remove(name: &str, now_millis: u64) -> Result<String, String> {
    let (path, mut data) = load()?;
    let contact = data
        .get_mut("contacts")
        .and_then(Value::as_object_mut)
        .and_then(|contacts| contacts.get_mut(name));
    let Some(contact) = contact else {
        return Err(format!(
            "\u{1b}[31merror\u{1b}[0m: contact '{name}' not found"
        ));
    };
    if !contact.is_object() {
        *contact = Value::Object(Map::new());
    }
    contact
        .as_object_mut()
        .expect("contact object ensured")
        .insert("retired".to_owned(), Value::Bool(true));
    save(&path, &mut data, now_millis)?;
    Ok(format!(
        "\u{1b}[32m✓\u{1b}[0m contact \u{1b}[33m{name}\u{1b}[0m retired\n"
    ))
}

fn load() -> Result<(String, Value), String> {
    let root = host_value(
        host_call(maw_paths_get, json!({"name": "psi"}).to_string()),
        "path",
    )?;
    let path = format!("{}/contacts.json", root.trim_end_matches('/'));
    let response = host_call(maw_fs_read, json!({"path": path}).to_string());
    let Ok(envelope) = serde_json::from_str::<Value>(&response) else {
        return Ok((path, empty_file(0)));
    };
    if envelope.get("ok").and_then(Value::as_bool) == Some(false) {
        return Ok((path, empty_file(0)));
    }
    let content = envelope
        .get("value")
        .unwrap_or(&envelope)
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    serde_json::from_str(content)
        .map(|data| (path.clone(), data))
        .map_err(|error| format!("contacts: failed to parse {path}: {error}"))
}

fn save(path: &str, data: &mut Value, now_millis: u64) -> Result<(), String> {
    ensure_root(data, now_millis);
    data.as_object_mut()
        .expect("contacts file object ensured")
        .insert("updated".to_owned(), Value::String(iso8601(now_millis)));
    let content = format!(
        "{}\n",
        serde_json::to_string_pretty(data)
            .map_err(|error| format!("contacts: failed to serialize contacts: {error}"))?
    );
    let response = host_call(
        maw_fs_write,
        json!({"path": path, "content": content, "mode": "overwrite", "mkdirp": true}).to_string(),
    );
    let envelope: Value = serde_json::from_str(&response)
        .map_err(|_| "contacts: failed to write contacts.json: invalid host response".to_owned())?;
    if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        let error = envelope
            .get("error")
            .and_then(|value| value.get("message").or(Some(value)))
            .and_then(Value::as_str)
            .unwrap_or("host write failed");
        Err(format!("contacts: failed to write {path}: {error}"))
    }
}

fn host_value(response: String, key: &str) -> Result<String, String> {
    let envelope: Value = serde_json::from_str(&response)
        .map_err(|_| "contacts: failed to resolve psi path".to_owned())?;
    envelope
        .get(key)
        .or_else(|| envelope.get("value")?.get(key))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "contacts: failed to resolve psi path".to_owned())
}

fn ensure_root(data: &mut Value, now_millis: u64) {
    if !data.is_object() {
        *data = Value::Object(Map::new());
    }
    let object = data.as_object_mut().expect("object ensured");
    if !object.get("contacts").is_some_and(Value::is_object) {
        object.insert("contacts".to_owned(), Value::Object(Map::new()));
    }
    if !object.get("updated").is_some_and(Value::is_string) {
        object.insert("updated".to_owned(), Value::String(iso8601(now_millis)));
    }
}

fn empty_file(now_millis: u64) -> Value {
    json!({"contacts": {}, "updated": iso8601(now_millis)})
}

fn field<'a>(contact: &'a Value, name: &str) -> Option<&'a str> {
    contact
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn string_flag(args: &[String], flag: &str) -> Result<Option<String>, String> {
    let prefix = format!("{flag}=");
    let mut found = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == flag {
            let Some(value) = args.get(index + 1) else {
                return Err(format!("contacts: missing value for {flag}"));
            };
            found = Some(value.clone());
            index += 2;
            continue;
        }
        if let Some(value) = args[index].strip_prefix(&prefix) {
            found = Some(value.to_owned());
        }
        index += 1;
    }
    Ok(found)
}

fn iso8601(millis: u64) -> String {
    let seconds = i64::try_from(millis / 1_000).unwrap_or(i64::MAX);
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
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
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        millis % 1_000
    )
}

fn now_millis() -> Result<u64, String> {
    let response = host_call(maw_time_now, "{}".to_owned());
    let envelope: Value = serde_json::from_str(&response)
        .map_err(|_| "contacts: failed to read host clock".to_owned())?;
    envelope
        .get("value")
        .unwrap_or(&envelope)
        .get("millis")
        .and_then(Value::as_u64)
        .ok_or_else(|| "contacts: failed to read host clock".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_last_flag_value() {
        let args = vec!["--maw=old".to_owned(), "--maw".to_owned(), "new".to_owned()];
        assert_eq!(string_flag(&args, "--maw").unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn formats_unix_epoch() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
    }
}
