use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use std::{env, net::SocketAddr, process};

#[derive(Clone)]
struct AppState {
    port: u16,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    gateway: &'static str,
    port: u16,
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        gateway: "rust",
        port: state.port,
    })
}

fn usage() -> ! {
    eprintln!("usage: maw-gateway serve --port PORT");
    process::exit(2);
}

fn parse_port(args: &[String]) -> u16 {
    if args.first().map(String::as_str) != Some("serve") {
        usage();
    }

    let mut port: Option<u16> = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--port" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    usage()
                };
                port = value.parse::<u16>().ok();
            }
            value if value.starts_with("--port=") => {
                port = value["--port=".len()..].parse::<u16>().ok();
            }
            _ => usage(),
        }
        index += 1;
    }

    port.unwrap_or_else(|| usage())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let port = parse_port(&args);
    let state = AppState { port };
    let app = Router::new()
        .route("/api/health", get(health))
        .with_state(state);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind :{}: {}", port, error);
            process::exit(1);
        }
    };

    println!("listening on :{}", port);
    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("server error: {}", error);
        process::exit(1);
    }
}
