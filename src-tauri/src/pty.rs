//! Interactive PTY sessions via portable-pty + Tauri events.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 30;

pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct PtyState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyCreateResult {
    pub id: String,
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

#[tauri::command]
pub fn pty_create(
    app: AppHandle,
    state: State<'_, Arc<PtyState>>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<PtyCreateResult, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(DEFAULT_ROWS).max(1),
            cols: cols.unwrap_or(DEFAULT_COLS).max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    // Login shell so PATH / profile apply
    if shell.contains("zsh") || shell.ends_with("/bash") || shell.ends_with("bash") {
        cmd.arg("-l");
    }
    if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    {
        let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
        map.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let app_r = app.clone();
    let id_r = id.clone();
    let state_r = state.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_r.emit("pty-output", serde_json::json!({"id": id_r, "data": data}));
                }
                Err(_) => break,
            }
        }
        // Wait for exit code if session still present
        let code = {
            let mut map = match state_r.sessions.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            if let Some(mut sess) = map.remove(&id_r) {
                match sess.child.wait() {
                    Ok(status) => status.exit_code() as i32,
                    Err(_) => -1,
                }
            } else {
                return;
            }
        };
        let _ = app_r.emit("pty-exit", serde_json::json!({"id": id_r, "code": code}));
    });

    Ok(PtyCreateResult { id })
}

#[tauri::command]
pub fn pty_write(state: State<'_, Arc<PtyState>>, id: String, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
    let sess = map
        .get_mut(&id)
        .ok_or_else(|| format!("unknown pty {id}"))?;
    sess.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("pty write: {e}"))?;
    let _ = sess.writer.flush();
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, Arc<PtyState>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.sessions.lock().map_err(|e| e.to_string())?;
    let sess = map.get(&id).ok_or_else(|| format!("unknown pty {id}"))?;
    sess.master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Arc<PtyState>>, id: String) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut sess) = map.remove(&id) {
        let _ = sess.child.kill();
    }
    Ok(())
}
