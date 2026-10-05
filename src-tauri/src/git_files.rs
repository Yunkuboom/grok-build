//! Workdir file tree + git status/diff/stage/commit helpers.
//! Spawns system `git` with cwd set — no libgit2.
//! Ported from openclaude git_files.rs.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".DS_Store",
    ".next",
    ".turbo",
    "build",
    "__pycache__",
    ".venv",
    "venv",
];
const MAX_DEPTH: usize = 6;
const MAX_FILES: usize = 2000;
const MAX_READ_BYTES: u64 = 2_000_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_STATUS_ENTRIES: usize = 500;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub relative: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub ok: bool,
    pub text: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub index_status: String,
    pub work_tree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub is_repo: bool,
    pub branch: String,
    pub entries: Vec<GitStatusEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchesResult {
    pub current: String,
    pub branches: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn path_has_dotdot(p: &Path) -> bool {
    p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
}

fn canonicalize_loose(p: &Path) -> Result<PathBuf, String> {
    if p.exists() {
        return p.canonicalize().map_err(|e| e.to_string());
    }
    let mut cur = p.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    while !cur.exists() {
        let name = cur
            .file_name()
            .ok_or_else(|| format!("invalid path: {}", p.display()))?
            .to_os_string();
        missing.push(name);
        cur = cur
            .parent()
            .ok_or_else(|| format!("invalid path: {}", p.display()))?
            .to_path_buf();
    }
    let mut canon = cur.canonicalize().map_err(|e| e.to_string())?;
    for part in missing.into_iter().rev() {
        canon.push(part);
    }
    Ok(canon)
}

fn resolve_under_cwd(cwd: &str, relative: &str) -> Result<PathBuf, String> {
    let cwd = cwd.trim();
    let relative = relative.trim().trim_start_matches('/');
    if cwd.is_empty() {
        return Err("cwd required".into());
    }
    if relative.is_empty() {
        return Err("relative path required".into());
    }
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    let joined = root.join(relative);
    if path_has_dotdot(&joined) {
        return Err("path traversal rejected".into());
    }
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;
    let target = canonicalize_loose(&joined)?;
    if !target.starts_with(&root_canon) {
        return Err("path escapes cwd".into());
    }
    Ok(target)
}

fn should_skip_name(name: &str) -> bool {
    if name == ".DS_Store" {
        return true;
    }
    SKIP_DIRS.iter().any(|s| *s == name)
}

/// Kill a process by pid (SIGKILL). Best-effort; used on git timeout.
fn kill_pid(pid: u32) {
    let _ = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Run `git` with cwd, ~8s timeout. On timeout kills the process and returns Err.
/// Uses spawn + wait_with_output on a worker thread to avoid pipe deadlock.
fn git_output(cwd: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    if cwd.trim().is_empty() {
        return Err("cwd required".into());
    }
    let child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                crate::i18n::t("未找到 git 命令", "git was not found")
            } else {
                format!("git spawn failed: {e}")
            }
        })?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(GIT_TIMEOUT) {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Ok((output.status.success(), stdout, stderr))
        }
        Ok(Err(e)) => Err(format!("git wait failed: {e}")),
        Err(_) => {
            kill_pid(pid);
            // Drain so the worker thread can exit
            let _ = rx.recv_timeout(Duration::from_millis(300));
            Err(crate::i18n::t("git 超时（仓库过大或扫到家目录）", "git timed out (the repo is large, or the scan reached the home directory)"))
        }
    }
}

fn is_git_repo(cwd: &str) -> Result<bool, String> {
    match git_output(cwd, &["rev-parse", "--is-inside-work-tree"]) {
        Ok((true, out, _)) => Ok(out.trim() == "true"),
        Ok((false, _, _)) => Ok(false),
        Err(e) => Err(e),
    }
}

fn current_branch(cwd: &str) -> String {
    if let Ok((true, out, _)) = git_output(cwd, &["branch", "--show-current"]) {
        let b = out.trim().to_string();
        if !b.is_empty() {
            return b;
        }
    }
    if let Ok((true, out, _)) = git_output(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        return out.trim().to_string();
    }
    String::new()
}

fn show_toplevel(cwd: &str) -> Option<String> {
    match git_output(cwd, &["rev-parse", "--show-toplevel"]) {
        Ok((true, out, _)) => {
            let t = out.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }
        _ => None,
    }
}

fn show_prefix(cwd: &str) -> String {
    match git_output(cwd, &["rev-parse", "--show-prefix"]) {
        Ok((true, out, _)) => out.trim().to_string(),
        _ => String::new(),
    }
}

/// Unescape git-quoted paths: `"foo\346\bar"` → UTF-8, plus `\\` `\"` `\t` `\n` `\r`.
fn unescape_git_path(raw: &str) -> String {
    let s = raw.trim();
    let (inner, need) = if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        (&s[1..s.len() - 1], true)
    } else if s.contains('\\') {
        (s, true)
    } else {
        return s.to_string();
    };
    if !need {
        return inner.to_string();
    }
    let bytes = inner.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'\\' => {
                    out.push(b'\\');
                    i += 2;
                }
                b'"' => {
                    out.push(b'"');
                    i += 2;
                }
                b't' => {
                    out.push(b'\t');
                    i += 2;
                }
                b'n' => {
                    out.push(b'\n');
                    i += 2;
                }
                b'r' => {
                    out.push(b'\r');
                    i += 2;
                }
                b'0'..=b'7' => {
                    let mut val: u8 = 0;
                    let mut j = 0;
                    while j < 3 && i + 1 + j < bytes.len() {
                        let c = bytes[i + 1 + j];
                        if !(b'0'..=b'7').contains(&c) {
                            break;
                        }
                        val = val.wrapping_mul(8).wrapping_add(c - b'0');
                        j += 1;
                    }
                    out.push(val);
                    i += 1 + j;
                }
                other => {
                    out.push(other);
                    i += 2;
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Strip repo-relative show-prefix so paths are cwd-relative.
fn strip_show_prefix(path: &str, prefix: &str) -> String {
    if prefix.is_empty() {
        return path.to_string();
    }
    let p = path.replace('\\', "/");
    let pref = prefix.replace('\\', "/");
    let pref = if pref.ends_with('/') {
        pref
    } else {
        format!("{pref}/")
    };
    if let Some(rest) = p.strip_prefix(&pref) {
        rest.to_string()
    } else if p == pref.trim_end_matches('/') {
        String::new()
    } else {
        p
    }
}

fn same_path_as_home(toplevel: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let top = PathBuf::from(toplevel);
    let top_canon = top.canonicalize().unwrap_or(top);
    let home_canon = home.canonicalize().unwrap_or(home);
    top_canon == home_canon
}

fn list_workdir_tree_inner(cwd: String) -> Result<Vec<TreeNode>, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(vec![]);
    }
    let root = Path::new(&cwd);
    if !root.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    let mut count = 0usize;
    let children = collect_tree(root, root, 0, &mut count)?;
    Ok(children)
}

#[tauri::command]
pub async fn list_workdir_tree(cwd: String) -> Result<Vec<TreeNode>, String> {
    tauri::async_runtime::spawn_blocking(move || list_workdir_tree_inner(cwd))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

fn collect_tree(
    root: &Path,
    dir: &Path,
    depth: usize,
    count: &mut usize,
) -> Result<Vec<TreeNode>, String> {
    if depth > MAX_DEPTH || *count >= MAX_FILES {
        return Ok(vec![]);
    }
    let mut entries: Vec<(String, PathBuf, bool)> = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_name(&name) {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        if name.starts_with('.') && is_dir {
            continue;
        }
        entries.push((name, path, is_dir));
    }
    entries.sort_by(|a, b| match (a.2, b.2) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });

    let mut nodes = Vec::new();
    for (name, path, is_dir) in entries {
        if *count >= MAX_FILES {
            break;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if is_dir {
            *count += 1;
            let children = if depth + 1 <= MAX_DEPTH {
                Some(collect_tree(root, &path, depth + 1, count)?)
            } else {
                Some(vec![])
            };
            nodes.push(TreeNode {
                name,
                path: path.display().to_string(),
                relative,
                is_dir: true,
                children,
            });
        } else {
            *count += 1;
            nodes.push(TreeNode {
                name,
                path: path.display().to_string(),
                relative,
                is_dir: false,
                children: None,
            });
        }
    }
    Ok(nodes)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

#[tauri::command]
pub fn read_workdir_file(cwd: String, path: String) -> Result<String, String> {
    let target = resolve_under_cwd(&cwd, &path)?;
    if !target.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(crate::i18n::t("文件超过 2 MB 预览限制", "File is over the 2 MB preview limit"));
    }
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    if looks_binary(&bytes) {
        return Err(crate::i18n::t("暂不预览二进制文件", "Binary files are not previewed"));
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn git_diff_file_inner(
    cwd: String,
    path: String,
    staged: Option<bool>,
) -> Result<DiffResult, String> {
    let cwd = cwd.trim().to_string();
    let path = path.trim().trim_start_matches('/').to_string();
    if cwd.is_empty() {
        return Ok(DiffResult {
            ok: false,
            text: String::new(),
            message: crate::i18n::t("未选择工作目录", "No workspace selected"),
        });
    }
    // Ensure path under cwd (even if file doesn't exist yet for deleted)
    let _ = resolve_under_cwd(&cwd, &path).or_else(|_| {
        // For deleted files, parent check: join without requiring file exist under prefix
        let root = PathBuf::from(&cwd)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let joined = root.join(&path);
        if path_has_dotdot(&joined) {
            return Err::<PathBuf, String>("path traversal rejected".to_string());
        }
        Ok(joined)
    })?;

    match is_git_repo(&cwd) {
        Ok(false) => {
            return Ok(DiffResult {
                ok: false,
                text: String::new(),
                message: crate::i18n::t("当前目录不是 git 仓库", "This folder is not a git repository"),
            });
        }
        Err(e) => {
            return Ok(DiffResult {
                ok: false,
                text: String::new(),
                message: e,
            });
        }
        Ok(true) => {}
    }

    // Explicit staged/unstaged views when requested
    if let Some(want_staged) = staged {
        let args: Vec<&str> = if want_staged {
            vec!["diff", "--cached", "--", &path]
        } else {
            vec!["diff", "--", &path]
        };
        let (ok, out, err) = git_output(&cwd, &args)?;
        if !ok && out.trim().is_empty() {
            return Ok(DiffResult {
                ok: false,
                text: String::new(),
                message: if err.trim().is_empty() {
                    crate::i18n::t("无变更", "No changes")
                } else {
                    err.trim().to_string()
                },
            });
        }
        let empty = out.trim().is_empty();
        return Ok(DiffResult {
            ok: true,
            text: out,
            message: if empty {
                crate::i18n::t("无变更", "No changes")
            } else {
                String::new()
            },
        });
    }

    // Combined: staged + unstaged vs HEAD
    let (ok1, out1, err1) = git_output(&cwd, &["diff", "HEAD", "--", &path])?;
    if !ok1 && !err1.trim().is_empty() && out1.trim().is_empty() {
        // Untracked? try showing as added
        let (ok_st, st_out, _) = git_output(
            &cwd,
            &[
                "-c",
                "core.quotepath=false",
                "status",
                "--porcelain=v1",
                "-u",
                "--",
                &path,
            ],
        )?;
        if ok_st {
            let line = st_out.lines().next().unwrap_or("").to_string();
            if line.starts_with("??") || line.starts_with("A ") || line.contains("??") {
                match read_workdir_file(cwd.clone(), path.clone()) {
                    Ok(content) => {
                        let mut diff = format!("--- /dev/null\n+++ b/{path}\n");
                        for (i, l) in content.lines().enumerate() {
                            if i == 0 {
                                diff.push_str(&format!(
                                    "@@ -0,0 +1,{} @@\n",
                                    content.lines().count()
                                ));
                            }
                            diff.push('+');
                            diff.push_str(l);
                            diff.push('\n');
                        }
                        if content.is_empty() {
                            diff.push_str("@@ -0,0 +0,0 @@\n");
                        }
                        return Ok(DiffResult {
                            ok: true,
                            text: diff,
                            message: crate::i18n::t("未跟踪文件（显示为新增）", "Untracked file (shown as added)"),
                        });
                    }
                    Err(e) => {
                        return Ok(DiffResult {
                            ok: false,
                            text: String::new(),
                            message: e,
                        });
                    }
                }
            }
        }
        return Ok(DiffResult {
            ok: false,
            text: String::new(),
            message: if err1.trim().is_empty() {
                crate::i18n::t("无变更", "No changes")
            } else {
                err1.trim().to_string()
            },
        });
    }

    let text = out1;
    if text.trim().is_empty() {
        // Also try unstaged-only in case HEAD missing for new repo
        let (ok2, out2, _) = git_output(&cwd, &["diff", "--", &path])?;
        let (ok3, out3, _) = git_output(&cwd, &["diff", "--cached", "--", &path])?;
        let mut combined = String::new();
        if ok3 && !out3.trim().is_empty() {
            combined.push_str(&out3);
        }
        if ok2 && !out2.trim().is_empty() {
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(&out2);
        }
        if combined.trim().is_empty() {
            // Untracked
            let (ok_st, st_out, _) = git_output(
                &cwd,
                &[
                    "-c",
                    "core.quotepath=false",
                    "status",
                    "--porcelain=v1",
                    "-u",
                    "--",
                    &path,
                ],
            )?;
            if ok_st
                && st_out
                    .lines()
                    .any(|l| l.starts_with("??") || l.starts_with("A "))
            {
                if let Ok(content) = read_workdir_file(cwd, path.clone()) {
                    let line_count = content.lines().count();
                    let mut diff =
                        format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{line_count} @@\n");
                    for l in content.lines() {
                        diff.push('+');
                        diff.push_str(l);
                        diff.push('\n');
                    }
                    return Ok(DiffResult {
                        ok: true,
                        text: diff,
                        message: crate::i18n::t("未跟踪文件（显示为新增）", "Untracked file (shown as added)"),
                    });
                }
            }
            return Ok(DiffResult {
                ok: true,
                text: String::new(),
                message: crate::i18n::t("无变更", "No changes"),
            });
        }
        return Ok(DiffResult {
            ok: true,
            text: combined,
            message: String::new(),
        });
    }

    Ok(DiffResult {
        ok: true,
        text,
        message: String::new(),
    })
}

#[tauri::command]
pub async fn git_diff_file(
    cwd: String,
    path: String,
    staged: Option<bool>,
) -> Result<DiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_file_inner(cwd, path, staged))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

fn parse_porcelain_line(line: &str) -> Option<GitStatusEntry> {
    if line.len() < 3 {
        return None;
    }
    // XY PATH or XY "PATH" or rename
    let index_status = line.chars().next().unwrap_or(' ').to_string();
    let work_tree_status = line.chars().nth(1).unwrap_or(' ').to_string();
    let rest = line.get(3..).unwrap_or("").trim();
    // Handle rename: "R  old -> new" or "R  \"old\" -> \"new\""
    let path_raw = if let Some(idx) = rest.find(" -> ") {
        rest[idx + 4..].trim()
    } else {
        rest
    };
    let path = unescape_git_path(path_raw);
    if path.is_empty() {
        return None;
    }
    let untracked = index_status == "?" && work_tree_status == "?";
    let staged = !untracked && index_status != " " && index_status != "?";
    let unstaged = !untracked && work_tree_status != " " && work_tree_status != "?";
    // Untracked counts as unstaged for UI
    Some(GitStatusEntry {
        path,
        index_status,
        work_tree_status,
        staged,
        unstaged: unstaged || untracked,
        untracked,
    })
}

fn git_status_inner(cwd: String) -> Result<GitStatusResult, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(GitStatusResult {
            is_repo: false,
            branch: String::new(),
            entries: vec![],
            error: Some(crate::i18n::t("未选择工作目录", "No workspace selected")),
            warning: None,
        });
    }
    match is_git_repo(&cwd) {
        Ok(false) => {
            return Ok(GitStatusResult {
                is_repo: false,
                branch: String::new(),
                entries: vec![],
                error: Some(crate::i18n::t("当前目录不是 git 仓库", "This folder is not a git repository")),
                warning: None,
            });
        }
        Err(e) => {
            return Ok(GitStatusResult {
                is_repo: false,
                branch: String::new(),
                entries: vec![],
                error: Some(e),
                warning: None,
            });
        }
        Ok(true) => {}
    }

    let mut warnings: Vec<String> = Vec::new();
    let toplevel = show_toplevel(&cwd);
    let prefix = show_prefix(&cwd);
    if let Some(ref top) = toplevel {
        if same_path_as_home(top) {
            warnings
                .push(crate::i18n::t("仓库根在家目录 (~)，仅显示当前文件夹下的变更；建议删掉误建的 ~/.git", "The repo root is the home directory (~). Only changes under the current folder are shown. Remove an accidental ~/.git if you created one."));
        }
    }

    // Always scope to cwd (`.`) — never scan entire home when ~/.git exists.
    let (ok, out, err) = git_output(
        &cwd,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "-u",
            "--",
            ".",
        ],
    )?;
    if !ok {
        return Ok(GitStatusResult {
            is_repo: true,
            branch: current_branch(&cwd),
            entries: vec![],
            error: Some(if err.trim().is_empty() {
                crate::i18n::t("git status 失败", "git status failed")
            } else {
                err.trim().to_string()
            }),
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join("；"))
            },
        });
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    for line in out.lines() {
        if let Some(mut e) = parse_porcelain_line(line) {
            e.path = strip_show_prefix(&e.path, &prefix);
            if e.path.is_empty() {
                continue;
            }
            if entries.len() >= MAX_STATUS_ENTRIES {
                truncated = true;
                break;
            }
            entries.push(e);
        }
    }
    if truncated {
        warnings.push((if crate::i18n::is_en() { format!("Too many changes. Showing the first {MAX_STATUS_ENTRIES}") } else { format!("变更过多，仅显示前 {MAX_STATUS_ENTRIES} 条") }));
    }

    Ok(GitStatusResult {
        is_repo: true,
        branch: current_branch(&cwd),
        entries,
        error: None,
        warning: if warnings.is_empty() {
            None
        } else {
            Some(warnings.join("；"))
        },
    })
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<GitStatusResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_inner(cwd))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

fn git_stage_inner(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Err("cwd required".into());
    }
    let owned: Vec<String> = paths
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if owned.is_empty() {
        return Err(crate::i18n::t("没有要暂存的文件", "No files to stage"));
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    for p in &owned {
        args.push(p);
    }
    let (ok, _, err) = git_output(&cwd, &args)?;
    if ok {
        Ok(())
    } else {
        Err(if err.trim().is_empty() {
            crate::i18n::t("git add 失败", "git add failed")
        } else {
            err.trim().to_string()
        })
    }
}

#[tauri::command]
pub async fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git_stage_inner(cwd, paths))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

fn git_unstage_inner(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Err("cwd required".into());
    }
    let owned: Vec<String> = paths
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if owned.is_empty() {
        return Err(crate::i18n::t("没有要取消暂存的文件", "No files to unstage"));
    }
    // Prefer restore --staged; fallback to reset HEAD --
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    for p in &owned {
        args.push(p);
    }
    let (ok, _, err) = git_output(&cwd, &args)?;
    if ok {
        return Ok(());
    }
    let mut args2: Vec<&str> = vec!["reset", "HEAD", "--"];
    for p in &owned {
        args2.push(p);
    }
    let (ok2, _, err2) = git_output(&cwd, &args2)?;
    if ok2 {
        Ok(())
    } else {
        let msg = [err.trim(), err2.trim()]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("; ");
        Err(if msg.is_empty() {
            crate::i18n::t("取消暂存失败", "Could not unstage")
        } else {
            msg
        })
    }
}

#[tauri::command]
pub async fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git_unstage_inner(cwd, paths))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

fn git_commit_inner(cwd: String, message: String) -> Result<String, String> {
    let cwd = cwd.trim().to_string();
    let message = message.trim().to_string();
    if cwd.is_empty() {
        return Err("cwd required".into());
    }
    if message.is_empty() {
        return Err(crate::i18n::t("提交说明不能为空", "Commit message cannot be empty"));
    }
    // Ensure something is staged
    let (ok_st, st_out, _) = git_output(&cwd, &["diff", "--cached", "--name-only"])?;
    if !ok_st || st_out.trim().is_empty() {
        return Err(crate::i18n::t("没有已暂存的变更", "Nothing is staged"));
    }
    let (ok, out, err) = git_output(&cwd, &["commit", "-m", &message])?;
    if ok {
        Ok(out.trim().to_string())
    } else {
        Err(if err.trim().is_empty() {
            out.trim().to_string()
        } else {
            err.trim().to_string()
        })
    }
}

#[tauri::command]
pub async fn git_commit(cwd: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_inner(cwd, message))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

fn git_branches_inner(cwd: String) -> Result<GitBranchesResult, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(GitBranchesResult {
            current: String::new(),
            branches: vec![],
            error: Some(crate::i18n::t("未选择工作目录", "No workspace selected")),
        });
    }
    match is_git_repo(&cwd) {
        Ok(false) => {
            return Ok(GitBranchesResult {
                current: String::new(),
                branches: vec![],
                error: Some(crate::i18n::t("当前目录不是 git 仓库", "This folder is not a git repository")),
            });
        }
        Err(e) => {
            return Ok(GitBranchesResult {
                current: String::new(),
                branches: vec![],
                error: Some(e),
            });
        }
        Ok(true) => {}
    }
    let current = current_branch(&cwd);
    let (ok, out, err) = git_output(&cwd, &["branch", "--format=%(refname:short)"])?;
    if !ok {
        return Ok(GitBranchesResult {
            current,
            branches: vec![],
            error: Some(err.trim().to_string()),
        });
    }
    let mut branches: Vec<String> = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    branches.sort();
    Ok(GitBranchesResult {
        current,
        branches,
        error: None,
    })
}

#[tauri::command]
pub async fn git_branches(cwd: String) -> Result<GitBranchesResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_branches_inner(cwd))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

fn git_checkout_inner(cwd: String, branch: String) -> Result<(), String> {
    let cwd = cwd.trim().to_string();
    let branch = branch.trim().to_string();
    if cwd.is_empty() || branch.is_empty() {
        return Err(crate::i18n::t("cwd 与分支名均为必填", "Both the workspace and the branch name are required"));
    }
    // Prefer switch, fallback checkout
    let (ok, _, err) = git_output(&cwd, &["switch", &branch])?;
    if ok {
        return Ok(());
    }
    let (ok2, _, err2) = git_output(&cwd, &["checkout", &branch])?;
    if ok2 {
        Ok(())
    } else {
        let msg = [err.trim(), err2.trim()]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("; ");
        Err(if msg.is_empty() {
            crate::i18n::t("切换分支失败", "Could not switch branch")
        } else {
            msg
        })
    }
}

#[tauri::command]
pub async fn git_checkout(cwd: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git_checkout_inner(cwd, branch))
        .await
        .map_err(|e| format!("task join: {e}"))?
}
