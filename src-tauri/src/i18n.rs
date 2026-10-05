//! UI language for user-visible backend messages.
//! `system` follows the macOS preferred language. Explicit zh/en overrides it.

use std::sync::atomic::{AtomicU8, Ordering};

const ZH: u8 = 0;
const EN: u8 = 1;

static LANG: AtomicU8 = AtomicU8::new(ZH);

pub fn is_en() -> bool {
    LANG.load(Ordering::Relaxed) == EN
}

pub fn t(zh: &str, en: &str) -> String {
    if is_en() { en.to_string() } else { zh.to_string() }
}

fn system_is_zh() -> bool {
    if let Ok(out) = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleLanguages"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(start) = text.find('"') {
                let rest = &text[start + 1..];
                if let Some(end) = rest.find('"') {
                    return rest[..end].to_ascii_lowercase().starts_with("zh");
                }
            }
        }
    }
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.to_ascii_lowercase();
            if value.starts_with("zh") {
                return true;
            }
            if value.starts_with("en") {
                return false;
            }
        }
    }
    false
}

pub fn apply_pref(pref: &str) {
    let en = match pref {
        "en" => true,
        "zh" => false,
        _ => !system_is_zh(),
    };
    LANG.store(if en { EN } else { ZH }, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_ui_language(lang: String) {
    apply_pref(&lang);
}
