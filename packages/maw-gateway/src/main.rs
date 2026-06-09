use axum::{
    body::Body,
    extract::State,
    http::Request,
    middleware::{self, Next},
    response::Response,
    routing::get,
    Json, Router,
};
use serde::Serialize;
use std::{env, net::SocketAddr, process, time::Instant};
use tower_http::trace::TraceLayer;

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

async fn log_request(request: Request<Body>, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let started = Instant::now();
    let response = next.run(request).await;
    let elapsed_ms = started.elapsed().as_millis();

    println!(
        "{} {} {} {}ms",
        method,
        path,
        response.status().as_u16(),
        elapsed_ms
    );
    response
}

fn usage() -> ! {
    eprintln!("usage: maw-gateway serve [--port PORT]");
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

    port.unwrap_or(3456)
}

#[cfg(test)]
mod tests {
    use super::parse_port;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parse_port_defaults_to_3456() {
        assert_eq!(parse_port(&args(&["serve"])), 3456);
    }

    #[test]
    fn parse_port_accepts_space_and_equals_forms() {
        assert_eq!(parse_port(&args(&["serve", "--port", "8080"])), 8080);
        assert_eq!(parse_port(&args(&["serve", "--port=9090"])), 9090);
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = terminate.recv() => {},
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let port = parse_port(&args);
    let state = AppState { port };
    let app = Router::new()
        .route("/api/health", get(health))
        .layer(middleware::from_fn(log_request))
        .layer(TraceLayer::new_for_http())
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
    if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("server error: {}", error);
        process::exit(1);
    }
}
