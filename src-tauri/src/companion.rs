//! LAN companion gateway: HTTP + WebSocket for the phone PWA.
//! Token lives in ~/.grok-builder/companion.json (0600), never in config.json or logs.

use crate::commands::{self, AppState, AttachmentInput};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    net::TcpListener,
    sync::{broadcast, oneshot},
};

const DEFAULT_PORT: u16 = 8788;
const VITE_ORIGIN: &str = "http://127.0.0.1:1420";

static EVENT_TX: OnceLock<broadcast::Sender<Value>> = OnceLock::new();
static LIVE: OnceLock<Mutex<LiveState>> = OnceLock::new();
static PROMPT_BUSY: AtomicBool = AtomicBool::new(false);
static PROMPT_EPOCH: AtomicU64 = AtomicU64::new(0);
static ENABLED: AtomicBool = AtomicBool::new(false);
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);
static AUTH_GENERATION: AtomicU64 = AtomicU64::new(1);
static CURRENT_TOKEN: Mutex<String> = Mutex::new(String::new());
static SHUTDOWN: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveState {
    pub cwd: String,
    pub session_id: Option<String>,
    pub busy: bool,
    pub mode: String,
    pub model: String,
    pub effort: String,
}

impl Default for LiveState {
    fn default() -> Self {
        Self {
            cwd: String::new(),
            session_id: None,
            busy: false,
            mode: "plan".into(),
            model: String::new(),
            effort: String::new(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    pub urls: Vec<String>,
    pub lan_ips: Vec<String>,
    pub qr_svg: String,
}

#[derive(Clone)]
struct WsCtx {
    app: AppHandle,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanionStore {
    enabled: bool,
    port: u16,
    token: String,
}

fn event_tx() -> broadcast::Sender<Value> {
    EVENT_TX
        .get_or_init(|| {
            let (tx, _) = broadcast::channel(256);
            tx
        })
        .clone()
}

fn live_lock() -> &'static Mutex<LiveState> {
    LIVE.get_or_init(|| Mutex::new(LiveState::default()))
}

pub fn live_snapshot() -> LiveState {
    live_lock().lock().map(|g| g.clone()).unwrap_or_default()
}

pub fn patch_live(
    cwd: Option<String>,
    session_id: Option<Option<String>>,
    busy: Option<bool>,
    mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) {
    if let Ok(mut g) = live_lock().lock() {
        if let Some(v) = cwd {
            g.cwd = v;
        }
        if let Some(v) = session_id {
            g.session_id = v;
        }
        if let Some(v) = busy {
            g.busy = v;
            PROMPT_BUSY.store(v, Ordering::SeqCst);
        }
        if let Some(v) = mode {
            g.mode = v;
        }
        if let Some(v) = model {
            g.model = v;
        }
        if let Some(v) = effort {
            g.effort = v;
        }
    }
}

pub fn set_prompt_busy(busy: bool) {
    if !busy {
        PROMPT_EPOCH.fetch_add(1, Ordering::SeqCst);
    }
    patch_live(None, None, Some(busy), None, None, None);
}

pub fn try_begin_prompt() -> Option<u64> {
    if PROMPT_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let epoch = PROMPT_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut g) = live_lock().lock() {
            g.busy = true;
        }
        Some(epoch)
    } else {
        None
    }
}

pub fn finish_prompt(epoch: u64) -> bool {
    if PROMPT_EPOCH.load(Ordering::SeqCst) == epoch {
        patch_live(None, None, Some(false), None, None, None);
        true
    } else {
        false
    }
}

pub fn emit_acp(app: &AppHandle, payload: Value) {
    let _ = app.emit("acp-event", &payload);
    let _ = event_tx().send(json!({"event":"acp-event","payload":payload}));
}

pub fn emit_event(app: &AppHandle, event: &str, payload: &Value) {
    let _ = app.emit(event, payload);
    let _ = event_tx().send(json!({"event": event, "payload": payload}));
}

pub fn emit_state(app: &AppHandle) {
    let snap = serde_json::to_value(live_snapshot()).unwrap_or(Value::Null);
    let _ = app.emit("companion-state", &snap);
    let _ = event_tx().send(json!({"event":"companion-state","payload":snap}));
}

fn companion_path() -> Result<PathBuf, String> {
    Ok(crate::config::app_home()?.join("companion.json"))
}

fn write_store(enabled: bool, port: u16, token: &str) -> Result<(), String> {
    let path = companion_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&json!({
        "enabled": enabled,
        "port": port,
        "token": token,
        "boundAt": chrono_now(),
    }))
    .map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_store() -> Result<CompanionStore, String> {
    let raw = fs::read_to_string(companion_path()?).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn chrono_now() -> String {
    // Avoid extra crate: RFC3339-ish local via UNIX seconds is enough for a stamp.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn new_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn valid_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn lan_ips() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(v4) = iface.ip() {
                let o = v4.octets();
                if o[0] == 169 && o[1] == 254 {
                    continue;
                }
                out.push(v4.to_string());
            }
        }
    }
    out
}

fn qr_svg(url: &str) -> String {
    let Ok(code) = qrcode::QrCode::new(url.as_bytes()) else {
        return String::new();
    };
    code.render::<qrcode::render::svg::Color>()
        .min_dimensions(180, 180)
        .dark_color(qrcode::render::svg::Color("#1a1c1f"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build()
}

fn urls_for(port: u16, token: &str) -> Vec<String> {
    lan_ips()
        .into_iter()
        .map(|ip| format!("http://{ip}:{port}/m#t={token}"))
        .collect()
}

fn current_status() -> CompanionStatus {
    let enabled = ENABLED.load(Ordering::SeqCst);
    let port = BOUND_PORT.load(Ordering::SeqCst);
    let token = CURRENT_TOKEN
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_default();
    let urls = if enabled && port > 0 && !token.is_empty() {
        urls_for(port, &token)
    } else {
        Vec::new()
    };
    let qr = urls.first().map(|u| qr_svg(u)).unwrap_or_default();
    CompanionStatus {
        enabled,
        port,
        token,
        qr_svg: qr,
        lan_ips: lan_ips(),
        urls,
    }
}

fn token_ok(got: &str) -> bool {
    let expected = CURRENT_TOKEN
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_default();
    !expected.is_empty() && got == expected
}

fn authorization_matches(
    enabled: bool,
    expected_token: &str,
    presented_token: &str,
    current_generation: u64,
    connection_generation: u64,
) -> bool {
    enabled
        && !expected_token.is_empty()
        && expected_token == presented_token
        && current_generation == connection_generation
}

fn connection_authorized(token: &str, generation: u64) -> bool {
    let expected = CURRENT_TOKEN
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_default();
    authorization_matches(
        ENABLED.load(Ordering::SeqCst),
        &expected,
        token,
        AUTH_GENERATION.load(Ordering::SeqCst),
        generation,
    )
}

fn workspace_is_registered(cwd: &str, candidates: impl IntoIterator<Item = String>) -> bool {
    let requested = PathBuf::from(cwd).canonicalize().ok();
    let Some(requested) = requested else {
        return false;
    };
    candidates
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .filter_map(|p| PathBuf::from(p).canonicalize().ok())
        .any(|p| p == requested)
}

fn ensure_registered_workspace(cwd: &str) -> Result<(), String> {
    let cfg = crate::config::read_config().unwrap_or_default();
    let live = live_snapshot().cwd;
    let candidates = std::iter::once(cfg.last_cwd)
        .chain(cfg.recent_cwds)
        .chain(std::iter::once(live));
    if workspace_is_registered(cwd, candidates) {
        Ok(())
    } else {
        Err(crate::i18n::t("该目录尚未在桌面端登记为工作区", "This folder is not a registered desktop workspace"))
    }
}

fn whitelist(cmd: &str) -> bool {
    matches!(
        cmd,
        "core_status"
            | "get_app_config"
            | "list_sessions"
            | "search_sessions"
            | "start_session"
            | "send_prompt"
            | "cancel_session"
            | "permission_reply"
            | "ask_reply"
            | "exit_plan_reply"
            | "set_session_option"
            | "set_session_mode"
            | "rename_session"
            | "delete_session"
            | "fork_session"
            | "session_usage"
            | "workspace_usage"
            | "export_session"
            | "list_workdir_tree"
            | "read_workdir_file"
    )
}

fn arg<'a>(args: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    args.get(camel).or_else(|| args.get(snake))
}

fn arg_str(args: &Value, camel: &str, snake: &str) -> Result<String, String> {
    arg(args, camel, snake)
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| (if crate::i18n::is_en() { format!("Missing argument {camel}") } else { format!("缺少参数 {camel}") }))
}

fn arg_str_or(args: &Value, camel: &str, snake: &str, default: &str) -> String {
    arg(args, camel, snake)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_string()
}

fn arg_opt_str(args: &Value, camel: &str, snake: &str) -> Option<String> {
    match arg(args, camel, snake) {
        None | Some(Value::Null) => None,
        Some(v) => v.as_str().map(|s| s.to_string()),
    }
}

fn arg_opt_bool(args: &Value, camel: &str, snake: &str) -> Option<bool> {
    arg(args, camel, snake).and_then(Value::as_bool)
}

fn arg_u64(args: &Value, camel: &str, snake: &str) -> Result<u64, String> {
    arg(args, camel, snake)
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i as u64)))
        .ok_or_else(|| (if crate::i18n::is_en() { format!("Missing argument {camel}") } else { format!("缺少参数 {camel}") }))
}

fn to_val<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

async fn dispatch(app: &AppHandle, cmd: &str, args: &Value) -> Result<Value, String> {
    if !whitelist(cmd) {
        return Err((if crate::i18n::is_en() { format!("Command is not available on the phone: {cmd}") } else { format!("命令未对手机开放：{cmd}") }));
    }
    let state = app.state::<Arc<AppState>>();
    match cmd {
        "core_status" => to_val(commands::core_status().await?),
        "get_app_config" => to_val(crate::config::get_app_config()?),
        "list_sessions" => {
            let cwd = arg_str(args, "cwd", "cwd")?;
            ensure_registered_workspace(&cwd)?;
            to_val(commands::list_sessions(cwd).await?)
        }
        "search_sessions" => {
            let cwd = arg_str(args, "cwd", "cwd")?;
            ensure_registered_workspace(&cwd)?;
            let query = arg_str_or(args, "query", "query", "");
            to_val(commands::search_sessions(cwd, query).await?)
        }
        "start_session" => {
            let cwd = arg_str(args, "cwd", "cwd")?;
            ensure_registered_workspace(&cwd)?;
            let session_id = arg_opt_str(args, "sessionId", "session_id");
            let model = arg_str_or(args, "model", "model", "");
            let effort = arg_str_or(args, "effort", "effort", "");
            let permission_mode = arg_str_or(args, "permissionMode", "permission_mode", "plan");
            let restore_code = arg_opt_bool(args, "restoreCode", "restore_code");
            commands::start_session(
                app.clone(),
                state,
                cwd,
                session_id,
                model,
                effort,
                permission_mode,
                restore_code,
            )
            .await
        }
        "send_prompt" => {
            let text = arg_str(args, "text", "text")?;
            let attachments = arg(args, "attachments", "attachments")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<AttachmentInput>>(v).ok());
            commands::send_prompt(app.clone(), state, text, attachments).await
        }
        "cancel_session" => to_val(commands::cancel_session(app.clone(), state).await?),
        "permission_reply" => {
            let request_id = arg_u64(args, "requestId", "request_id")?;
            let option_id = arg_opt_str(args, "optionId", "option_id");
            to_val(commands::permission_reply(state, request_id, option_id).await?)
        }
        "ask_reply" => {
            let request_id = arg_u64(args, "requestId", "request_id")?;
            let outcome = arg_str(args, "outcome", "outcome")?;
            let answers = arg(args, "answers", "answers").cloned();
            to_val(commands::ask_reply(state, request_id, outcome, answers).await?)
        }
        "exit_plan_reply" => {
            let request_id = arg_u64(args, "requestId", "request_id")?;
            let outcome = arg_str(args, "outcome", "outcome")?;
            let feedback = arg_opt_str(args, "feedback", "feedback");
            to_val(commands::exit_plan_reply(state, request_id, outcome, feedback).await?)
        }
        "set_session_option" => {
            let config_id = arg_str(args, "configId", "config_id")?;
            let value = arg_str(args, "value", "value")?;
            commands::set_session_option(state, config_id, value).await
        }
        "set_session_mode" => {
            let mode_id = arg_str(args, "modeId", "mode_id")?;
            commands::set_session_mode(app.clone(), state, mode_id).await
        }
        "rename_session" => {
            let cwd = arg_str(args, "cwd", "cwd")?;
            ensure_registered_workspace(&cwd)?;
            let session_id = arg_str(args, "sessionId", "session_id")?;
            let title = arg_str(args, "title", "title")?;
            to_val(commands::rename_session(app.clone(), state, cwd, session_id, title).await?)
        }
        "delete_session" => {
            let session_id = arg_str(args, "sessionId", "session_id")?;
            to_val(commands::delete_session(session_id).await?)
        }
        "fork_session" => {
            let cwd = arg_str(args, "cwd", "cwd")?;
            ensure_registered_workspace(&cwd)?;
            let session_id = arg_str(args, "sessionId", "session_id")?;
            commands::fork_session(app.clone(), state, cwd, session_id).await
        }
        "session_usage" => {
            let session_id = arg_str(args, "sessionId", "session_id")?;
            to_val(commands::session_usage(session_id).await?)
        }
        "workspace_usage" => {
            let cwd = arg_str(args, "cwd", "cwd")?;
            ensure_registered_workspace(&cwd)?;
            to_val(commands::workspace_usage(cwd).await?)
        }
        "export_session" => {
            let session_id = arg_str(args, "sessionId", "session_id")?;
            to_val(commands::export_session(session_id).await?)
        }
        "list_workdir_tree" => {
            let cwd = arg_str(args, "cwd", "cwd")?;
            ensure_registered_workspace(&cwd)?;
            to_val(crate::git_files::list_workdir_tree(cwd).await?)
        }
        "read_workdir_file" => {
            let cwd = arg_str(args, "cwd", "cwd")?;
            ensure_registered_workspace(&cwd)?;
            let path = arg_str(args, "path", "path")?;
            to_val(crate::git_files::read_workdir_file(cwd, path)?)
        }
        _ => Err((if crate::i18n::is_en() { format!("Unknown command {cmd}") } else { format!("未知命令 {cmd}") })),
    }
}

async fn handle_socket(socket: WebSocket, ctx: WsCtx, token: String, generation: u64) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = event_tx().subscribe();
    let snap = serde_json::to_value(live_snapshot()).unwrap_or(Value::Null);
    let hello = json!({"event":"companion-state","payload":snap}).to_string();
    if sender.send(Message::text(hello)).await.is_err() {
        return;
    }
    let mut auth_tick = tokio::time::interval(std::time::Duration::from_secs(1));

    loop {
        tokio::select! {
            _ = auth_tick.tick() => {
                if !connection_authorized(&token, generation) {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !connection_authorized(&token, generation) {
                            let _ = sender.send(Message::Close(None)).await;
                            break;
                        }
                        let parsed: Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                let err = json!({"ok":false,"error":(if crate::i18n::is_en() { format!("Invalid JSON: {e}") } else { format!("JSON 无效：{e}") })});
                                if sender.send(Message::text(err.to_string())).await.is_err() { break; }
                                continue;
                            }
                        };
                        let id = parsed.get("id").cloned().unwrap_or(Value::Null);
                        let cmd = parsed.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
                        let args = parsed.get("args").cloned().unwrap_or_else(|| json!({}));
                        let reply = match dispatch(&ctx.app, &cmd, &args).await {
                            Ok(result) => json!({"id":id,"ok":true,"result":result}),
                            Err(error) => json!({"id":id,"ok":false,"error":error}),
                        };
                        if sender.send(Message::text(reply.to_string())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        if sender.send(Message::Pong(p)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            ev = rx.recv() => {
                match ev {
                    Ok(v) => {
                        if sender.send(Message::text(v.to_string())).await.is_err() { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Query(q): Query<HashMap<String, String>>,
    State(ctx): State<WsCtx>,
) -> Response {
    let t = q.get("t").cloned().unwrap_or_default();
    if !token_ok(&t) {
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    }
    let generation = AUTH_GENERATION.load(Ordering::SeqCst);
    let ctx = WsCtx {
        app: ctx.app.clone(),
    };
    ws.on_upgrade(move |s| handle_socket(s, ctx, t, generation))
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn static_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.clone());
        roots.push(dir.join("_up_"));
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    roots.push(manifest.join("../dist"));
    roots.push(manifest.join("../public"));
    roots
}

fn map_spa_path(path: &str) -> &str {
    if path == "/" || path == "/m" || path == "/m/" || path.starts_with("/m/") {
        "/index.html"
    } else {
        path
    }
}

async fn proxy_vite(path: &str, query: Option<&str>) -> Response {
    let mapped = map_spa_path(path);
    let q = query.map(|s| format!("?{s}")).unwrap_or_default();
    let url = format!("{VITE_ORIGIN}{mapped}{q}");
    match reqwest::get(&url).await {
        Ok(r) => {
            let status =
                StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let ct = r
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            match r.bytes().await {
                Ok(bytes) => Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, ct)
                    .body(Body::from(bytes.to_vec()))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
                Err(_) => StatusCode::BAD_GATEWAY.into_response(),
            }
        }
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn serve_static(app: &AppHandle, path: &str) -> Response {
    let mapped = map_spa_path(path).trim_start_matches('/');
    for root in static_roots(app) {
        let file = root.join(mapped);
        if file.is_file() {
            if let Ok(bytes) = fs::read(&file) {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, mime_of(mapped))
                    .body(Body::from(bytes))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
            }
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

async fn http_get(uri: Uri, State(ctx): State<WsCtx>) -> Response {
    let path = uri.path();
    if cfg!(debug_assertions) {
        let proxied = proxy_vite(path, uri.query()).await;
        if proxied.status() != StatusCode::BAD_GATEWAY {
            return proxied;
        }
    }
    serve_static(&ctx.app, path).await
}

async fn run_server(app: AppHandle, port: u16, shutdown: oneshot::Receiver<()>) {
    let ctx = WsCtx { app: app.clone() };
    let router = Router::new()
        .route("/ws", get(ws_upgrade))
        .fallback(http_get)
        .with_state(ctx);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            let _ = app.emit("core-log", (if crate::i18n::is_en() { format!("Phone companion could not bind {addr}: {e}") } else { format!("手机联动无法绑定 {addr}：{e}") }));
            ENABLED.store(false, Ordering::SeqCst);
            BOUND_PORT.store(0, Ordering::SeqCst);
            return;
        }
    };
    let actual = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    BOUND_PORT.store(actual, Ordering::SeqCst);
    ENABLED.store(true, Ordering::SeqCst);

    let _ = axum::serve(listener, router.into_make_service())
        .with_graceful_shutdown(async {
            let _ = shutdown.await;
        })
        .await;
    ENABLED.store(false, Ordering::SeqCst);
    BOUND_PORT.store(0, Ordering::SeqCst);
}

fn stop_locked() {
    if let Ok(mut g) = SHUTDOWN.lock() {
        if let Some(tx) = g.take() {
            let _ = tx.send(());
        }
    }
    ENABLED.store(false, Ordering::SeqCst);
    BOUND_PORT.store(0, Ordering::SeqCst);
}

pub fn restore_on_launch(app: AppHandle) {
    let Ok(saved) = read_store() else { return };
    if !saved.enabled || saved.port == 0 || !valid_token(&saved.token) {
        return;
    }
    if let Ok(mut g) = CURRENT_TOKEN.lock() {
        *g = saved.token;
    }
    AUTH_GENERATION.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    if let Ok(mut g) = SHUTDOWN.lock() {
        *g = Some(tx);
    }
    tauri::async_runtime::spawn(async move {
        run_server(app, saved.port, rx).await;
    });
}

#[tauri::command]
pub async fn companion_status() -> Result<CompanionStatus, String> {
    Ok(current_status())
}

#[tauri::command]
pub async fn companion_enable(
    app: AppHandle,
    port: Option<u16>,
) -> Result<CompanionStatus, String> {
    if ENABLED.load(Ordering::SeqCst) {
        return Ok(current_status());
    }
    stop_locked();
    let port = port.unwrap_or(DEFAULT_PORT);
    let token = read_store()
        .ok()
        .filter(|s| s.enabled && valid_token(&s.token))
        .map(|s| s.token)
        .unwrap_or_else(new_token);
    AUTH_GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut g) = CURRENT_TOKEN.lock() {
        *g = token.clone();
    }
    write_store(true, port, &token)?;
    let (tx, rx) = oneshot::channel();
    if let Ok(mut g) = SHUTDOWN.lock() {
        *g = Some(tx);
    }
    let app2 = app.clone();
    tokio::spawn(async move {
        run_server(app2, port, rx).await;
    });
    // bind is async; wait briefly so status has the real port
    for _ in 0..20 {
        if ENABLED.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    if !ENABLED.load(Ordering::SeqCst) {
        return Err(crate::i18n::t("无法在本机启动手机联动端口（可能被占用或被防火墙拦截）", "Could not open the phone companion port (it may be in use or blocked by a firewall)"));
    }
    let st = current_status();
    write_store(true, st.port, &st.token)?;
    Ok(st)
}

#[tauri::command]
pub async fn companion_disable() -> Result<CompanionStatus, String> {
    AUTH_GENERATION.fetch_add(1, Ordering::SeqCst);
    stop_locked();
    if let Ok(mut g) = CURRENT_TOKEN.lock() {
        g.clear();
    }
    let _ = write_store(false, 0, "");
    Ok(current_status())
}

#[tauri::command]
pub async fn companion_rotate_token(app: AppHandle) -> Result<CompanionStatus, String> {
    if !ENABLED.load(Ordering::SeqCst) {
        return Err(crate::i18n::t("请先打开手机联动", "Turn on phone companion first"));
    }
    let port = BOUND_PORT.load(Ordering::SeqCst);
    let token = new_token();
    if let Ok(mut g) = CURRENT_TOKEN.lock() {
        *g = token.clone();
    }
    AUTH_GENERATION.fetch_add(1, Ordering::SeqCst);
    write_store(true, port, &token)?;
    let _ = app.emit("core-log", crate::i18n::t("手机联动令牌已更换，旧连接已撤销", "Phone companion token rotated. Old connections were closed"));
    Ok(current_status())
}

#[cfg(test)]
mod tests {
    use super::{authorization_matches, valid_token, workspace_is_registered};

    #[test]
    fn companion_tokens_are_fixed_length_hex() {
        assert!(valid_token("0123456789abcdef0123456789abcdef"));
        assert!(!valid_token("short"));
        assert!(!valid_token("0123456789abcdef0123456789abcdeg"));
    }

    #[test]
    fn revoked_connection_generation_is_rejected() {
        let token = "0123456789abcdef0123456789abcdef";
        assert!(authorization_matches(true, token, token, 7, 7));
        assert!(!authorization_matches(true, token, token, 8, 7));
        assert!(!authorization_matches(false, token, token, 7, 7));
        assert!(!authorization_matches(true, token, "wrong", 7, 7));
    }

    #[test]
    fn remote_workspace_must_be_explicitly_registered() {
        let project = std::env::current_dir().expect("current directory");
        let parent = project.parent().expect("parent directory");
        assert!(workspace_is_registered(
            &project.to_string_lossy(),
            vec![project.to_string_lossy().into_owned()]
        ));
        assert!(!workspace_is_registered(
            &parent.to_string_lossy(),
            vec![project.to_string_lossy().into_owned()]
        ));
    }
}
