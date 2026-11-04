mod adapters;
mod argocd;
mod argocd_commands;
mod argowf;
mod argowf_commands;
mod argowf_manifest_commands;
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
mod k8s_access_commands;
mod k8s_commands;
mod k8s_network_commands;
mod k8s_describe_commands;
mod k8s_helm_commands;
mod k8s_security_commands;
mod model;
mod mouse_nav;
mod pg;
mod pg_commands;
mod resource_index;
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
            let dir = app.path().app_data_dir()?;
            app.manage(AppState {
                ctx: aws::context::AwsContext::default(),
                adapters: adapters::registry(),
                settings_path: dir.join("settings.json"),
                sso: Default::default(),
            });
            app.manage(explorer_commands::ExplorerState::default());
            app.manage(iam_commands::IamState::new(dir.join("iam-changes.jsonl")));
            app.manage(k8s_commands::K8sState::new(dir.join("k8s-changes.jsonl")));
            app.manage(k8s_access_commands::AccessState::default());
            app.manage(argocd::ArgocdState::default());
            app.manage(argowf::client::State::new(dir.join("settings.json")));
            app.manage(pg_commands::PgState::new(dir.join("db-changes.jsonl")));
            app.manage(cost_commands::CostState::new(dir.join("cost-cache.json")));
            app.manage(resource_index::ResourceIndexState::new(dir.join("resource-index.json")));
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
            commands::resource_index,
            commands::clear_resource_index,
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
            k8s_access_commands::k8s_access,
            k8s_access_commands::k8s_access_matrix,
            k8s_access_commands::k8s_access_cell,
            k8s_access_commands::k8s_who_can,
            k8s_access_commands::k8s_review,
            k8s_access_commands::k8s_workload_identity,
            k8s_commands::k8s_context,
            k8s_commands::k8s_open,
            k8s_commands::k8s_close,
            k8s_commands::k8s_rules,
            k8s_commands::k8s_watch,
            k8s_commands::k8s_unwatch,
            k8s_commands::k8s_kinds,
            k8s_commands::k8s_get,
            k8s_describe_commands::k8s_describe,
            k8s_commands::k8s_metrics,
            k8s_commands::k8s_overview,
            k8s_commands::k8s_secret_value,
            k8s_commands::k8s_logs,
            k8s_commands::k8s_workload_logs,
            k8s_commands::k8s_logs_save,
            k8s_commands::k8s_shell_open,
            k8s_commands::k8s_shell_confirm_name,
            k8s_commands::k8s_node_shell_open,
            k8s_commands::k8s_attach_open,
            k8s_commands::k8s_shell_input,
            k8s_commands::k8s_shell_resize,
            k8s_commands::k8s_shell_close,
            k8s_commands::k8s_forward_open,
            k8s_commands::k8s_forward_list,
            k8s_commands::k8s_forward_close,
            k8s_commands::k8s_revisions,
            k8s_commands::k8s_preview,
            k8s_commands::k8s_apply,
            k8s_commands::k8s_drain,
            k8s_commands::k8s_change_log,
            k8s_commands::k8s_undo,
            k8s_network_commands::k8s_network,
            k8s_security_commands::k8s_findings,
            k8s_helm_commands::k8s_helm_tool,
            k8s_helm_commands::k8s_helm_releases,
            k8s_helm_commands::k8s_helm_release,
            k8s_helm_commands::k8s_helm_show_values,
            k8s_commands::rbac::k8s_preview_batch,
            k8s_commands::rbac::k8s_apply_batch,
            argocd_commands::argocd_set_token,
            argocd_commands::argocd_forget_token,
            argocd_commands::argocd_session,
            argocd_commands::argocd_apps,
            argocd_commands::argocd_appsets,
            argocd_commands::argocd_app,
            argocd_commands::argocd_tree,
            argocd_commands::argocd_refresh,
            argocd_commands::argocd_sync,
            argowf_commands::argowf_contexts,
            argowf_commands::argowf_set_token,
            argowf_commands::argowf_forget_token,
            argowf_commands::argowf_session,
            argowf_commands::argowf_info,
            argowf_commands::argowf_userinfo,
            argowf_commands::argowf_copy_token,
            argowf_commands::argowf_watch,
            argowf_commands::argowf_watch_workflow,
            argowf_commands::argowf_watch_stop,
            argowf_commands::argowf_plugins,
            argowf_commands::argowf_save_text,
            argowf_commands::argowf_artifact_preview,
            argowf_commands::argowf_save_artifact,
            argowf_commands::argowf_resource_logs,
            argowf_commands::argowf_batch_action,
            argowf_commands::argowf_workflows,
            argowf_commands::argowf_archived,
            argowf_commands::argowf_workflow,
            argowf_commands::argowf_archived_workflow,
            argowf_commands::argowf_role_arn,
            argowf_commands::argowf_events,
            argowf_commands::argowf_logs,
            argowf_commands::argowf_logs_stop,
            argowf_commands::argowf_crons,
            argowf_commands::argowf_cron,
            argowf_commands::argowf_templates,
            argowf_commands::argowf_template,
            argowf_commands::argowf_workflow_action,
            argowf_commands::argowf_archived_action,
            argowf_commands::argowf_cron_action,
            argowf_commands::argowf_submit_template,
            argowf_manifest_commands::argowf_manifest,
            argowf_manifest_commands::argowf_lint,
            argowf_manifest_commands::argowf_create,
            argowf_manifest_commands::argowf_update,
            argowf_manifest_commands::argowf_delete,
            argowf_manifest_commands::argowf_event_bindings,
            argowf_manifest_commands::argowf_event_sources,
            argowf_manifest_commands::argowf_sensors,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 앱을 끄면 열린 셸과 port-forward를 닫는다
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(app.state::<k8s_commands::K8sState>().close_streams());
            }
        });
}
