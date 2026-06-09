use std::{env, net::SocketAddr, process, sync::Arc, time::Instant};

use axum::{
    body::Body,
    extract::{
        ws::{CloseCode, CloseFrame, Message as AxumMessage, WebSocketUpgrade},
        Path, State,
    },
    http::{
        header::{
            HeaderMap, HeaderName, CONNECTION, CONTENT_LENGTH, HOST, PROXY_AUTHENTICATE,
            PROXY_AUTHORIZATION, TE, TRAILER, TRANSFER_ENCODING, UPGRADE,
        },
        Request, StatusCode, Uri,
    },
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
    backend_port: Option<u16>,
    verbosity: u8,
    client: Arc<BackendClient>,
    shutdown: broadcast::Sender<()>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GatewayArgs {
    port: u16,
    backend_port: Option<u16>,
    verbosity: u8,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    gateway: &'static str,
    backend: String,
    port: u16,
}

#[derive(Serialize)]
struct StatusResponse {
    ok: bool,
    gateway: &'static str,
    backend: Option<String>,
    backend_status: &'static str,
    port: u16,
    status: &'static str,
}

fn clamp_verbosity(value: u8) -> u8 {
    value.clamp(0, 4)
}

fn backend_label(state: &AppState) -> Option<String> {
    state.backend_port.map(|port| format!("bun:{port}"))
}

fn backend_label_or_standalone(state: &AppState) -> String {
    backend_label(state).unwrap_or_else(|| "standalone".to_string())
}

fn status_payload(state: &AppState, backend_reachable: bool) -> StatusResponse {
    let (ok, backend_status, status) = match state.backend_port {
        Some(_) if backend_reachable => (true, "connected", "ok"),
        Some(_) => (false, "unavailable", "degraded"),
        None => (true, "unconfigured", "standalone"),
    };

    StatusResponse {
        ok,
        gateway: "rust",
        backend: backend_label(state),
        backend_status,
        port: state.port,
        status,
    }
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        gateway: "rust",
        backend: backend_label_or_standalone(&state),
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
    eprintln!(
        "usage: maw-gateway serve [--port PORT] [--backend PORT] [--verbose N|-v|-vv|-vvv|-vvvv]"
    );
    process::exit(2);
}

fn parse_args(args: &[String]) -> GatewayArgs {
    if args.first().map(String::as_str) != Some("serve") {
        usage();
    }

    let mut port: Option<u16> = None;
    let mut backend_port: Option<u16> = None;
    let mut verbosity = 1u8;
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
            "--verbose" => {
                let next = args.get(index + 1).map(String::as_str);
                match next {
                    Some(value) if !value.starts_with('-') => {
                        verbosity = value
                            .parse::<u8>()
                            .map(clamp_verbosity)
                            .unwrap_or_else(|_| usage());
                        index += 1;
                    }
                    _ => {
                        verbosity = verbosity.max(2);
                    }
                }
            }
            value if value.starts_with("--verbose=") => {
                verbosity = value["--verbose=".len()..]
                    .parse::<u8>()
                    .map(clamp_verbosity)
                    .unwrap_or_else(|_| usage());
            }
            value if value.starts_with("-v") && value.chars().all(|ch| ch == '-' || ch == 'v') => {
                verbosity = clamp_verbosity(verbosity.saturating_add((value.len() - 1) as u8));
            }
            _ => usage(),
        }
        index += 1;
    }

    GatewayArgs {
        port: port.unwrap_or(3456),
        backend_port,
        verbosity,
    }
}

fn build_backend_http_uri(state: &AppState, uri: &Uri) -> Option<HyperUri> {
    let backend_port = state.backend_port?;
    let path_and_query = uri
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or("/");
    let target = format!("http://127.0.0.1:{backend_port}{path_and_query}");
    Some(target.parse::<HyperUri>().expect("backend URI"))
}

fn build_backend_ws_uri(state: &AppState, uri: &Uri) -> Option<String> {
    let backend_port = state.backend_port?;
    let path_and_query = uri
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or("/");
    Some(format!("ws://127.0.0.1:{backend_port}{path_and_query}"))
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

fn strip_connection_listed_headers(headers: &mut HeaderMap) {
    let connection_tokens = headers
        .get(CONNECTION)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    headers.remove(CONNECTION);

    for token in connection_tokens {
        if let Ok(name) = HeaderName::from_bytes(token.as_bytes()) {
            headers.remove(name);
        }
    }
}

fn strip_request_proxy_headers(headers: &mut HeaderMap) {
    strip_connection_listed_headers(headers);
    for name in [
        HOST,
        CONTENT_LENGTH,
        HeaderName::from_static("keep-alive"),
        PROXY_AUTHENTICATE,
        PROXY_AUTHORIZATION,
        TE,
        TRAILER,
        TRANSFER_ENCODING,
        UPGRADE,
    ] {
        headers.remove(name);
    }
}

fn strip_response_proxy_headers(headers: &mut HeaderMap) {
    strip_connection_listed_headers(headers);
    for name in [
        CONTENT_LENGTH,
        HeaderName::from_static("keep-alive"),
        PROXY_AUTHENTICATE,
        PROXY_AUTHORIZATION,
        TE,
        TRAILER,
        TRANSFER_ENCODING,
        UPGRADE,
    ] {
        headers.remove(name);
    }
}

async fn build_http_request(
    request: Request<Body>,
    target: HyperUri,
) -> Result<HyperRequest<Full<Bytes>>, StatusCode> {
    let (mut parts, body) = request.into_parts();
    let payload = body
        .collect()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .to_bytes();
    strip_request_proxy_headers(&mut parts.headers);

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
    let is_root = req.uri().path() == "/";
    let Some(target) = build_backend_http_uri(&state, req.uri()) else {
        return if is_root {
            Json(status_payload(&state, false)).into_response()
        } else {
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        };
    };

    let request = match build_http_request(req, target).await {
        Ok(request) => request,
        Err(status) => return status.into_response(),
    };

    let mut upstream = match state.client.request(request).await {
        Ok(response) => response,
        Err(error) => {
            eprintln!("backend request failed: {error}");
            return if is_root {
                Json(status_payload(&state, false)).into_response()
            } else {
                StatusCode::BAD_GATEWAY.into_response()
            };
        }
    };

    let status = upstream.status();
    let mut headers = std::mem::take(upstream.headers_mut());
    strip_response_proxy_headers(&mut headers);
    let body = match upstream
        .into_body()
        .collect()
        .await
        .map(|collected| collected.to_bytes())
    {
        Ok(body) => body,
        Err(error) => {
            eprintln!("backend body read failed: {error}");
            return if is_root {
                Json(status_payload(&state, false)).into_response()
            } else {
                StatusCode::BAD_GATEWAY.into_response()
            };
        }
    };

    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

async fn proxy_ws_inner(state: AppState, request: Request<Body>, ws: WebSocketUpgrade) -> Response {
    let Some(target) = build_backend_ws_uri(&state, request.uri()) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
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

fn app(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/ws", get(proxy_ws))
        .route("/ws/{*path}", get(proxy_ws_path))
        .fallback(proxy_http)
        .layer(middleware::from_fn(log_request))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::{app, parse_args, AppState, GatewayArgs};
    use axum::{routing::get, Router};
    use http_body_util::{BodyExt, Full};
    use hyper::{
        body::Bytes as HyperBytes, header::CONTENT_LENGTH, Request as HyperRequest, StatusCode,
        Uri as HyperUri,
    };
    use hyper_util::client::legacy::{connect::HttpConnector, Client};
    use hyper_util::rt::TokioExecutor;
    use tokio::{net::TcpListener, sync::broadcast, task::JoinHandle};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn test_client() -> Client<HttpConnector, Full<HyperBytes>> {
        Client::builder(TokioExecutor::new()).build(HttpConnector::new())
    }

    async fn get_root(port: u16) -> (StatusCode, String) {
        let client = test_client();
        let uri = format!("http://127.0.0.1:{port}/")
            .parse::<HyperUri>()
            .expect("root uri");
        let request = HyperRequest::builder()
            .method("GET")
            .uri(uri)
            .body(Full::new(HyperBytes::new()))
            .expect("root request");
        let response = client.request(request).await.expect("root response");
        let status = response.status();
        let body = response
            .into_body()
            .collect()
            .await
            .expect("root body")
            .to_bytes();
        (status, String::from_utf8(body.to_vec()).expect("utf8 body"))
    }

    async fn spawn_gateway(
        backend_port: Option<u16>,
    ) -> (u16, broadcast::Sender<()>, JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind gateway");
        let port = listener.local_addr().expect("gateway addr").port();
        let (shutdown, _) = broadcast::channel(16);
        let state = AppState {
            port,
            backend_port,
            verbosity: 1,
            client: std::sync::Arc::new(test_client()),
            shutdown: shutdown.clone(),
        };

        let mut shutdown_rx = shutdown.subscribe();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app(state))
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.recv().await;
                })
                .await;
        });

        (port, shutdown, handle)
    }

    #[test]
    fn parse_args_defaults_to_standalone_gateway() {
        assert_eq!(
            parse_args(&args(&["serve"])),
            GatewayArgs {
                port: 3456,
                backend_port: None,
                verbosity: 1,
            }
        );
    }

    #[test]
    fn parse_args_accepts_space_and_equals_forms() {
        assert_eq!(
            parse_args(&args(&["serve", "--port", "8080"])),
            GatewayArgs {
                port: 8080,
                backend_port: None,
                verbosity: 1,
            }
        );
        assert_eq!(
            parse_args(&args(&["serve", "--port=9090"])),
            GatewayArgs {
                port: 9090,
                backend_port: None,
                verbosity: 1,
            }
        );
        assert_eq!(
            parse_args(&args(&["serve", "--port", "8080", "--backend", "8081"])),
            GatewayArgs {
                port: 8080,
                backend_port: Some(8081),
                verbosity: 1,
            }
        );
        assert_eq!(
            parse_args(&args(&["serve", "--port=9090", "--backend=9091"])),
            GatewayArgs {
                port: 9090,
                backend_port: Some(9091),
                verbosity: 1,
            }
        );
        assert_eq!(
            parse_args(&args(&["serve", "--backend", "4000"])),
            GatewayArgs {
                port: 3456,
                backend_port: Some(4000),
                verbosity: 1,
            }
        );
        assert_eq!(
            parse_args(&args(&["serve", "--backend=5000"])),
            GatewayArgs {
                port: 3456,
                backend_port: Some(5000),
                verbosity: 1,
            }
        );
    }

    #[test]
    fn parse_args_tracks_verbosity_forms() {
        assert_eq!(parse_args(&args(&["serve", "--verbose"])).verbosity, 2);
        assert_eq!(parse_args(&args(&["serve", "--verbose", "4"])).verbosity, 4);
        assert_eq!(parse_args(&args(&["serve", "--verbose=3"])).verbosity, 3);
        assert_eq!(parse_args(&args(&["serve", "-v"])).verbosity, 2);
        assert_eq!(parse_args(&args(&["serve", "-vv"])).verbosity, 3);
        assert_eq!(parse_args(&args(&["serve", "-vvv"])).verbosity, 4);
        assert_eq!(parse_args(&args(&["serve", "-v", "-v"])).verbosity, 3);
        assert_eq!(parse_args(&args(&["serve", "-vvvv"])).verbosity, 4);
    }

    #[tokio::test]
    async fn root_returns_json_status_when_gateway_is_standalone() {
        let (port, shutdown, handle) = spawn_gateway(None).await;

        let (status, body) = get_root(port).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"gateway\":\"rust\""), "body was {body}");
        assert!(
            body.contains("\"status\":\"standalone\""),
            "body was {body}"
        );
        assert!(body.contains("\"backend\":null"), "body was {body}");

        let _ = shutdown.send(());
        let _ = handle.await;
    }

    #[tokio::test]
    async fn root_proxies_to_backend_when_available() {
        let repeated = "<p>rust gateway root proxy regression</p>".repeat(48);
        let html = format!("<!doctype html><html><body><main>{repeated}</main></body></html>");
        let expected_len = html.len();
        let backend_listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind backend");
        let backend_port = backend_listener.local_addr().expect("backend addr").port();
        let expected_html = html.clone();
        let backend = tokio::spawn(async move {
            let html = html.clone();
            let app = Router::new().route(
                "/",
                get(move || {
                    let html = html.clone();
                    async move { html }
                }),
            );
            let _ = axum::serve(backend_listener, app).await;
        });

        let client = test_client();
        let (port, shutdown, handle) = spawn_gateway(Some(backend_port)).await;
        let uri = format!("http://127.0.0.1:{port}/")
            .parse::<HyperUri>()
            .expect("root uri");
        let request = HyperRequest::builder()
            .method("GET")
            .uri(uri)
            .body(Full::new(HyperBytes::new()))
            .expect("root request");
        let response = client.request(request).await.expect("root response");
        let status = response.status();
        let content_length = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok());
        let body = response
            .into_body()
            .collect()
            .await
            .expect("root body")
            .to_bytes();

        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_length, Some(expected_len));
        assert!(body.len() > 1024, "body len was {}", body.len());
        assert_eq!(body.len(), expected_len);
        assert_eq!(
            String::from_utf8(body.to_vec()).expect("utf8 body"),
            expected_html
        );

        let _ = shutdown.send(());
        let _ = handle.await;
        backend.abort();
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
    let gateway_args = parse_args(&args);

    let client = Client::builder(TokioExecutor::new()).build(HttpConnector::new());
    let (shutdown_sender, _) = broadcast::channel(16);
    let state = AppState {
        port: gateway_args.port,
        backend_port: gateway_args.backend_port,
        verbosity: gateway_args.verbosity,
        client: Arc::new(client),
        shutdown: shutdown_sender,
    };

    let addr = SocketAddr::from(([127, 0, 0, 1], state.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind :{}: {}", state.port, error);
            process::exit(1);
        }
    };

    println!("listening on :{}", state.port);
    if state.verbosity >= 2 {
        eprintln!(
            "[gateway:rust] verbosity={} backend={}",
            state.verbosity,
            backend_label_or_standalone(&state)
        );
    }

    let mut shutdown = state.shutdown.subscribe();
    tokio::spawn(install_shutdown_signal(state.shutdown.clone()));

    let server = axum::serve(listener, app(state));
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
