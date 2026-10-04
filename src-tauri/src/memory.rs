//! 记忆文件管理 + ADHD/Memo 冷库规则注入 + memo-kb 检索。

use crate::commands::CmdResult;
use crate::config::AppConfig;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const IDENTITY_MARKER: &str = "<!-- grok-build-identity -->";

const MEMO_KB_RULES: &str = r#"MEMO COLD KNOWLEDGE BASE (capability switch ON):
- This is an optional local cold knowledge base. Retrieve on demand only when the user asks about past notes or you need prior context not already in MEMORY.md.
- Use Bash (read-only): `memo-kb search 'QUERY' --json --topk 5`
- If `memo-kb` is not on PATH, a user-provided script at `~/.grok-builder/memo-retrieval.py` may be called the same way: `python3 ~/.grok-builder/memo-retrieval.py search 'QUERY'`
- Do not dump the knowledge base into context.
- Do not write or archive into the knowledge base from this agent.
- If the tool fails or the knowledge base is unavailable, tell the user 「知识库暂不可用」."#;

const ADHD_FALLBACK: &str = r#"# i-have-adhd (embedded fallback)
Lead with the next action. Number multi-step tasks. End with one concrete next step.
Suppress tangents. Restate state every turn. Specific time estimates. Make wins visible.
Matter-of-fact errors. Cap lists at 5. No preamble, no recap, no closers.
Source: https://github.com/ayghri/i-have-adhd
"#;

const MEMO_SCRIPT: &str = ".grok-builder/memo-retrieval.py";

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn memory_root() -> PathBuf {
    home().join(".grok/memory")
}

fn identity_rules_path() -> PathBuf {
    home().join(".grok-builder/identity-rules.md")
}

/// User-owned rules. Absent or empty means nothing personal is injected.
fn load_identity_block() -> Option<String> {
    let body = std::fs::read_to_string(identity_rules_path()).ok()?;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn load_adhd_body() -> String {
    for candidate in [
        home().join(".openclaude-desktop/skills/i-have-adhd/SKILL.md"),
        home().join(".agents/skills/i-have-adhd/SKILL.md"),
    ] {
        if let Ok(body) = std::fs::read_to_string(&candidate) {
            if !body.trim().is_empty() {
                return body;
            }
        }
    }
    ADHD_FALLBACK.to_string()
}

/// spawn agent 时注入的 --rules 组合：用户身份规则（文件存在时）+ ADHD 块 + Memo 规则块。
pub fn compose_rules(cfg: &AppConfig) -> String {
    let mut blocks = Vec::new();
    if let Some(identity) = load_identity_block() {
        blocks.push(identity);
    }
    if cfg.adhd_always_on {
        blocks.push(load_adhd_body());
    }
    if cfg.memo_kb_enabled {
        blocks.push(MEMO_KB_RULES.to_string());
    }
    blocks.join("\n\n")
}

/// auto_memory 开启且 `~/.grok-builder/identity-rules.md` 非空时，
/// 往全局 ~/.grok/memory/MEMORY.md 播种一次。以标记注释判断，只做一次。
pub fn seed_global_memory() {
    let Some(identity) = load_identity_block() else {
        return;
    };
    let root = memory_root();
    if std::fs::create_dir_all(&root).is_err() {
        return;
    }
    let path = root.join("MEMORY.md");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.contains(IDENTITY_MARKER) {
        return;
    }
    let mut content = existing;
    if !content.contains("## Preferences") {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str("\n## Preferences\n");
    }
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push('\n');
    content.push_str(IDENTITY_MARKER);
    content.push('\n');
    content.push_str(&identity);
    content.push('\n');
    let _ = std::fs::write(&path, content);
}

/// cwd 末段转 grok 记忆目录 slug：小写、非字母数字转 '-'。
fn project_slug(cwd: &str) -> String {
    let last = Path::new(cwd)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| cwd.to_string());
    let slug: String = last
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    slug.trim_matches('-').to_string()
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    pub path: String,
    pub scope: String,
    pub label: String,
    pub exists: bool,
    pub size: u64,
}

fn memory_file_info(path: &Path, scope: &str, label: &str) -> MemoryFile {
    let meta = std::fs::metadata(path).ok();
    MemoryFile {
        path: path.display().to_string(),
        scope: scope.into(),
        label: label.into(),
        exists: meta.as_ref().map(|m| m.is_file()).unwrap_or(false),
        size: meta.map(|m| m.len()).unwrap_or(0),
    }
}

#[tauri::command]
pub async fn list_memory_files() -> Result<Vec<MemoryFile>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = memory_root();
        let mut out = vec![memory_file_info(
            &root.join("MEMORY.md"),
            "global",
            "全局记忆",
        )];
        if let Ok(rd) = std::fs::read_dir(&root) {
            let mut dirs: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            for d in dirs {
                let label = d
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                out.push(memory_file_info(&d.join("MEMORY.md"), "workspace", &label));
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

/// 解析目标路径并确保在 ~/.grok/memory/ 内（文件可不存在，取父目录 canonicalize）。
/// create_dirs=true 时创建根目录与目标父目录（write 用）；false 无任何写副作用（read 用）。
fn resolve_memory_path(path: &str, create_dirs: bool) -> Result<PathBuf, String> {
    let root = memory_root();
    if create_dirs {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    }
    // 根目录不存在时也基于 canonical 化的 ~/.grok 做前缀校验，逃逸检查不依赖根目录存在
    let grok_dir = home().join(".grok");
    let base = grok_dir.canonicalize().unwrap_or(grok_dir);
    let root_canon = base.join("memory");
    let target = PathBuf::from(path);
    if target
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("路径越界：不允许 ..".into());
    }
    let resolved = if target.exists() {
        target.canonicalize().map_err(|e| e.to_string())?
    } else {
        let parent = target.parent().ok_or_else(|| "无效路径".to_string())?;
        if create_dirs {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // 父目录可能尚不存在（read 空记忆目录）：退回词法路径
        let parent_canon = parent
            .canonicalize()
            .unwrap_or_else(|_| parent.to_path_buf());
        parent_canon.join(target.file_name().ok_or_else(|| "无效路径".to_string())?)
    };
    if !resolved.starts_with(&root_canon) && !resolved.starts_with(&root) {
        return Err("路径越界：仅限 ~/.grok/memory/ 内的文件".into());
    }
    Ok(resolved)
}

#[tauri::command]
pub async fn read_memory_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = resolve_memory_path(&path, false)?;
        if !target.is_file() {
            return Ok(String::new());
        }
        std::fs::read_to_string(&target).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
pub async fn write_memory_file(path: String, content: String) -> Result<MemoryFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = resolve_memory_path(&path, true)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // 原子写：临时文件 + rename
        let tmp = target.with_extension("tmp-grok-builder");
        std::fs::write(&tmp, &content).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        let scope = if target.parent() == Some(memory_root().as_path()) {
            "global"
        } else {
            "workspace"
        };
        let label = if scope == "global" {
            "全局记忆".to_string()
        } else {
            target
                .parent()
                .and_then(|p| p.file_name())
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        };
        Ok(memory_file_info(&target, scope, &label))
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
pub async fn append_memory_note(cwd: String, note: String) -> Result<MemoryFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let note = note.trim().to_string();
        if note.is_empty() {
            return Err("备注内容不能为空".to_string());
        }
        let root = memory_root();
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let slug = project_slug(&cwd);
        let mut matches: Vec<PathBuf> = Vec::new();
        if !slug.is_empty() {
            if let Ok(rd) = std::fs::read_dir(&root) {
                matches = rd
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .filter(|p| {
                        p.file_name()
                            .map(|n| {
                                let n = n.to_string_lossy();
                                n.as_ref() == slug || n.starts_with(&format!("{slug}-"))
                            })
                            .unwrap_or(false)
                    })
                    .collect();
            }
        }
        // 唯一匹配用工作区记忆，否则落到全局
        let target = if matches.len() == 1 {
            matches[0].join("MEMORY.md")
        } else {
            root.join("MEMORY.md")
        };
        let mut content = std::fs::read_to_string(&target).unwrap_or_default();
        if !content.contains("## Preferences") {
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str("\n## Preferences\n");
        }
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&format!("- {note}\n"));
        let tmp = target.with_extension("tmp-grok-builder");
        std::fs::write(&tmp, &content).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        let scope = if target.parent() == Some(root.as_path()) {
            "global"
        } else {
            "workspace"
        };
        let label = if scope == "global" {
            "全局记忆".to_string()
        } else {
            target
                .parent()
                .and_then(|p| p.file_name())
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        };
        Ok(memory_file_info(&target, scope, &label))
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
pub async fn open_memory_folder() -> Result<(), String> {
    let root = memory_root();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let status = Command::new("/usr/bin/open")
        .arg(&root)
        .status()
        .await
        .map_err(|e| format!("无法打开访达：{e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("open 命令失败".into())
    }
}

// ---- memo-kb 冷库 ----

async fn which_memo_kb() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let o = timeout(
        Duration::from_secs(8),
        Command::new(shell).args(["-lc", "which memo-kb"]).output(),
    )
    .await
    .ok()?
    .ok()?;
    if !o.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
    if p.is_empty() {
        None
    } else {
        Some(p)
    }
}

fn memo_script_path() -> Option<PathBuf> {
    let p = home().join(MEMO_SCRIPT);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

async fn run_probe(mut cmd: Command, secs: u64) -> Result<String, String> {
    let o = timeout(Duration::from_secs(secs), cmd.output())
        .await
        .map_err(|_| "命令超时".to_string())?
        .map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&o.stdout).to_string();
    if !o.status.success() {
        let stderr = String::from_utf8_lossy(&o.stderr).to_string();
        let err: Vec<&str> = stderr
            .lines()
            .filter(|l| !l.contains("auth.json") && !l.to_lowercase().contains("token"))
            .collect();
        if !err.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&err.join("\n"));
        }
    }
    Ok(text)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoStatus {
    pub available: bool,
    pub detail: String,
}

#[tauri::command]
pub async fn memo_kb_status() -> Result<MemoStatus, String> {
    let mut reasons: Vec<String> = Vec::new();
    if let Some(bin) = which_memo_kb().await {
        let mut c = Command::new(&bin);
        c.args(["search", "ping", "--json", "--topk", "1"]);
        match run_probe(c, 15).await {
            Ok(_) => {
                return Ok(MemoStatus {
                    available: true,
                    detail: format!("memo-kb 可用（{bin}）"),
                });
            }
            Err(e) => reasons.push(format!("memo-kb 探测失败：{e}")),
        }
    } else {
        reasons.push("memo-kb 未安装".into());
    }
    if let Some(script) = memo_script_path() {
        let mut c = Command::new("python3");
        c.arg(&script).args(["search", "ping"]);
        match run_probe(c, 15).await {
            Ok(_) => {
                return Ok(MemoStatus {
                    available: true,
                    detail: format!("memo-kb 不可用，回退脚本可用（{}）", script.display()),
                });
            }
            Err(e) => reasons.push(format!("回退脚本探测失败：{e}")),
        }
    } else {
        reasons.push("回退脚本也不存在".into());
    }
    Ok(MemoStatus {
        available: false,
        detail: reasons.join("；"),
    })
}

#[tauri::command]
pub async fn memo_kb_search(query: String) -> Result<CmdResult, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("搜索词不能为空".into());
    }
    if let Some(bin) = which_memo_kb().await {
        let mut c = Command::new(&bin);
        c.args(["search", &query, "--json", "--topk", "5"]);
        return match run_probe(c, 30).await {
            Ok(text) => Ok(CmdResult {
                ok: true,
                output: text,
            }),
            Err(e) => Ok(CmdResult {
                ok: false,
                output: format!("memo-kb 检索失败：{e}"),
            }),
        };
    }
    if let Some(script) = memo_script_path() {
        let mut c = Command::new("python3");
        c.arg(&script).args(["search", &query]);
        return match run_probe(c, 30).await {
            Ok(text) => Ok(CmdResult {
                ok: true,
                output: text,
            }),
            Err(e) => Ok(CmdResult {
                ok: false,
                output: format!("回退脚本检索失败：{e}"),
            }),
        };
    }
    Ok(CmdResult {
        ok: false,
        output: "知识库暂不可用：memo-kb 未安装，回退脚本也不存在".into(),
    })
}
