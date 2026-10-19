mod commands;
mod db;
mod error;
mod remote;
mod state;
mod store;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            // 드롭된 로컬 경로는 백엔드에 두고 웹뷰에는 id 와 이름만 보낸다
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) = event {
                let pick = window.state::<state::AppState>().picks.register(paths.clone());
                let _ = window.emit("os-drop", serde_json::json!({ "pick": pick, "x": position.x, "y": position.y }));
            }
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(state::AppState::new(dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::conn::list_connections,
            commands::conn::save_connection,
            commands::conn::delete_connection,
            commands::conn::reorder_connections,
            commands::conn::test_connection,
            commands::conn::connect,
            commands::conn::disconnect,
            commands::remote::remote_trust_host,
            commands::remote::pick_key_file,
            commands::remote::pick_upload,
            commands::remote::pick_download_target,
            commands::remote::pick_release,
            commands::remote::remote_list,
            commands::remote::remote_mkdir,
            commands::remote::remote_rename,
            commands::remote::remote_delete,
            commands::remote::transfer_start,
            commands::remote::transfer_answer,
            commands::meta::list_schemas,
            commands::meta::list_tables,
            commands::meta::list_columns,
            commands::meta::list_indexes,
            commands::meta::schema_snapshot,
            commands::exec::execute,
            commands::exec::count_rows,
            commands::exec::cancel_query,
            commands::exec::set_tx_mode,
            commands::exec::tx_action,
            commands::ddl::table_structure,
            commands::ddl::preview_ddl,
            commands::ddl::preview_drop,
            commands::ddl::apply_ddl,
            commands::ddl::ddl_choices,
            commands::edit::submit_changes,
            commands::edit::preview_changes,
            commands::edit::submit_sql,
            commands::edit::read_blob,
            commands::edit::write_blob,
            commands::redis::redis_dbs,
            commands::redis::redis_scan,
            commands::redis::redis_delete_key,
            commands::redis::redis_key_info,
            commands::redis::redis_read,
            commands::redis::redis_exec,
            commands::redis::redis_close_console,
            commands::redis::redis_submit,
            commands::mongo::mongo_dbs,
            commands::mongo::mongo_collections,
            commands::mongo::mongo_indexes,
            commands::mongo::mongo_find,
            commands::mongo::mongo_count,
            commands::mongo::mongo_exec,
            commands::mongo::mongo_submit,
            commands::mongo::mongo_export,
            commands::export::export_csv,
            commands::files::load_console,
            commands::files::save_console,
            commands::files::delete_console,
            commands::files::load_workspace,
            commands::files::save_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
