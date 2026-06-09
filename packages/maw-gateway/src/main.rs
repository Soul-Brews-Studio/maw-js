use std::{env, net::SocketAddr, process, sync::Arc, time::Instant};

use axum::{
    body::Body,
    extract::{
        ws::{CloseCode, CloseFrame, Message as AxumMessage, WebSocketUpgrade},
        Path, State,
    },
    http::{Request, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::{body::Bytes as HyperBytes, Request as HyperRequest, Uri as HyperUri};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use serde::Serialize;
use tokio::sync::broadcast;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        http::Request as WsRequest,
        protocol::{
            frame::coding::CloseCode as TungsteniteCloseCode, CloseFrame as TungsteniteCloseFrame,
            Message as WsMessage,
        },
    },
};
use tower_http::trace::TraceLayer;

type BackendClient = Client<HttpConnector, Full<HyperBytes>>;

#[derive(Clone)]
struct AppState {
    port: u16,
    backend_port: u16,
    client: Arc<BackendClient>,
    shutdown: broadcast::Sender<()>,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    gateway: &'static str,
    backend: String,
    port: u16,
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        gateway: "rust",
        backend: format!("bun:{}", state.backend_port),
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
    eprintln!("usage: maw-gateway serve [--port PORT] [--backend PORT]");
    process::exit(2);
}

fn parse_ports(args: &[String]) -> (u16, u16) {
    if args.first().map(String::as_str) != Some("serve") {
        usage();
    }

    let mut port: Option<u16> = None;
    let mut backend_port: Option<u16> = None;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--port" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    usage();
                };
                port = value.parse::<u16>().ok();
            }
            value if value.starts_with("--port=") => {
                port = value["--port=".len()..].parse::<u16>().ok();
            }
            "--backend" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    usage();
                };
                backend_port = value.parse::<u16>().ok();
            }
            value if value.starts_with("--backend=") => {
                backend_port = value["--backend=".len()..].parse::<u16>().ok();
            }
            _ => usage(),
        }
        index += 1;
    }

    (port.unwrap_or(3456), backend_port.unwrap_or(3457))
}

fn build_backend_http_uri(state: &AppState, uri: &Uri) -> HyperUri {
    let path_and_query = uri
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or("/");
    let target = format!("http://127.0.0.1:{}{}", state.backend_port, path_and_query);
    target.parse::<HyperUri>().expect("backend URI")
}

fn build_backend_ws_uri(state: &AppState, uri: &Uri) -> String {
    let path_and_query = uri
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or("/");
    format!("ws://127.0.0.1:{}{}", state.backend_port, path_and_query)
}

fn axum_to_tungstenite(message: AxumMessage) -> Option<WsMessage> {
    match message {
        AxumMessage::Text(text) => Some(WsMessage::Text(text.to_string().into())),
        AxumMessage::Binary(binary) => Some(WsMessage::Binary(binary)),
        AxumMessage::Ping(payload) => Some(WsMessage::Ping(payload)),
        AxumMessage::Pong(payload) => Some(WsMessage::Pong(payload)),
        AxumMessage::Close(frame) => Some(match frame {
            Some(frame) => WsMessage::Close(Some(TungsteniteCloseFrame {
                code: TungsteniteCloseCode::from(frame.code),
                reason: frame.reason.to_string().into(),
            })),
            None => WsMessage::Close(None),
        }),
    }
}

fn tungstenite_to_axum(message: WsMessage) -> Option<AxumMessage> {
    match message {
        WsMessage::Text(text) => Some(AxumMessage::Text(text.to_string().into())),
        WsMessage::Binary(payload) => Some(AxumMessage::Binary(payload)),
        WsMessage::Ping(payload) => Some(AxumMessage::Ping(payload)),
        WsMessage::Pong(payload) => Some(AxumMessage::Pong(payload)),
        WsMessage::Close(frame) => Some(AxumMessage::Close(Some(CloseFrame {
            code: match frame.as_ref() {
                Some(frame) => frame.code.into(),
                None => 1000,
            },
            reason: frame
                .map(|frame| frame.reason.to_string())
                .unwrap_or_default()
                .into(),
        }))),
        WsMessage::Frame(_) => None,
    }
}

async fn build_http_request(
    request: Request<Body>,
    target: HyperUri,
) -> Result<HyperRequest<Full<Bytes>>, StatusCode> {
    let (parts, body) = request.into_parts();
    let payload = body
        .collect()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .to_bytes();

    let mut builder = HyperRequest::builder()
        .method(parts.method)
        .uri(target)
        .version(parts.version);

    for (name, value) in &parts.headers {
        builder = builder.header(name, value);
    }

    builder
        .body(Full::new(payload))
        .map_err(|_| StatusCode::BAD_REQUEST)
}

async fn proxy_http(State(state): State<AppState>, req: Request<Body>) -> Response {
    let target = build_backend_http_uri(&state, req.uri());

    let request = match build_http_request(req, target).await {
        Ok(request) => request,
        Err(status) => return status.into_response(),
    };

    let mut upstream = match state.client.request(request).await {
        Ok(response) => response,
        Err(error) => {
            eprintln!("backend request failed: {error}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    let status = upstream.status();
    let headers = std::mem::take(upstream.headers_mut());
    let body = match upstream
        .into_body()
        .collect()
        .await
        .map(|collected| collected.to_bytes())
    {
        Ok(body) => body,
        Err(error) => {
            eprintln!("backend body read failed: {error}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

async fn proxy_ws_inner(state: AppState, request: Request<Body>, ws: WebSocketUpgrade) -> Response {
    let target = build_backend_ws_uri(&state, request.uri());
    let mut ws_request = match WsRequest::builder().uri(target).body(()) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("failed to build websocket request: {error}");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    for (name, value) in request.headers() {
        ws_request.headers_mut().insert(name, value.clone());
    }

    let backend_socket = match connect_async(ws_request).await {
        Ok((backend_socket, _)) => backend_socket,
        Err(error) => {
            eprintln!("failed to connect websocket backend: {error}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    let mut shutdown_to_client = state.shutdown.subscribe();
    let mut shutdown_to_backend = state.shutdown.subscribe();

    ws.on_upgrade(move |client_socket| async move {
        let (mut client_tx, mut client_rx) = client_socket.split();
        let (mut backend_tx, mut backend_rx) = backend_socket.split();

        let to_backend = async {
            loop {
                tokio::select! {
                    message = client_rx.next() => {
                        match message {
                            Some(Ok(message)) => {
                                if let Some(forwarded) = axum_to_tungstenite(message) {
                                    if backend_tx.send(forwarded).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Some(Err(error)) => {
                                eprintln!("websocket from client errored: {error}");
                                break;
                            }
                            None => break,
                        }
                    }
                    _ = shutdown_to_client.recv() => {
                        let _ = backend_tx.send(WsMessage::Close(Some(TungsteniteCloseFrame {
                            code: TungsteniteCloseCode::from(1001u16),
                            reason: "gateway shutdown".into(),
                        }))).await;
                        break;
                    }
                }
            }
        };

        let to_client = async {
            loop {
                tokio::select! {
                    message = backend_rx.next() => {
                        match message {
                            Some(Ok(message)) => {
                                if let Some(forwarded) = tungstenite_to_axum(message) {
                                    if client_tx.send(forwarded).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            None | Some(Err(_)) => break,
                        }
                    }
                    _ = shutdown_to_backend.recv() => {
                        let _ = client_tx.send(AxumMessage::Close(Some(CloseFrame {
                            code: CloseCode::from(1001u16),
                            reason: "gateway shutdown".into(),
                        }))).await;
                        break;
                    }
                }
            }
        };

        tokio::join!(to_backend, to_client);

        let _ = client_tx
            .send(AxumMessage::Close(Some(CloseFrame {
                code: CloseCode::from(1000u16),
                reason: "bye".into(),
            })))
            .await;
        let _ = backend_tx
            .send(WsMessage::Close(Some(TungsteniteCloseFrame {
                code: TungsteniteCloseCode::from(1000u16),
                reason: "bye".into(),
            })))
            .await;
    })
    .into_response()
}

async fn proxy_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    request: Request<Body>,
) -> Response {
    proxy_ws_inner(state, request, ws).await
}

async fn proxy_ws_path(
    Path(_): Path<String>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    request: Request<Body>,
) -> Response {
    proxy_ws_inner(state, request, ws).await
}

#[cfg(test)]
mod tests {
    use super::parse_ports;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parse_ports_defaults_to_gateway_and_backend() {
        assert_eq!(parse_ports(&args(&["serve"])), (3456, 3457));
    }

    #[test]
    fn parse_ports_accepts_space_and_equals_forms() {
        assert_eq!(
            parse_ports(&args(&["serve", "--port", "8080"])),
            (8080, 3457)
        );
        assert_eq!(parse_ports(&args(&["serve", "--port=9090"])), (9090, 3457));
        assert_eq!(
            parse_ports(&args(&["serve", "--port", "8080", "--backend", "8081"])),
            (8080, 8081)
        );
        assert_eq!(
            parse_ports(&args(&["serve", "--port=9090", "--backend=9091"])),
            (9090, 9091)
        );
        assert_eq!(
            parse_ports(&args(&["serve", "--backend", "4000"])),
            (3456, 4000)
        );
        assert_eq!(
            parse_ports(&args(&["serve", "--backend=5000"])),
            (3456, 5000)
        );
    }
}

#[cfg(unix)]
async fn install_shutdown_signal(sender: broadcast::Sender<()>) {
    use tokio::signal::unix::{signal, SignalKind};

    let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            let _ = sender.send(());
        }
        _ = terminate.recv() => {
            let _ = sender.send(());
        }
    }
}

#[cfg(not(unix))]
async fn install_shutdown_signal(sender: broadcast::Sender<()>) {
    let _ = tokio::signal::ctrl_c().await;
    let _ = sender.send(());
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let (port, backend_port) = parse_ports(&args);

    let client = Client::builder(TokioExecutor::new()).build(HttpConnector::new());
    let (shutdown_sender, _) = broadcast::channel(16);
    let state = AppState {
        port,
        backend_port,
        client: Arc::new(client),
        shutdown: shutdown_sender,
    };

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/ws", get(proxy_ws))
        .route("/ws/{*path}", get(proxy_ws_path))
        .fallback(proxy_http)
        .layer(middleware::from_fn(log_request))
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind :{port}: {error}");
            process::exit(1);
        }
    };

    println!("listening on :{port}");

    let mut shutdown = state.shutdown.subscribe();
    tokio::spawn(install_shutdown_signal(state.shutdown.clone()));

    let server = axum::serve(listener, app);
    if let Err(error) = server
        .with_graceful_shutdown(async move {
            let _ = shutdown.recv().await;
        })
        .await
    {
        eprintln!("server error: {error}");
        process::exit(1);
    }
}
