//! App config persistence at ~/.grok-builder/config.json.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub last_cwd: String,
    #[serde(default)]
    pub recent_cwds: Vec<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default = "default_true")]
    pub adhd_always_on: bool,
    #[serde(default = "default_true")]
    pub auto_memory: bool,
    #[serde(default)]
    pub memo_kb_enabled: bool,
    #[serde(default)]
    pub pinned_sessions: Vec<String>,
    #[serde(default)]
    pub hidden_sessions: Vec<String>,
    #[serde(default)]
    pub collapsed_workspaces: Vec<String>,
    #[serde(default)]
    pub sp_enabled: bool,
    /// "system" | "zh" | "en". Missing values follow the system language.
    #[serde(default = "default_locale")]
    pub locale: String,
}

fn default_theme() -> String {
    "system".into()
}
fn default_permission_mode() -> String {
    "plan".into()
}
fn default_true() -> bool {
    true
}
fn default_locale() -> String {
    "system".into()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            last_cwd: String::new(),
            recent_cwds: vec![],
            model: String::new(),
            effort: String::new(),
            permission_mode: default_permission_mode(),
            adhd_always_on: true,
            auto_memory: true,
            memo_kb_enabled: false,
            pinned_sessions: vec![],
            hidden_sessions: vec![],
            collapsed_workspaces: vec![],
            sp_enabled: false,
            locale: default_locale(),
        }
    }
}

pub fn app_home() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    Ok(home.join(".grok-builder"))
}

pub fn config_path() -> Result<PathBuf, String> {
    Ok(app_home()?.join("config.json"))
}

pub fn read_config() -> Result<AppConfig, String> {
    let home = app_home()?;
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn write_config(cfg: AppConfig) -> Result<AppConfig, String> {
    let home = app_home()?;
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let path = config_path()?;
    let raw = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())?;
    Ok(cfg)
}

#[tauri::command]
pub fn get_app_config() -> Result<AppConfig, String> {
    let cfg = read_config()?;
    crate::i18n::apply_pref(&cfg.locale);
    Ok(cfg)
}

#[tauri::command]
pub fn save_app_config(app: AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    crate::i18n::apply_pref(&config.locale);
    let saved = write_config(config)?;
    let payload = serde_json::to_value(&saved).unwrap_or(serde_json::Value::Null);
    crate::companion::emit_event(&app, "app-config", &payload);
    Ok(saved)
}
