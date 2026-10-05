use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

fn emit_acp(app: &AppHandle, payload: Value) {
    crate::companion::emit_acp(app, payload);
}
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, Mutex, OnceCell},
    time::{timeout, Duration},
};

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
struct Replay {
    collecting: AtomicBool,
    updates: std::sync::Mutex<Vec<Value>>,
}
struct Agent {
    writer: mpsc::Sender<Value>,
    child: Arc<Mutex<Child>>,
    pending: Pending,
    session_id: Option<String>,
    cwd: String,
    model: String,
    effort: String,
    perm_mode: String,
    capabilities: Value,
    available_commands: Value,
    config_options: Value,
    replay: Arc<Replay>,
    rules_key: String,
    auto_memory: bool,
    sp_enabled: bool,
}
pub struct AppState {
    agent: Mutex<Option<Agent>>,
    next_id: AtomicU64,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            agent: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }
}

static GROK_BIN: OnceCell<PathBuf> = OnceCell::const_new();
async fn grok_path() -> Result<PathBuf, String> {
    GROK_BIN.get_or_try_init(resolve_grok_path).await.cloned()
}

// superpowers 安装目录：用 `grok plugin list --json` 找 name=="superpowers" 的 path，
// 不硬编码 repo_key（如 superpowers-21e2a56d）。结果缓存进程级。
static SP_DIR: OnceCell<Option<String>> = OnceCell::const_new();
async fn superpowers_dir() -> Option<String> {
    SP_DIR
        .get_or_init(|| async {
            let dir = output(&["plugin", "list", "--json"], None)
                .await
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|v| v.as_array().cloned())
                .and_then(|arr| {
                    arr.into_iter()
                        .find(|p| p.get("name").and_then(Value::as_str) == Some("superpowers"))
                })
                .and_then(|p| p.get("path").and_then(Value::as_str).map(str::to_string))
                .filter(|p| Path::new(p).is_dir());
            dir
        })
        .await
        .clone()
}
async fn resolve_grok_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().unwrap_or_default();
    for candidate in [home.join(".grok/bin/grok"), home.join(".local/bin/grok")] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(Ok(o)) = timeout(
        Duration::from_secs(8),
        Command::new(shell).args(["-lc", "which grok"]).output(),
    )
    .await
    {
        if o.status.success() {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !p.is_empty() {
                return Ok(PathBuf::from(p));
            }
        }
    }
    Err(crate::i18n::t("未找到 grok CLI：已检查 ~/.grok/bin/grok、~/.local/bin/grok 以及登录 shell 的 PATH；请先安装 Grok CLI", "grok CLI was not found in ~/.grok/bin/grok, ~/.local/bin/grok, or the login shell PATH. Install the Grok CLI first"))
}

/// Homebrew Framework 的 Python.app 会出现在 Dock。uvx --python 3.12 会选中它。
/// 给 agent 子进程的 PATH 前面加一层 uv/uvx 包装，把 3.12 改写成 unix 解释器。
fn unix_cpython_312() -> Option<PathBuf> {
    for p in [
        "/opt/homebrew/opt/python@3.12/bin/python3.12",
        "/opt/homebrew/bin/python3.12",
        "/usr/local/opt/python@3.12/bin/python3.12",
        "/usr/local/bin/python3.12",
    ] {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    None
}

fn ensure_uv_nodock_path() -> Option<PathBuf> {
    let py = unix_cpython_312()?;
    let dir = crate::config::app_home().ok()?.join("bin");
    std::fs::create_dir_all(&dir).ok()?;
    let missing = crate::i18n::t(
        "grok-builder: 找不到真正的",
        "grok-builder: could not find",
    );
    let script = format!(
        r#"#!/bin/bash
name=$(basename "$0")
wrapdir=$(cd "$(dirname "$0")" && pwd)
REAL=""
oifs=$IFS
IFS=:
for d in $PATH; do
  IFS=$oifs
  [ "$d" = "$wrapdir" ] && continue
  if [ -x "$d/$name" ]; then REAL="$d/$name"; break; fi
done
IFS=$oifs
if [ -z "$REAL" ]; then
  echo "{missing} $name" >&2
  exit 127
fi
PY="{py}"
args=()
while [ $# -gt 0 ]; do
  if [ "$1" = "--python" ] && [ -n "${{2:-}}" ]; then
    args+=("--python")
    case "$2" in
      3.11|3.12|3.13)
        if [ -x "$PY" ]; then args+=("$PY"); else args+=("$2"); fi
        ;;
      *) args+=("$2") ;;
    esac
    shift 2
    continue
  fi
  args+=("$1")
  shift
done
exec "$REAL" "${{args[@]}}"
"#,
        missing = missing,
        py = py.display()
    );
    for name in ["uvx", "uv"] {
        let path = dir.join(name);
        let need_write = std::fs::read_to_string(&path)
            .map(|cur| cur != script)
            .unwrap_or(true);
        if need_write {
            std::fs::write(&path, &script).ok()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    Some(dir)
}

fn filter_sensitive(s: &str) -> String {
    s.lines()
        .filter(|l| !l.contains("auth.json") && !l.to_lowercase().contains("token"))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn exec(
    args: &[&str],
    cwd: Option<&str>,
    stdin_text: Option<&str>,
    secs: u64,
) -> Result<(bool, String), String> {
    let mut c = Command::new(grok_path().await?);
    c.args(args);
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    c.env("GROK_DISABLE_AUTOUPDATER", "1");
    if stdin_text.is_some() {
        c.stdin(Stdio::piped());
    }
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    if let (Some(text), Some(mut w)) = (stdin_text, child.stdin.take()) {
        let _ = w.write_all(text.as_bytes()).await;
    }
    let o = timeout(Duration::from_secs(secs), child.wait_with_output())
        .await
        .map_err(|_| crate::i18n::t("命令超时", "Command timed out"))?
        .map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&o.stdout).to_string();
    if !o.status.success() || text.trim().is_empty() {
        text.push_str(&filter_sensitive(&String::from_utf8_lossy(&o.stderr)));
    }
    Ok((o.status.success(), strip_ansi(&text)))
}

async fn output(args: &[&str], cwd: Option<&str>) -> Result<String, String> {
    Ok(exec(args, cwd, None, 20).await?.1)
}

async fn output_secs(args: &[&str], cwd: Option<&str>, secs: u64) -> Result<String, String> {
    Ok(exec(args, cwd, None, secs).await?.1)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdResult {
    pub ok: bool,
    pub output: String,
}

async fn run_cmd(args: &[&str], cwd: Option<&str>, secs: u64) -> Result<CmdResult, String> {
    let (ok, text) = exec(args, cwd, None, secs).await?;
    Ok(CmdResult { ok, output: text })
}
fn strip_ansi(s: &str) -> String {
    Regex::new(r"\x1b\[[0-9;]*[A-Za-z]")
        .unwrap()
        .replace_all(s, "")
        .into_owned()
}

async fn rpc(agent: &Agent, id: u64, method: &str, params: Value) -> Result<Value, String> {
    let (tx, rx) = oneshot::channel();
    agent.pending.lock().await.insert(id, tx);
    agent
        .writer
        .send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        .await
        .map_err(|_| crate::i18n::t("ACP 写入通道已关闭", "The ACP write channel is closed"))?;
    timeout(Duration::from_secs(90), rx)
        .await
        .map_err(|_| (if crate::i18n::is_en() { format!("ACP {method} timed out") } else { format!("ACP {method} 超时") }))?
        .map_err(|_| crate::i18n::t("ACP 回包通道关闭", "The ACP response channel is closed"))?
}

async fn spawn_agent(
    app: &AppHandle,
    state: &AppState,
    cwd: &str,
    model: &str,
    effort: &str,
    perm_mode: &str,
    rules: &str,
    auto_memory: bool,
    sp_enabled: bool,
) -> Result<Agent, String> {
    let mut cmd = Command::new(grok_path().await?);
    // --permission-mode 是全局 flag，和 --rules 一样放 agent 子命令前；
    // 权限档只能 spawn 时决定（set_mode RPC 对权限行为无效，实测）
    cmd.args(["--permission-mode", perm_mode]);
    if !rules.is_empty() {
        cmd.args(["--rules", rules]);
    }
    cmd.args(["agent", "--no-leader"]);
    // --plugin-dir 是 agent 子命令的 flag（实测放全局位置报 unexpected argument）
    if sp_enabled {
        match superpowers_dir().await {
            Some(dir) => {
                cmd.args(["--plugin-dir", &dir]);
            }
            None => {
                let _ = app.emit(
                    "core-log",
                    crate::i18n::t("superpowers 未安装（或 plugin list 未找到 path），SP 开关无效", "superpowers is not installed (plugin list has no path). The switch has no effect"),
                );
            }
        }
    }
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    if !effort.is_empty() {
        cmd.args(["--reasoning-effort", effort]);
    }
    cmd.arg("stdio")
        .current_dir(cwd)
        .env("GROK_DISABLE_AUTOUPDATER", "1")
        .env("GROK_MEMORY", if auto_memory { "1" } else { "0" })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(py) = unix_cpython_312() {
        cmd.env("UV_PYTHON", &py);
    }
    if let Some(wrap) = ensure_uv_nodock_path() {
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}:{path}", wrap.display()));
    }
    let mut child = cmd.spawn().map_err(|e| (if crate::i18n::is_en() { format!("Could not start the Grok CLI: {e}") } else { format!("无法启动 Grok CLI: {e}") }))?;
    let stdin = child.stdin.take().ok_or(crate::i18n::t("无法连接 ACP stdin", "Could not connect ACP stdin"))?;
    let stdout = child.stdout.take().ok_or(crate::i18n::t("无法连接 ACP stdout", "Could not connect ACP stdout"))?;
    let stderr = child.stderr.take().ok_or(crate::i18n::t("无法连接 ACP stderr", "Could not connect ACP stderr"))?;
    let (child_tx, mut child_rx) = mpsc::channel::<Value>(128);
    tokio::spawn(async move {
        let mut w = stdin;
        while let Some(v) = child_rx.recv().await {
            if w.write_all(v.to_string().as_bytes()).await.is_err() {
                break;
            }
            if w.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = w.flush().await;
        }
    });
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let p2 = pending.clone();
    let replay = Arc::new(Replay {
        collecting: AtomicBool::new(false),
        updates: std::sync::Mutex::new(Vec::new()),
    });
    let replay2 = replay.clone();
    let app2 = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<Value>(&line) {
                Ok(v) => {
                    if let Some(id) = v.get("id").and_then(Value::as_u64) {
                        if v.get("method").is_none() {
                            if let Some(tx) = p2.lock().await.remove(&id) {
                                let res = if let Some(e) = v.get("error") {
                                    Err(e.to_string())
                                } else {
                                    Ok(v.get("result").cloned().unwrap_or(Value::Null))
                                };
                                let _ = tx.send(res);
                            }
                        } else {
                            emit_acp(
                                &app2,
                                json!({"kind":"request","requestId":id,"method":v.get("method"),"params":v.get("params")}),
                            );
                        }
                    } else if v.get("method").is_some() {
                        let method = v.get("method").and_then(Value::as_str).unwrap_or("");
                        let is_session_update =
                            method == "session/update" || method == "_x.ai/session/update";
                        if replay2.collecting.load(Ordering::Relaxed) && is_session_update {
                            // session/load 回放：只收集（进 history 或丢弃），不再转发给前端，避免重复
                            if let Some(u) = v.get("params").and_then(|p| p.get("update")) {
                                if let Ok(mut g) = replay2.updates.lock() {
                                    g.push(u.clone());
                                }
                            }
                            continue;
                        }
                        emit_acp(
                            &app2,
                            json!({"kind":"notification","method":v.get("method"),"params":v.get("params")}),
                        );
                    }
                }
                Err(_) => {
                    emit_acp(&app2, json!({"kind":"protocol_error","error":line}));
                }
            }
        }
        emit_acp(&app2, json!({"kind":"closed"}));
    });
    let app3 = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let clean = strip_ansi(&line);
            if !clean.contains("auth.json") && !clean.to_lowercase().contains("token") {
                let _ = app3.emit("core-log", clean);
            }
        }
    });
    let agent = Agent {
        writer: child_tx,
        child: Arc::new(Mutex::new(child)),
        pending,
        session_id: None,
        cwd: cwd.into(),
        model: model.into(),
        effort: effort.into(),
        perm_mode: perm_mode.into(),
        capabilities: Value::Null,
        available_commands: Value::Null,
        config_options: Value::Null,
        replay,
        rules_key: rules.into(),
        auto_memory,
        sp_enabled,
    };
    let init=rpc(&agent,state.next_id.fetch_add(1,Ordering::Relaxed),"initialize",json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"Grok Build","title":"Grok Build Desktop","version":"0.1.0"}})).await?;
    let mut agent = agent;
    agent.available_commands = init
        .get("availableCommands")
        .or_else(|| init.get("_meta").and_then(|m| m.get("availableCommands")))
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    agent.capabilities = init;
    Ok(agent)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    id: String,
    name: String,
    is_default: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    cli_path: String,
    version: String,
    authenticated: bool,
    auth_message: String,
    models: Vec<Model>,
    inspect: Value,
}
#[tauri::command]
pub async fn core_status() -> Result<CoreStatus, String> {
    let version = output(&["--version"], None).await?;
    let inspected = output(&["inspect", "--json"], None)
        .await
        .unwrap_or_default();
    let inspect = serde_json::from_str(&inspected).unwrap_or(Value::Null);
    let raw = output(&["models"], None).await.unwrap_or_default();
    let auth_file = dirs::home_dir().unwrap_or_default().join(".grok/auth.json");
    let authenticated = auth_file.metadata().map(|m| m.len() > 2).unwrap_or(false);
    let default = Regex::new(r"(?m)^Default model:\s*([^\s]+)")
        .unwrap()
        .captures(&raw)
        .and_then(|c| c.get(1))
        .map(|x| x.as_str())
        .unwrap_or("");
    let re = Regex::new(r"(?m)^\s*[\*-]\s+([A-Za-z0-9._-]+)(?:\s+\(default\))?").unwrap();
    let models = re
        .captures_iter(&raw)
        .filter_map(|c| c.get(1))
        .map(|m| {
            let id = m.as_str().to_string();
            Model {
                name: id.clone(),
                is_default: id == default,
                id,
            }
        })
        .collect();
    Ok(CoreStatus {
        cli_path: grok_path().await?.display().to_string(),
        version: version.trim().into(),
        authenticated,
        auth_message: if authenticated {
            crate::i18n::t("检测到共享 Grok 登录凭据", "Found a shared Grok login")
        } else {
            crate::i18n::t("尚未登录；点击登录后在终端完成官方认证", "Not signed in. Use Log in and finish the official sign-in in Terminal")
        },
        models,
        inspect,
    })
}

fn session_id_re() -> Regex {
    Regex::new(r"(?i)([0-9a-f]{8}-[0-9a-f-]{27,})").unwrap()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn session_mtime_ms(cwd: &str, sid: &str) -> Option<u64> {
    let base = dirs::home_dir()?.join(".grok").join("sessions");
    for e in std::fs::read_dir(base).ok()?.flatten() {
        if percent_decode(&e.file_name().to_string_lossy()) == cwd {
            let dir = e.path().join(sid);
            let mut latest = std::fs::metadata(&dir).ok()?.modified().ok()?;
            if let Ok(files) = std::fs::read_dir(&dir) {
                for f in files.flatten() {
                    if let Ok(m) = f.metadata().and_then(|md| md.modified()) {
                        if m > latest {
                            latest = m;
                        }
                    }
                }
            }
            return latest
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_millis() as u64);
        }
    }
    None
}

async fn session_list_entries(cwd: &str) -> Result<Vec<Value>, String> {
    let raw = output(&["sessions", "list", "--limit", "50"], Some(cwd)).await?;
    let idre = session_id_re();
    // 列表行是列格式：`<id>  <CREATED>  <UPDATED>  <STATUS>  <SUMMARY>`（2+ 空格分列），
    // 标题只取最后一列 SUMMARY；取不到列时退化用整行去 id 的文本。
    let colre = Regex::new(r"\s{2,}").unwrap();
    let mut out = Vec::new();
    for line in raw.lines() {
        if let Some(m) = idre.find(line) {
            let rest = line.replace(m.as_str(), "");
            let cols: Vec<&str> = colre.split(rest.trim()).filter(|c| !c.is_empty()).collect();
            let title = cols
                .last()
                .map(|s| s.trim().to_string())
                .filter(|t| !t.is_empty() && t != "local" && t != "remote")
                .unwrap_or_default();
            let updated = cols
                .get(1)
                .map(|s| s.trim().to_string())
                .filter(|s| s.contains('-'));
            out.push(json!({"id": m.as_str(), "title": title, "updated": updated}));
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_sessions(cwd: String) -> Result<Vec<Value>, String> {
    Ok(session_list_entries(&cwd).await?)
}

#[tauri::command]
pub async fn search_sessions(cwd: String, query: String) -> Result<Vec<Value>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return list_sessions(cwd).await;
    }
    let raw = output(&["sessions", "search", &q, "--limit", "50"], Some(&cwd)).await?;
    let idre = Regex::new(r"(?i)([0-9a-f]{8}-[0-9a-f-]{27,})").unwrap();
    let lines: Vec<&str> = raw.lines().collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some(m) = idre.find(line) {
            // 搜索结果里摘要跟在 id 行之后（id 行本身只有 score/日期）
            let summary = lines[i + 1..]
                .iter()
                .map(|l| l.trim())
                .find(|l| !l.is_empty())
                .unwrap_or("")
                .to_string();
            let inline = line
                .replace(m.as_str(), "")
                .trim_matches(|c: char| c == ' ' || c == '-' || c == '│')
                .trim()
                .to_string();
            out.push(json!({"id":m.as_str(),"title":if summary.is_empty(){inline}else{summary},"cwd":cwd}));
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn delete_session(session_id: String) -> Result<CmdResult, String> {
    // `grok sessions delete` has no -y flag; feed "y" in case it confirms on stdin
    let (ok, text) = exec(&["sessions", "delete", &session_id], None, Some("y\n"), 20).await?;
    Ok(CmdResult { ok, output: text })
}

/// 按当前 config spawn 一个 agent（rename/fork 等 RPC 命令的无会话兜底）
async fn spawn_agent_from_config(
    app: &AppHandle,
    state: &AppState,
    cwd: &str,
) -> Result<Agent, String> {
    let cfg = crate::config::read_config().unwrap_or_default();
    let rules = crate::memory::compose_rules(&cfg);
    let perm_mode = if cfg.permission_mode.trim().is_empty() {
        "plan".to_string()
    } else {
        cfg.permission_mode.trim().to_string()
    };
    spawn_agent(
        app,
        state,
        cwd,
        &cfg.model,
        &cfg.effort,
        &perm_mode,
        &rules,
        cfg.auto_memory,
        cfg.sp_enabled,
    )
    .await
}

/// 杀当前 agent 并用新参数 spawn + session/load 恢复原会话（回放收集后丢弃）。
/// perm_override/sp_override 为 None 时沿用旧 agent 的值；都无变化则不重启。
/// 返回 (perm_mode, sp_enabled, session_id, restarted)。
async fn respawn_keep_session(
    app: &AppHandle,
    state: &Arc<AppState>,
    perm_override: Option<String>,
    sp_override: Option<bool>,
) -> Result<(String, bool, Option<String>, bool), String> {
    let mut guard = state.agent.lock().await;
    let old = guard.take().ok_or(crate::i18n::t("没有活动会话", "No active session"))?;
    let perm = perm_override.unwrap_or_else(|| old.perm_mode.clone());
    let sp = sp_override.unwrap_or(old.sp_enabled);
    if perm == old.perm_mode && sp == old.sp_enabled {
        let sid = old.session_id.clone();
        *guard = Some(old);
        return Ok((perm, sp, sid, false));
    }
    let _ = old.child.lock().await.kill().await;
    let sid = old.session_id.clone();
    let mut a = spawn_agent(
        app,
        state,
        &old.cwd,
        &old.model,
        &old.effort,
        &perm,
        &old.rules_key,
        old.auto_memory,
        sp,
    )
    .await?;
    if let Some(s) = sid.clone() {
        // 恢复会话；回放的历史通知收集后丢弃（读循环在 collecting 期间不转发 emit）
        if let Ok(mut g) = a.replay.updates.lock() {
            g.clear();
        }
        a.replay.collecting.store(true, Ordering::Relaxed);
        let load_result = rpc(
            &a,
            state.next_id.fetch_add(1, Ordering::Relaxed),
            "session/load",
            json!({"cwd":a.cwd,"mcpServers":[],"sessionId":s}),
        )
        .await;
        a.replay.collecting.store(false, Ordering::Relaxed);
        if let Ok(mut g) = a.replay.updates.lock() {
            g.clear();
        }
        let result = load_result?;
        a.session_id = Some(s);
        if let Some(opts) = result.get("configOptions").cloned() {
            a.config_options = opts;
        }
    }
    *guard = Some(a);
    Ok((perm, sp, sid, true))
}

#[tauri::command]
pub async fn set_sp_enabled(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<Value, String> {
    // 先持久化；有活动会话再换 flag 重启（无会话只持久化）
    let mut cfg = crate::config::read_config().unwrap_or_default();
    cfg.sp_enabled = enabled;
    crate::config::write_config(cfg)?;
    let has_agent = state.agent.lock().await.is_some();
    let restarted = if has_agent {
        let (_, _, _, restarted) = respawn_keep_session(&app, &state, None, Some(enabled)).await?;
        restarted
    } else {
        false
    };
    Ok(json!({"spEnabled":enabled,"restarted":restarted}))
}

#[tauri::command]
pub async fn rename_session(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    cwd: String,
    session_id: String,
    title: String,
) -> Result<CmdResult, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(crate::i18n::t("标题不能为空", "Title cannot be empty"));
    }
    if !Path::new(&cwd).is_dir() {
        return Err(crate::i18n::t("项目目录不存在", "The project folder does not exist"));
    }
    // _x.ai/session/rename 无需 session/load，initialize 后即可用（实测）；
    // 没有活动 agent 就按当前 config spawn 一个并留作常驻复用。
    let mut guard = state.agent.lock().await;
    if guard.is_none() {
        *guard = Some(spawn_agent_from_config(&app, &state, &cwd).await?);
    }
    let a = guard.as_ref().unwrap();
    let result = rpc(
        a,
        state.next_id.fetch_add(1, Ordering::Relaxed),
        "_x.ai/session/rename",
        json!({"sessionId":session_id,"title":title}),
    )
    .await;
    match result {
        Ok(v) => {
            let ok = v.get("success").and_then(Value::as_bool).unwrap_or(true);
            Ok(CmdResult {
                ok,
                output: if ok {
                    (if crate::i18n::is_en() { format!("Renamed to {title}") } else { format!("已重命名为 {title}") })
                } else {
                    (if crate::i18n::is_en() { format!("Rename failed: {v}") } else { format!("重命名失败：{v}") })
                },
            })
        }
        Err(e) => Ok(CmdResult {
            ok: false,
            output: (if crate::i18n::is_en() { format!("Rename failed: {e}") } else { format!("重命名失败：{e}") }),
        }),
    }
}

#[tauri::command]
pub async fn export_session(session_id: String) -> Result<String, String> {
    output_secs(&["export", &session_id], None, 60).await
}

#[tauri::command]
pub async fn session_usage(session_id: String) -> Result<String, String> {
    output_secs(&["usage", &session_id], None, 30).await
}

#[derive(Debug, Default, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cached_read_tokens: u64,
    #[serde(default)]
    cache_creation_tokens: u64,
    #[serde(default)]
    reasoning_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
    #[serde(default)]
    model_calls: u64,
    #[serde(default)]
    cost_usd_ticks: u64,
    #[serde(default)]
    turn_count: u64,
}
impl UsageStats {
    fn add(&mut self, o: &UsageStats) {
        self.input_tokens += o.input_tokens;
        self.output_tokens += o.output_tokens;
        self.cached_read_tokens += o.cached_read_tokens;
        self.cache_creation_tokens += o.cache_creation_tokens;
        self.reasoning_tokens += o.reasoning_tokens;
        self.total_tokens += o.total_tokens;
        self.model_calls += o.model_calls;
        self.cost_usd_ticks += o.cost_usd_ticks;
        self.turn_count += o.turn_count;
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopSession {
    session_id: String,
    title: Option<String>,
    total_tokens: u64,
    cost_usd_ticks: u64,
    model_calls: u64,
    turn_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUsage {
    session_count: usize,
    totals: UsageStats,
    models: HashMap<String, UsageStats>,
    top_sessions: Vec<TopSession>,
}

#[tauri::command]
pub async fn workspace_usage(cwd: String) -> Result<WorkspaceUsage, String> {
    let entries = session_list_entries(&cwd).await?;
    let mut session_count = 0usize;
    let mut totals = UsageStats::default();
    let mut models: HashMap<String, UsageStats> = HashMap::new();
    let mut top_sessions: Vec<TopSession> = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let title = entry
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // 单条失败跳过不计入
        let Ok(raw) = exec(&["usage", id], None, None, 30).await else {
            continue;
        };
        let parsed: Value = match serde_json::from_str(&raw.1) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(session) = parsed.get("session") else {
            continue;
        };
        let stats: UsageStats = serde_json::from_value(session.clone()).unwrap_or_default();
        if let Some(mu) = session.get("modelUsage").and_then(Value::as_object) {
            for (model_id, v) in mu {
                let ms: UsageStats = serde_json::from_value(v.clone()).unwrap_or_default();
                models.entry(model_id.clone()).or_default().add(&ms);
            }
        }
        session_count += 1;
        top_sessions.push(TopSession {
            session_id: id.to_string(),
            title: if title.is_empty() { None } else { Some(title) },
            total_tokens: stats.total_tokens,
            cost_usd_ticks: stats.cost_usd_ticks,
            model_calls: stats.model_calls,
            turn_count: stats.turn_count,
        });
        totals.add(&stats);
    }
    top_sessions.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));
    top_sessions.truncate(10);
    Ok(WorkspaceUsage {
        session_count,
        totals,
        models,
        top_sessions,
    })
}

fn build_history(updates: &[Value]) -> Vec<Value> {
    let mut msgs: Vec<Value> = Vec::new();
    let mut tool_idx: HashMap<String, usize> = HashMap::new();
    for u in updates {
        let kind = u.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
        match kind {
            "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" => {
                let role = match kind {
                    "user_message_chunk" => "user",
                    "agent_thought_chunk" => "thought",
                    _ => "assistant",
                };
                let text = u
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                let same_role = msgs
                    .last()
                    .and_then(|m| m.get("role").and_then(Value::as_str))
                    .map(|r| r == role)
                    .unwrap_or(false);
                if same_role {
                    if let Some(m) = msgs.last_mut() {
                        let cur = m
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        m["text"] = json!(format!("{cur}{text}"));
                    }
                } else {
                    msgs.push(json!({"role":role,"text":text}));
                }
            }
            "tool_call" => {
                let id = u
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let title = u.get("title").and_then(Value::as_str).unwrap_or("");
                let status = u.get("status").and_then(Value::as_str).unwrap_or("");
                tool_idx.insert(id, msgs.len());
                msgs.push(json!({"role":"tool","text":"","toolTitle":title,"status":status}));
            }
            "tool_call_update" => {
                let id = u.get("toolCallId").and_then(Value::as_str).unwrap_or("");
                if let Some(i) = tool_idx.get(id).copied() {
                    if let Some(m) = msgs.get_mut(i) {
                        if let Some(s) = u.get("status").and_then(Value::as_str) {
                            m["status"] = json!(s);
                        }
                        if let Some(t) = u.get("title").and_then(Value::as_str) {
                            m["toolTitle"] = json!(t);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    msgs
}

#[tauri::command]
pub async fn start_session(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    cwd: String,
    session_id: Option<String>,
    model: String,
    effort: String,
    permission_mode: String,
    restore_code: Option<bool>,
) -> Result<Value, String> {
    if !Path::new(&cwd).is_dir() {
        return Err(crate::i18n::t("项目目录不存在", "The project folder does not exist"));
    }
    let is_resume = session_id.is_some();
    // 权限模式只能 spawn 决定；空值按 plan 处理
    let perm_mode = if permission_mode.trim().is_empty() {
        "plan".to_string()
    } else {
        permission_mode.trim().to_string()
    };
    let cfg = crate::config::read_config().unwrap_or_default();
    let rules = crate::memory::compose_rules(&cfg);
    let auto_memory = cfg.auto_memory;
    let sp_enabled = cfg.sp_enabled;
    if auto_memory {
        crate::memory::seed_global_memory();
    }
    let mut guard = state.agent.lock().await;
    let restart = guard
        .as_ref()
        .map(|a| {
            a.cwd != cwd
                || a.model != model
                || a.effort != effort
                || a.perm_mode != perm_mode
                || a.rules_key != rules
                || a.auto_memory != auto_memory
                || a.sp_enabled != sp_enabled
        })
        .unwrap_or(true);
    if restart {
        if let Some(a) = guard.take() {
            let _ = a.child.lock().await.kill().await;
        }
        *guard = Some(
            spawn_agent(
                &app,
                &state,
                &cwd,
                &model,
                &effort,
                &perm_mode,
                &rules,
                auto_memory,
                sp_enabled,
            )
            .await?,
        );
    }
    let a = guard.as_mut().unwrap();
    let method = if is_resume {
        "session/load"
    } else {
        "session/new"
    };
    let mut params = json!({"cwd":cwd,"mcpServers":[]});
    let params_session_id = session_id.clone();
    if let Some(s) = session_id {
        params["sessionId"] = json!(s);
    }
    // 仅 resume 有效：session/load 恢复代码上下文（实测 load 接受该字段）；新会话忽略
    if is_resume && restore_code == Some(true) {
        params["restoreCode"] = json!(true);
    }
    if is_resume {
        if let Ok(mut g) = a.replay.updates.lock() {
            g.clear();
        }
        a.replay.collecting.store(true, Ordering::Relaxed);
    }
    let rpc_result = rpc(
        a,
        state.next_id.fetch_add(1, Ordering::Relaxed),
        method,
        params,
    )
    .await;
    let history = if is_resume {
        a.replay.collecting.store(false, Ordering::Relaxed);
        let updates = a
            .replay
            .updates
            .lock()
            .map(|mut g| std::mem::take(&mut *g))
            .unwrap_or_default();
        build_history(&updates)
    } else {
        Vec::new()
    };
    let mut result = rpc_result?;
    // session/load 的 result 不含 sessionId（实测），恢复时回退用请求里的 id
    let sid = result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| params_session_id.clone())
        .ok_or(crate::i18n::t("ACP 未返回 sessionId", "ACP did not return a sessionId"))?;
    a.session_id = Some(sid.clone());
    if let Some(opts) = result.get("configOptions").cloned() {
        a.config_options = opts;
    }
    if let Some(object) = result.as_object_mut() {
        object.insert("sessionId".into(), json!(sid));
        object.insert(
            "grokBuilderMode".into(),
            json!(if is_resume { "restored" } else { "plan" }),
        );
        object.insert("history".into(), json!(history));
        object.insert("availableCommands".into(), a.available_commands.clone());
        object.insert("currentModeId".into(), json!(perm_mode));
        if is_resume {
            // 历史消息没有逐条时间戳，用会话存储的最近修改时间兜底展示
            object.insert("historyTs".into(), json!(session_mtime_ms(&cwd, &sid)));
        }
    }
    crate::companion::patch_live(
        Some(cwd.clone()),
        Some(Some(sid.clone())),
        Some(false),
        Some(perm_mode.clone()),
        Some(model.clone()),
        Some(effort.clone()),
    );
    emit_acp(
        &app,
        json!({"kind":"session_ready","sessionId":sid,"result":result}),
    );
    crate::companion::emit_state(&app);
    Ok(result)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    path: String,
    name: String,
    mime_type: String,
}

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_RESOURCE_TEXT_BYTES: u64 = 512 * 1024;

/// 单个附件 → ACP 内容块。Ok(None) = 跳过（记入 skipped）。
fn build_attachment_block(att: &AttachmentInput) -> Result<Option<Value>, String> {
    let path = PathBuf::from(att.path.trim());
    let meta = std::fs::metadata(&path).map_err(|e| (if crate::i18n::is_en() { format!("Could not read attachment {}: {e}", att.name) } else { format!("附件 {} 读取失败：{e}", att.name) }))?;
    if att.mime_type.starts_with("image/") {
        if meta.len() > MAX_IMAGE_BYTES {
            return Ok(None); // 图片 >10MB 跳过并注明
        }
        let bytes = std::fs::read(&path).map_err(|e| (if crate::i18n::is_en() { format!("Could not read attachment {}: {e}", att.name) } else { format!("附件 {} 读取失败：{e}", att.name) }))?;
        let data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        return Ok(Some(
            json!({"type":"image","data":data,"mimeType":att.mime_type}),
        ));
    }
    let uri = format!("file://{}", path.display());
    // 文本（≤512KB）→ embeddedContext resource 块；其余 → resource_link 兜底
    if meta.len() <= MAX_RESOURCE_TEXT_BYTES {
        if let Ok(content) = std::fs::read_to_string(&path) {
            return Ok(Some(
                json!({"type":"resource","resource":{"uri":uri,"text":content,"mimeType":att.mime_type}}),
            ));
        }
    }
    Ok(Some(
        json!({"type":"resource_link","uri":uri,"name":att.name,"mimeType":att.mime_type}),
    ))
}

#[tauri::command]
pub async fn send_prompt(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    text: String,
    attachments: Option<Vec<AttachmentInput>>,
) -> Result<Value, String> {
    let mut blocks: Vec<Value> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for att in attachments.unwrap_or_default() {
        match build_attachment_block(&att) {
            Ok(Some(b)) => blocks.push(b),
            Ok(None) => skipped.push((if crate::i18n::is_en() { format!("{}: image is over the 10 MB limit", att.name) } else { format!("{}：图片超过 10 MB 限制", att.name) })),
            Err(e) => skipped.push(e),
        }
    }
    blocks.push(json!({"type":"text","text":text}));
    let guard = state.agent.lock().await;
    let a = guard.as_ref().ok_or(crate::i18n::t("请先创建或恢复会话", "Create or restore a session first"))?;
    let sid = a.session_id.clone().ok_or(crate::i18n::t("会话尚未就绪", "The session is not ready yet"))?;
    let prompt_epoch =
        crate::companion::try_begin_prompt().ok_or_else(|| crate::i18n::t("上一轮尚未结束", "The previous turn is still running"))?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let pending = a.pending.clone();
    let writer = a.writer.clone();
    let app_params = json!({"sessionId":sid,"prompt":blocks});
    let (tx, rx) = oneshot::channel();
    pending.lock().await.insert(id, tx);
    if writer
        .send(json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":app_params}))
        .await
        .is_err()
    {
        crate::companion::finish_prompt(prompt_epoch);
        crate::companion::emit_state(&app);
        return Err(crate::i18n::t("ACP 已关闭", "ACP is closed"));
    }
    drop(guard);
    emit_acp(&app, json!({"kind":"user_echo","text":text}));
    crate::companion::emit_state(&app);
    tokio::spawn(async move {
        match rx.await {
            Ok(Ok(result)) => {
                if crate::companion::finish_prompt(prompt_epoch) {
                    crate::companion::emit_state(&app);
                    emit_acp(&app, json!({"kind":"prompt_complete","result":result}));
                }
            }
            Ok(Err(error)) => {
                if crate::companion::finish_prompt(prompt_epoch) {
                    crate::companion::emit_state(&app);
                    emit_acp(&app, json!({"kind":"prompt_error","error":error}));
                }
            }
            Err(_) => {
                if crate::companion::finish_prompt(prompt_epoch) {
                    crate::companion::emit_state(&app);
                    emit_acp(
                        &app,
                        json!({"kind":"prompt_error","error": crate::i18n::t("ACP 回包通道关闭", "The ACP response channel is closed")}),
                    );
                }
            }
        }
    });
    Ok(json!({"ok":true,"skipped":skipped}))
}

#[tauri::command]
pub async fn cancel_session(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let g = state.agent.lock().await;
    let a = g.as_ref().ok_or(crate::i18n::t("没有运行中的会话", "No session is running"))?;
    let sid = a.session_id.clone().ok_or(crate::i18n::t("会话尚未就绪", "The session is not ready yet"))?;
    a.writer
        .send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":sid}}))
        .await
        .map_err(|_| crate::i18n::t("ACP 已关闭", "ACP is closed"))?;
    drop(g);
    crate::companion::set_prompt_busy(false);
    crate::companion::emit_state(&app);
    Ok(())
}
#[tauri::command]
pub async fn stop_agent(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Some(a) = state.agent.lock().await.take() {
        a.child
            .lock()
            .await
            .kill()
            .await
            .map_err(|e| e.to_string())?
    }
    Ok(())
}
#[tauri::command]
pub async fn permission_reply(
    state: State<'_, Arc<AppState>>,
    request_id: u64,
    option_id: Option<String>,
) -> Result<(), String> {
    let g = state.agent.lock().await;
    let a = g.as_ref().ok_or(crate::i18n::t("Agent 已关闭", "The agent is closed"))?;
    let result = match option_id {
        Some(id) => json!({"outcome":{"outcome":"selected","optionId":id}}),
        None => json!({"outcome":{"outcome":"cancelled"}}),
    };
    a.writer
        .send(json!({"jsonrpc":"2.0","id":request_id,"result":result}))
        .await
        .map_err(|_| crate::i18n::t("ACP 已关闭", "ACP is closed"))
}
#[tauri::command]
pub async fn ask_reply(
    state: State<'_, Arc<AppState>>,
    request_id: u64,
    outcome: String,
    answers: Option<Value>,
) -> Result<(), String> {
    let g = state.agent.lock().await;
    let a = g.as_ref().ok_or(crate::i18n::t("Agent 已关闭", "The agent is closed"))?;
    // 回应 _x.ai/ask_user_question：answers 以问题原文为 key，value 为 string / string[]（多选）/ 自定义文本
    let result = if outcome == "accepted" {
        json!({"outcome":"accepted","answers":answers.unwrap_or_else(|| json!({}))})
    } else {
        json!({"outcome":outcome})
    };
    a.writer
        .send(json!({"jsonrpc":"2.0","id":request_id,"result":result}))
        .await
        .map_err(|_| crate::i18n::t("ACP 已关闭", "ACP is closed"))
}
#[tauri::command]
pub async fn exit_plan_reply(
    state: State<'_, Arc<AppState>>,
    request_id: u64,
    outcome: String,
    feedback: Option<String>,
) -> Result<(), String> {
    let g = state.agent.lock().await;
    let a = g.as_ref().ok_or(crate::i18n::t("Agent 已关闭", "The agent is closed"))?;
    // 回应 _x.ai/exit_plan_mode；不回包 agent 会永久挂起（实测卡死）
    let result = match outcome.as_str() {
        "approved" => json!({"outcome":"approved"}),
        "request_changes" => {
            json!({"outcome":"request_changes","feedback":feedback.unwrap_or_default()})
        }
        // 继续规划/取消 = 空对象（实测 agent 回到规划状态）
        _ => json!({}),
    };
    a.writer
        .send(json!({"jsonrpc":"2.0","id":request_id,"result":result}))
        .await
        .map_err(|_| crate::i18n::t("ACP 已关闭", "ACP is closed"))
}
#[tauri::command]
pub async fn set_session_option(
    state: State<'_, Arc<AppState>>,
    config_id: String,
    value: String,
) -> Result<Value, String> {
    let g = state.agent.lock().await;
    let a = g.as_ref().ok_or(crate::i18n::t("没有活动会话", "No active session"))?;
    let sid = a.session_id.clone().ok_or(crate::i18n::t("会话尚未就绪", "The session is not ready yet"))?;
    // 实测协议：params 为 {sessionId, configId, value: "<string>"}（value 是纯字符串）。
    // configId 可用 option id（"model"/"reasoning_effort"）或 category（"model"/"thought_level"）。
    let mut cid = config_id.clone();
    if let Some(arr) = a.config_options.as_array() {
        let is_id = arr
            .iter()
            .any(|o| o.get("id").and_then(Value::as_str) == Some(cid.as_str()));
        if !is_id {
            if let Some(o) = arr
                .iter()
                .find(|o| o.get("category").and_then(Value::as_str) == Some(cid.as_str()))
            {
                if let Some(id) = o.get("id").and_then(Value::as_str) {
                    cid = id.to_string();
                }
            }
        }
    }
    rpc(
        a,
        state.next_id.fetch_add(1, Ordering::Relaxed),
        "session/set_config_option",
        json!({"sessionId":sid,"configId":cid,"value":value}),
    )
    .await
}

#[tauri::command]
pub async fn set_session_mode(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    mode_id: String,
) -> Result<Value, String> {
    // session/set_mode RPC 对权限档无效（实测只切 plan/agent 代理配置，返回 {} 但不改权限行为）。
    // 真正的切换 = 杀 agent → 用新 --permission-mode spawn → session/load 恢复原会话（respawn_keep_session）。
    let mode = mode_id.trim().to_string();
    if mode.is_empty() {
        return Err(crate::i18n::t("modeId 不能为空", "modeId cannot be empty"));
    }
    let (perm, _sp, sid, _restarted) = respawn_keep_session(&app, &state, Some(mode), None).await?;
    crate::companion::patch_live(
        None,
        Some(sid.clone()),
        None,
        Some(perm.clone()),
        None,
        None,
    );
    crate::companion::emit_state(&app);
    Ok(json!({"currentModeId":perm,"sessionId":sid}))
}

#[tauri::command]
pub async fn check_update(_state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let raw = output(&["update", "--check", "--json"], None).await?;
    serde_json::from_str(&raw).map_err(|_| raw)
}
#[tauri::command]
pub async fn install_update(
    state: State<'_, Arc<AppState>>,
    version: Option<String>,
) -> Result<String, String> {
    if let Some(agent) = state.agent.lock().await.take() {
        agent
            .child
            .lock()
            .await
            .kill()
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut owned = vec!["update".to_string()];
    if let Some(v) = version {
        owned.extend(["--version".into(), v]);
    }
    let refs = owned.iter().map(String::as_str).collect::<Vec<_>>();
    output_secs(&refs, None, 120).await
}
#[tauri::command]
pub async fn switch_update_channel(
    state: State<'_, Arc<AppState>>,
    channel: String,
) -> Result<String, String> {
    let flag = match channel.as_str() {
        "alpha" => "--alpha",
        "stable" => "--stable",
        _ => return Err(crate::i18n::t("channel 只能是 alpha 或 stable", "channel must be alpha or stable")),
    };
    if let Some(agent) = state.agent.lock().await.take() {
        agent
            .child
            .lock()
            .await
            .kill()
            .await
            .map_err(|e| e.to_string())?;
    }
    output_secs(&["update", flag], None, 120).await
}

async fn launch_terminal_command(app: &AppHandle, subcommand: &str) -> Result<(), String> {
    let command = format!("{} {}", grok_path().await?.display(), subcommand);
    let escaped = command.replace('\\', "\\\\").replace('\"', "\\\"");
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        escaped
    );
    let result = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| (if crate::i18n::is_en() { format!("Could not open the login terminal: {e}") } else { format!("无法打开登录终端：{e}") }))?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).trim().to_string());
    }
    let _ = app.get_webview_window("main").map(|w| w.set_focus());
    Ok(())
}

#[tauri::command]
pub async fn launch_login(app: AppHandle) -> Result<(), String> {
    launch_terminal_command(&app, "login --oauth").await
}
#[tauri::command]
pub async fn launch_device_login(app: AppHandle) -> Result<(), String> {
    launch_terminal_command(&app, "login --device-auth").await
}
#[tauri::command]
pub async fn logout(state: State<'_, Arc<AppState>>) -> Result<CmdResult, String> {
    if let Some(agent) = state.agent.lock().await.take() {
        let _ = agent.child.lock().await.kill().await;
    }
    run_cmd(&["logout"], None, 20).await
}

#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<Value>, String> {
    fn walk(base: &Path, p: &Path, out: &mut Vec<Value>, depth: u8) {
        if depth > 4 || out.len() >= 500 {
            return;
        }
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let path = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
                if path.is_dir() {
                    walk(base, &path, out, depth + 1)
                } else if let Ok(meta) = e.metadata() {
                    if meta.len() <= 2_000_000 {
                        out.push(json!({"path":path.strip_prefix(base).unwrap_or(&path).display().to_string(),"size":meta.len()}));
                    }
                }
            }
        }
    }
    let base = PathBuf::from(root);
    let mut out = vec![];
    walk(&base, &base, &mut out, 0);
    Ok(out)
}
#[tauri::command]
pub async fn read_file(root: String, path: String) -> Result<String, String> {
    let base = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let target = std::fs::canonicalize(base.join(path)).map_err(|e| e.to_string())?;
    if !target.starts_with(&base) {
        return Err(crate::i18n::t("路径越界", "Path is not allowed"));
    }
    let m = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    if m.len() > 2_000_000 {
        return Err(crate::i18n::t("文件超过 2 MB 预览限制", "File is over the 2 MB preview limit"));
    }
    let data = std::fs::read(&target).map_err(|e| e.to_string())?;
    String::from_utf8(data).map_err(|_| crate::i18n::t("暂不预览二进制文件", "Binary files are not previewed"))
}

#[tauri::command]
pub async fn open_in_finder(path: String) -> Result<(), String> {
    let p = PathBuf::from(path.trim());
    if !p.exists() {
        return Err(crate::i18n::t("路径不存在", "Path does not exist"));
    }
    // open -R：在访达中显示并选中（不走 grok exec 助手，与 grok CLI 无关）
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&p)
        .status()
        .map_err(|e| (if crate::i18n::is_en() { format!("Could not open Finder: {e}") } else { format!("无法打开访达：{e}") }))?;
    if status.success() {
        Ok(())
    } else {
        Err(crate::i18n::t("open -R 命令失败", "open -R failed"))
    }
}

#[tauri::command]
pub async fn extension_status(cwd: String) -> Result<Value, String> {
    let inspect = output(&["inspect", "--json"], Some(&cwd)).await?;
    serde_json::from_str(&inspect).map_err(|e| e.to_string())
}

// ---- MCP 管理 ----

#[tauri::command]
pub async fn mcp_list() -> Result<Value, String> {
    let raw = output(&["mcp", "list", "--json"], None).await?;
    serde_json::from_str(&raw).map_err(|_| raw)
}

#[tauri::command]
pub async fn mcp_add(
    name: String,
    command_or_url: Option<String>,
    args: Option<Vec<String>>,
    transport: Option<String>,
    scope: Option<String>,
    env: Option<Vec<String>>,
    headers: Option<Vec<String>>,
) -> Result<CmdResult, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::i18n::t("MCP 服务器名称不能为空", "MCP server name cannot be empty"));
    }
    let mut owned: Vec<String> = vec!["mcp".into(), "add".into()];
    if let Some(t) = transport.filter(|s| !s.trim().is_empty()) {
        match t.as_str() {
            "stdio" | "http" | "sse" => owned.extend(["--transport".into(), t]),
            _ => return Err(crate::i18n::t("transport 只能是 stdio/http/sse", "transport must be stdio, http, or sse")),
        }
    }
    if let Some(s) = scope.filter(|s| !s.trim().is_empty()) {
        match s.as_str() {
            "user" | "project" => owned.extend(["--scope".into(), s]),
            _ => return Err(crate::i18n::t("scope 只能是 user/project", "scope must be user or project")),
        }
    }
    for e in env.unwrap_or_default() {
        if !e.trim().is_empty() {
            owned.extend(["--env".into(), e]);
        }
    }
    for h in headers.unwrap_or_default() {
        if !h.trim().is_empty() {
            owned.extend(["--header".into(), h]);
        }
    }
    owned.push(name);
    if let Some(c) = command_or_url.filter(|s| !s.trim().is_empty()) {
        owned.push(c);
    }
    let extra = args.unwrap_or_default();
    if !extra.is_empty() {
        owned.push("--".into());
        owned.extend(extra);
    }
    let refs = owned.iter().map(String::as_str).collect::<Vec<_>>();
    run_cmd(&refs, None, 30).await
}

#[tauri::command]
pub async fn mcp_remove(name: String) -> Result<CmdResult, String> {
    run_cmd(&["mcp", "remove", &name], None, 30).await
}
#[tauri::command]
pub async fn mcp_enable(name: String) -> Result<CmdResult, String> {
    run_cmd(&["mcp", "enable", &name], None, 30).await
}
#[tauri::command]
pub async fn mcp_disable(name: String) -> Result<CmdResult, String> {
    run_cmd(&["mcp", "disable", &name], None, 30).await
}
#[tauri::command]
pub async fn mcp_doctor() -> Result<CmdResult, String> {
    run_cmd(&["mcp", "doctor"], None, 60).await
}

// ---- 插件 ----

/// 从 ~/.grok/config.toml 的 [plugins] 段读 disabled 数组（plugin list --json 没有启停字段，
/// 真实启停状态在这里；grok plugin enable/disable 改的就是它）。
/// 逐行解析：只认 [plugins] 段内的 disabled 键，数组可跨行，提取引号内字符串。
fn disabled_plugins() -> Vec<String> {
    let path = dirs::home_dir()
        .unwrap_or_default()
        .join(".grok/config.toml");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return vec![];
    };
    let quote_re = Regex::new(r#""([^"]*)"|'([^']*)'"#).unwrap();
    let mut in_plugins = false;
    let mut acc: Option<String> = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(mut buf) = acc.take() {
            // 已处于 disabled 数组的多行收集中
            buf.push_str(t);
            if t.contains(']') {
                return quote_re
                    .captures_iter(&buf)
                    .filter_map(|c| c.get(1).or_else(|| c.get(2)))
                    .map(|m| m.as_str().to_string())
                    .collect();
            }
            acc = Some(buf);
            continue;
        }
        if t.starts_with('[') {
            in_plugins = t == "[plugins]";
            continue;
        }
        if in_plugins && t.starts_with("disabled") {
            let Some(eq) = t.find('=') else { continue };
            let rest = t[eq + 1..].trim().to_string();
            if rest.contains(']') {
                return quote_re
                    .captures_iter(&rest)
                    .filter_map(|c| c.get(1).or_else(|| c.get(2)))
                    .map(|m| m.as_str().to_string())
                    .collect();
            }
            acc = Some(rest);
        }
    }
    vec![]
}

#[tauri::command]
pub async fn plugin_list() -> Result<Value, String> {
    let raw = output(&["plugin", "list", "--json"], None).await?;
    let mut v: Value = serde_json::from_str(&raw).map_err(|_| raw.clone())?;
    let disabled = disabled_plugins();
    if let Some(arr) = v.as_array_mut() {
        for p in arr.iter_mut() {
            let name = p.get("name").and_then(Value::as_str).unwrap_or("");
            let enabled = !disabled.iter().any(|d| d == name);
            p["enabled"] = json!(enabled);
        }
    }
    Ok(v)
}
#[tauri::command]
pub async fn plugin_install(source: String) -> Result<CmdResult, String> {
    let source = source.trim().to_string();
    if source.is_empty() {
        return Err(crate::i18n::t("插件来源不能为空", "Plugin source cannot be empty"));
    }
    // --trust：非交互环境下跳过确认提示
    run_cmd(&["plugin", "install", "--trust", &source], None, 120).await
}
#[tauri::command]
pub async fn plugin_uninstall(name: String) -> Result<CmdResult, String> {
    run_cmd(&["plugin", "uninstall", &name], None, 30).await
}
#[tauri::command]
pub async fn plugin_enable(name: String) -> Result<CmdResult, String> {
    run_cmd(&["plugin", "enable", &name], None, 30).await
}
#[tauri::command]
pub async fn plugin_disable(name: String) -> Result<CmdResult, String> {
    run_cmd(&["plugin", "disable", &name], None, 30).await
}

// ---- Memory ----

#[tauri::command]
pub async fn memory_clear(scope: Option<String>, cwd: Option<String>) -> Result<CmdResult, String> {
    let flag = match scope.as_deref().unwrap_or("workspace") {
        "workspace" => "--workspace",
        "global" => "--global",
        "all" => "--all",
        _ => return Err(crate::i18n::t("scope 只能是 workspace/global/all", "scope must be workspace, global, or all")),
    };
    run_cmd(&["memory", "clear", flag, "--yes"], cwd.as_deref(), 30).await
}

// ---- Worktree ----

#[tauri::command]
pub async fn worktree_list() -> Result<Value, String> {
    let raw = output(&["worktree", "list", "--json"], None).await?;
    serde_json::from_str(&raw).map_err(|_| raw)
}
#[tauri::command]
pub async fn worktree_rm(id: String) -> Result<CmdResult, String> {
    // 无 -y 标志；stdin 喂 "y" 以防交互确认
    let (ok, text) = exec(&["worktree", "rm", &id], None, Some("y\n"), 30).await?;
    Ok(CmdResult { ok, output: text })
}
#[tauri::command]
pub async fn worktree_gc(max_age: Option<String>) -> Result<CmdResult, String> {
    let mut owned = vec!["worktree".to_string(), "gc".to_string()];
    if let Some(m) = max_age.filter(|s| !s.trim().is_empty()) {
        owned.extend(["--max-age".into(), m]);
    }
    let refs = owned.iter().map(String::as_str).collect::<Vec<_>>();
    run_cmd(&refs, None, 60).await
}

// ---- 会话分叉 / trace / doctor / 磁盘占用 ----

#[tauri::command]
pub async fn fork_session(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    cwd: String,
    session_id: String,
) -> Result<Value, String> {
    if !Path::new(&cwd).is_dir() {
        return Err(crate::i18n::t("项目目录不存在", "The project folder does not exist"));
    }
    // _x.ai/session/fork 与 rename 一样 initialize 后即可用；复用常驻 agent 池语义
    let mut guard = state.agent.lock().await;
    if guard.is_none() {
        *guard = Some(spawn_agent_from_config(&app, &state, &cwd).await?);
    }
    let a = guard.as_ref().unwrap();
    rpc(
        a,
        state.next_id.fetch_add(1, Ordering::Relaxed),
        "_x.ai/session/fork",
        json!({"sourceSessionId":session_id,"sourceCwd":cwd,"newCwd":cwd}),
    )
    .await
}

#[tauri::command]
pub async fn export_trace(session_id: String) -> Result<CmdResult, String> {
    // 本地导出 tar.gz 到 $GROK_HOME/trace-exports/<id>.tar.gz，--json 输出路径
    run_cmd(&["trace", &session_id, "--local", "--json"], None, 60).await
}

#[tauri::command]
pub async fn doctor() -> Result<CmdResult, String> {
    run_cmd(&["doctor"], None, 60).await
}

#[tauri::command]
pub async fn disk_usage() -> Result<Value, String> {
    let raw = output_secs(&["du", "--json"], None, 30).await?;
    serde_json::from_str(&raw).map_err(|_| raw)
}

// ---- Worktree 补全 ----

#[tauri::command]
pub async fn worktree_show(id: String) -> Result<CmdResult, String> {
    run_cmd(&["worktree", "show", &id], None, 30).await
}
#[tauri::command]
pub async fn worktree_detach(id: String) -> Result<CmdResult, String> {
    run_cmd(&["worktree", "detach", &id], None, 60).await
}
#[tauri::command]
pub async fn worktree_salvage(id: String, out: String) -> Result<CmdResult, String> {
    // --help 实测：--out <OUT> 与 <ID_OR_PATH> 均必填
    let out = out.trim().to_string();
    if out.is_empty() {
        return Err(crate::i18n::t("salvage 输出目录不能为空", "The salvage output directory cannot be empty"));
    }
    run_cmd(&["worktree", "salvage", "--out", &out, &id], None, 60).await
}
#[tauri::command]
pub async fn worktree_clean_artifacts(id: String) -> Result<CmdResult, String> {
    // --help 实测：必须 --yes 才真正删除（不可逆）
    run_cmd(&["worktree", "clean-artifacts", "--yes", &id], None, 60).await
}
#[tauri::command]
pub async fn worktree_db(command: Option<String>) -> Result<CmdResult, String> {
    // --help 实测：db 需要子命令 rebuild/stats/path，默认 stats（只读）
    let sub = match command.as_deref().unwrap_or("stats") {
        "rebuild" => "rebuild",
        "path" => "path",
        _ => "stats",
    };
    run_cmd(&["worktree", "db", sub], None, 60).await
}

// ---- 插件市场源 ----

#[tauri::command]
pub async fn marketplace_list() -> Result<Value, String> {
    let raw = output(&["plugin", "marketplace", "list", "--json"], None).await?;
    serde_json::from_str(&raw).map_err(|_| raw)
}
#[tauri::command]
pub async fn marketplace_add(source: String) -> Result<CmdResult, String> {
    let source = source.trim().to_string();
    if source.is_empty() {
        return Err(crate::i18n::t("市场源不能为空", "Marketplace source cannot be empty"));
    }
    run_cmd(&["plugin", "marketplace", "add", &source], None, 60).await
}
#[tauri::command]
pub async fn marketplace_remove(source: String) -> Result<CmdResult, String> {
    // 会卸载其插件，无 --yes 标志；stdin 喂 "y" 以防交互确认
    let (ok, text) = exec(
        &["plugin", "marketplace", "remove", &source],
        None,
        Some("y\n"),
        60,
    )
    .await?;
    Ok(CmdResult { ok, output: text })
}
#[tauri::command]
pub async fn marketplace_update() -> Result<CmdResult, String> {
    run_cmd(&["plugin", "marketplace", "update"], None, 120).await
}
