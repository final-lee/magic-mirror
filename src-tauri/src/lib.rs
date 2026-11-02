mod adapters;
mod aws;
mod commands;
mod cost;
mod cost_commands;
mod error;
mod explorer;
mod explorer_commands;
mod iam;
mod iam_commands;
mod jsonl;
pub mod k8s;
mod k8s_commands;
mod model;
mod mouse_nav;
mod pg;
mod pg_commands;
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
            k8s::tls::install_crypto_provider();
            // 끝난 앱이 남긴 로그 임시 폴더(EKS 로그 탭의 lnav용)를 지운다
            std::thread::spawn(|| k8s::lnav::sweep_stale(&k8s::lnav::logs_root()));
            let dir = app.path().app_data_dir()?;
            app.manage(AppState {
                ctx: aws::context::AwsContext::default(),
                adapters: adapters::registry(),
                settings_path: dir.join("settings.json"),
                sso: Default::default(),
            });
            app.manage(explorer_commands::ExplorerState::default());
            app.manage(iam_commands::IamState::new(dir.join("iam-changes.jsonl")));
            app.manage(k8s_commands::K8sState::default());
            app.manage(pg_commands::PgState::new(dir.join("db-changes.jsonl")));
            app.manage(cost_commands::CostState::new(dir.join("cost-cache.json")));
            pg_commands::spawn_sweeper(app.handle().clone());
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
            commands::sso_login_cancel,
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
            iam_commands::iam_preview,
            iam_commands::iam_apply,
            iam_commands::iam_change_log,
            iam_commands::iam_undo_change,
            iam_commands::iam_preview_batch,
            iam_commands::iam_apply_batch,
            iam_commands::iam_undo_batch,
            cost_commands::cost_overview,
            cost_commands::cost_breakdown,
            cost_commands::cost_tag_keys,
            cost_commands::cost_usage,
            pg_commands::pg_target,
            pg_commands::pg_open,
            pg_commands::pg_database,
            pg_commands::pg_cell,
            pg_commands::pg_objects,
            pg_commands::pg_role,
            pg_commands::pg_who_can,
            pg_commands::pg_sessions,
            pg_commands::pg_findings,
            pg_commands::pg_close,
            pg_commands::pg_overview,
            pg_commands::pg_preview,
            pg_commands::pg_apply,
            pg_commands::pg_preview_batch,
            pg_commands::pg_apply_batch,
            pg_commands::pg_change_log,
            pg_commands::pg_undo,
            pg_commands::pg_undo_batch,
            pg_commands::pg_preset,
            pg_commands::pg_drop_plan,
            pg_commands::pg_apply_drop,
            k8s_commands::k8s_context,
            k8s_commands::k8s_open,
            k8s_commands::k8s_close,
            k8s_commands::k8s_rules,
            k8s_commands::k8s_watch,
            k8s_commands::k8s_unwatch,
            k8s_commands::k8s_kinds,
            k8s_commands::k8s_get,
            k8s_commands::k8s_overview,
            k8s_commands::k8s_secret_value,
            k8s_commands::k8s_logs,
            k8s_commands::k8s_lnav_available,
            k8s_commands::k8s_lnav,
            k8s_commands::k8s_lnav_input,
            k8s_commands::k8s_lnav_resize,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // 종료는 비동기 작업을 버리지 않고 프로세스를 끝내므로, 떠 있는 lnav와 로그 임시 파일은 여기서 직접 정리한다
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(k8s) = app.try_state::<k8s_commands::K8sState>() {
                    k8s.shutdown();
                }
            }
        });
}
