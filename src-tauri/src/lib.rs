mod adapters;
mod aws;
mod commands;
mod error;
mod explorer;
mod explorer_commands;
mod iam;
mod iam_commands;
mod model;
mod mouse_nav;
mod settings;
mod topology;
mod topology_commands;

use tauri::Manager;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(AppState {
                ctx: aws::context::AwsContext::default(),
                adapters: adapters::registry(),
                settings_path: dir.join("settings.json"),
            });
            app.manage(explorer_commands::ExplorerState::default());
            app.manage(iam_commands::IamState::default());
            std::thread::spawn(explorer::external::sweep_stale);
            mouse_nav::install(app.handle().clone());
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
            topology_commands::vpc_topology,
            topology_commands::save_png,
            iam_commands::iam_overview,
            iam_commands::iam_principal,
            iam_commands::iam_principal_actions,
            iam_commands::iam_policy,
            iam_commands::iam_actions,
            iam_commands::iam_who_can,
            iam_commands::iam_simulate,
            iam_commands::iam_findings,
            iam_commands::iam_access_keys,
            iam_commands::iam_last_accessed,
            iam_commands::iam_list_policies,
            iam_commands::iam_validate_policy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
