//! rust-echo — a minimal external engine plugin for maw (PoC for #2566).
//!
//! Dependency-free (std only). It:
//!   1. starts a loopback HTTP/1.1 server on an ephemeral port,
//!   2. registers itself with `maw serve` via `POST /api/_engine/register`
//!      (prefix `/api/rust-echo`, upstream `http://127.0.0.1:<port>`, health
//!      `/health`),
//!   3. echoes every proxied request back as JSON (method, path, headers, body),
//!   4. answers `GET /health` for maw's health poller.
//!
//! The point of the proof: the maw engine-plugin IPC contract is plain loopback
//! HTTP — any language with a socket can speak it, no SDK required. See
//! README.md for the full wire protocol.
//!
//! Usage:
//!   MAW_PORT=3456 cargo run --release          # or: cargo run --release -- 3456
//!   curl localhost:3456/api/rust-echo/hi -d 'pong'   # exercises the gateway

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

const PLUGIN: &str = "rust-echo";
const PREFIX: &str = "/api/rust-echo";

fn main() {
    // maw serve's port: env MAW_PORT, then argv[1], else the maw default 3456.
    let maw_port = std::env::var("MAW_PORT")
        .ok()
        .or_else(|| std::env::args().nth(1))
        .unwrap_or_else(|| "3456".to_string());

    // Bind an ephemeral loopback port — maw reverse-proxies to it.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral loopback port");
    let my_port = listener.local_addr().expect("local addr").port();
    println!("[{PLUGIN}] listening on http://127.0.0.1:{my_port}");

    // Start serving BEFORE registering: maw fires an async health check right
    // after register(), so the server must already be accepting connections.
    let server = thread::spawn(move || serve(listener));

    match register(&maw_port, my_port) {
        Ok(()) => println!("[{PLUGIN}] registered with maw:{maw_port} at {PREFIX}"),
        Err(e) => {
            eprintln!("[{PLUGIN}] registration failed: {e}");
            std::process::exit(1);
        }
    }

    // Block forever serving proxied requests.
    server.join().ok();
}

/// Register this process as a dynamic engine plugin with `maw serve`.
///
/// `POST /api/_engine/register` is loopback-trusted by default (no HMAC needed
/// from 127.0.0.1). maw replies `201 { ok, bound, registration }`.
fn register(maw_port: &str, my_port: u16) -> Result<(), String> {
    let body = format!(
        r#"{{"plugin":"{PLUGIN}","prefix":"{PREFIX}","upstream":"http://127.0.0.1:{my_port}","health":"/health"}}"#
    );
    let req = format!(
        "POST /api/_engine/register HTTP/1.1\r\n\
         Host: 127.0.0.1:{maw_port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\r\n{body}",
        len = body.len()
    );

    let mut stream =
        TcpStream::connect(format!("127.0.0.1:{maw_port}")).map_err(|e| format!("connect maw: {e}"))?;
    stream.write_all(req.as_bytes()).map_err(|e| format!("write: {e}"))?;

    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|e| format!("read: {e}"))?;
    let status_line = response.lines().next().unwrap_or("");
    // maw returns 201 Created on success.
    if status_line.contains(" 201") || status_line.contains(" 200") {
        Ok(())
    } else {
        Err(format!("unexpected response: {status_line:?}"))
    }
}

fn serve(listener: TcpListener) {
    for stream in listener.incoming() {
        match stream {
            // One request per connection (Connection: close) — keep it trivial.
            Ok(s) => {
                if let Err(e) = handle(s) {
                    eprintln!("[{PLUGIN}] request error: {e}");
                }
            }
            Err(e) => eprintln!("[{PLUGIN}] accept error: {e}"),
        }
    }
}

/// Parse one HTTP/1.1 request and reply. `/health` → liveness; anything else →
/// echo envelope. maw has already stripped the `/api/rust-echo` prefix, so the
/// `path` here is the suffix (`/hi`, or `/` for the bare prefix).
fn handle(stream: TcpStream) -> std::io::Result<()> {
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(()); // empty connection
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break; // end of headers
        }
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim().to_string();
            if k == "content-length" {
                content_length = v.parse().unwrap_or(0);
            }
            headers.insert(k, v);
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    let body = String::from_utf8_lossy(&body);

    if path == "/health" {
        return write_response(&mut writer, 200, "OK", &format!(r#"{{"ok":true,"plugin":"{PLUGIN}"}}"#));
    }

    // Echo back what maw forwarded — including the gateway's injected headers
    // (x-maw-engine-plugin, x-forwarded-prefix) so the contract is observable.
    let mut headers_json = String::from("{");
    for (i, (k, v)) in headers.iter().enumerate() {
        if i > 0 {
            headers_json.push(',');
        }
        headers_json.push_str(&json_str(k));
        headers_json.push(':');
        headers_json.push_str(&json_str(v));
    }
    headers_json.push('}');

    let payload = format!(
        r#"{{"plugin":"{PLUGIN}","echo":{{"method":{m},"path":{p},"headers":{h},"body":{b}}}}}"#,
        m = json_str(&method),
        p = json_str(&path),
        h = headers_json,
        b = json_str(&body),
    );
    write_response(&mut writer, 200, "OK", &payload)
}

fn write_response(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> std::io::Result<()> {
    let res = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\r\n{body}",
        len = body.as_bytes().len()
    );
    stream.write_all(res.as_bytes())?;
    stream.flush()
}

/// Escape a string into a JSON string literal (incl. surrounding quotes).
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
