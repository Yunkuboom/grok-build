mod commands;
mod companion;
mod config;
mod git_files;
mod i18n;
mod memory;
mod pty;
use commands::AppState;
use pty::PtyState;
use std::sync::Arc;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::default()))
        .manage(Arc::new(PtyState::default()))
        .setup(|app| {
            if let Ok(cfg) = config::read_config() {
                i18n::apply_pref(&cfg.locale);
            }
            companion::restore_on_launch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            frontend_log,
            commands::core_status,
            commands::list_sessions,
            commands::search_sessions,
            commands::delete_session,
            commands::rename_session,
            commands::fork_session,
            commands::export_trace,
            commands::doctor,
            commands::disk_usage,
            commands::export_session,
            commands::session_usage,
            commands::workspace_usage,
            commands::start_session,
            commands::send_prompt,
            commands::cancel_session,
            commands::stop_agent,
            commands::permission_reply,
            commands::ask_reply,
            commands::exit_plan_reply,
            commands::set_session_option,
            commands::set_session_mode,
            commands::set_sp_enabled,
            commands::check_update,
            commands::install_update,
            commands::switch_update_channel,
            commands::launch_login,
            commands::launch_device_login,
            commands::logout,
            commands::list_files,
            commands::read_file,
            commands::open_in_finder,
            commands::extension_status,
            commands::mcp_list,
            commands::mcp_add,
            commands::mcp_remove,
            commands::mcp_enable,
            commands::mcp_disable,
            commands::mcp_doctor,
            commands::plugin_list,
            commands::plugin_install,
            commands::plugin_uninstall,
            commands::plugin_enable,
            commands::plugin_disable,
            commands::memory_clear,
            commands::worktree_list,
            commands::worktree_rm,
            commands::worktree_gc,
            commands::worktree_show,
            commands::worktree_detach,
            commands::worktree_salvage,
            commands::worktree_clean_artifacts,
            commands::worktree_db,
            commands::marketplace_list,
            commands::marketplace_add,
            commands::marketplace_remove,
            commands::marketplace_update,
            companion::companion_status,
            companion::companion_enable,
            companion::companion_disable,
            companion::companion_rotate_token,
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            git_files::list_workdir_tree,
            git_files::read_workdir_file,
            git_files::git_status,
            git_files::git_diff_file,
            git_files::git_stage,
            git_files::git_unstage,
            git_files::git_commit,
            git_files::git_branches,
            git_files::git_checkout,
            config::get_app_config,
            config::save_app_config,
            memory::list_memory_files,
            memory::read_memory_file,
            memory::write_memory_file,
            memory::append_memory_note,
            memory::open_memory_folder,
            memory::memo_kb_status,
            memory::memo_kb_search,
            i18n::set_ui_language
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Grok Build Desktop")
}

#[tauri::command]
fn frontend_log(msg: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/grok-builder-frontend.log")
    {
        let _ = writeln!(f, "{}", msg);
    }
}
