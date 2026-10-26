mod adapters;
mod aws;
mod commands;
mod error;
mod explorer;
mod explorer_commands;
mod model;
mod settings;

use tauri::Manager;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(AppState {
                ctx: aws::context::AwsContext::default(),
                adapters: adapters::registry(),
                settings_path: dir.join("settings.json"),
            });
            app.manage(explorer_commands::ExplorerState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::get_account,
            commands::list_services,
            commands::list_resources,
            commands::sso_login,
            commands::get_settings,
            commands::save_settings,
            commands::list_s3_objects,
            explorer_commands::local_home,
            explorer_commands::local_list,
            explorer_commands::plan_upload,
            explorer_commands::plan_download,
            explorer_commands::find_conflicts,
            explorer_commands::start_transfers,
            explorer_commands::s3_create_folder,
            explorer_commands::s3_rename,
            explorer_commands::s3_count_under,
            explorer_commands::s3_delete,
            explorer_commands::diff_files,
            explorer_commands::open_external_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
