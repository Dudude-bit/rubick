//! Main entry point for K8s GUI application

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use k8s_gui_common::init_tracing;
use k8s_gui_lib::{commands, integrations, shell, state::AppState};
use tauri::{Emitter, Manager};

fn main() {
    // Install rustls crypto provider before any TLS operations
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    // Initialize tracing
    init_tracing();

    tracing::info!("Starting K8s GUI application");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Initialize user PATH for shell commands
            tauri::async_runtime::block_on(async {
                shell::init_user_path().await;
            });
            tracing::info!("User PATH initialized");

            // Initialize application state
            let state = AppState::new()?;

            // Subscribe to events and forward to frontend.
            //
            // The per-variant `event.channel()` and `event.payload()` are
            // defined alongside the `AppEvent` enum in `state::events`.
            // Inlining the routing here previously diverged from the enum
            // — a new `AuthTerminalSessionCreated` variant got an
            // `event_name` mapping but no explicit payload, falling
            // through to a `serde_json::to_value(&event)` default that
            // wrapped the data under `{ "type": ..., "data": {...} }` and
            // silently broke the frontend modal (v2.1.0 bug).
            let mut event_rx = state.subscribe();
            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                while let Ok(event) = event_rx.recv().await {
                    let event_name = event.channel();
                    let payload = event.payload();

                    if let Err(e) = app_handle.emit(event_name, payload) {
                        tracing::error!("Failed to emit event {}: {}", event_name, e);
                    }
                }
            });

            app.manage(state);

            tracing::info!("Application state initialized");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Cluster management
            commands::cluster::list_contexts,
            commands::cluster::get_current_context,
            commands::cluster::switch_context,
            commands::cluster::connect_cluster,
            commands::cluster::disconnect_cluster,
            commands::cluster::get_cluster_info,
            commands::cluster::get_kubeconfig_source,
            commands::binaries::locate_binaries,
            // Namespace management
            commands::namespace::list_namespaces,
            // Generic resource management
            commands::resources::list_resources,
            // Cross-cluster search
            commands::search::start_resource_search,
            commands::search::resource_search_subscribed,
            commands::search::cancel_resource_search,
            // CRD commands
            commands::crds::list_crds,
            commands::crds::get_crd,
            commands::crds::get_crd_yaml,
            commands::crds::delete_crd,
            commands::crds::get_crd_schema,
            commands::crds::list_custom_resources,
            commands::crds::get_custom_resource,
            commands::crds::get_custom_resource_yaml,
            commands::crds::delete_custom_resource,
            // Pod commands
            commands::pods::list_pods,
            commands::pods::get_pod,
            commands::pods::delete_pod,
            commands::pods::restart_pod,
            // Debug commands
            commands::debug::debug_pod_ephemeral,
            commands::debug::debug_pod_copy,
            commands::debug::debug_node,
            commands::debug::delete_debug_pod,
            commands::debug::list_debug_pods,
            commands::debug::get_debug_status,
            commands::debug::cancel_debug_operation,
            commands::debug::extend_debug_timeout,
            // Deployment commands
            commands::deployments::list_deployments,
            commands::deployments::get_deployment,
            commands::deployments::delete_deployment,
            commands::deployments::scale_deployment,
            commands::deployments::restart_deployment,
            commands::deployments::update_deployment_image,
            commands::deployments::get_deployment_pods,
            commands::deployments::get_rollout_status,
            // ReplicaSet commands — a detail page and a Deployment's
            // revisions; deliberately no list, there is no list page.
            commands::replicasets::get_replicaset,
            commands::replicasets::get_replicaset_pods,
            commands::replicasets::get_deployment_replicasets,
            // Service commands
            commands::services::list_services,
            commands::services::get_service,
            commands::services::delete_service,
            // Port-forward commands
            commands::port_forward::port_forward_pod,
            commands::port_forward::stop_port_forward,
            commands::port_forward::list_port_forwards,
            commands::port_forward::list_port_forward_configs,
            commands::port_forward::create_port_forward_config,
            commands::port_forward::update_port_forward_config,
            commands::port_forward::delete_port_forward_config,
            // ConfigMap commands
            commands::config_resources::list_configmaps,
            commands::config_resources::get_configmap,
            commands::config_resources::get_configmap_data,
            commands::config_resources::delete_configmap,
            // Secret commands
            commands::config_resources::list_secrets,
            commands::config_resources::get_secret,
            commands::config_resources::get_secret_data,
            commands::config_resources::get_secret_yaml,
            commands::config_resources::delete_secret,
            // TLS certificates — core, and readable without cert-manager
            commands::certificates::get_tls_certificates,
            // In-cluster extensions: detected, never configured
            integrations::detect_in_cluster_extensions,
            integrations::cert_manager::get_certificate_issuance,
            // Configured extensions: an address per cluster, and the
            // credential stays on this side of the boundary
            integrations::prometheus::get_prometheus_connection,
            integrations::prometheus::save_prometheus_connection,
            integrations::prometheus::forget_prometheus_connection,
            integrations::prometheus::probe_prometheus,
            integrations::prometheus::prometheus_query,
            integrations::prometheus::prometheus_query_range,
            integrations::loki::get_loki_connection,
            integrations::loki::save_loki_connection,
            integrations::loki::forget_loki_connection,
            integrations::loki::probe_loki,
            integrations::loki::loki_query_range,
            // Resource references command
            commands::config_resources::get_resource_references,
            commands::connections::get_resource_connections,
            // Node commands
            commands::nodes::list_nodes,
            commands::nodes::get_node,
            commands::nodes::cordon_node,
            commands::nodes::uncordon_node,
            commands::nodes::drain_node,
            // Event commands
            commands::events::list_events,
            // Log commands
            commands::logs::get_pod_logs,
            commands::logs::stop_log_stream,
            commands::logs::stream_pod_logs,
            commands::logs::log_stream_subscribed,
            // Terminal/Exec commands
            commands::terminal::terminal_input,
            commands::terminal::terminal_resize,
            commands::terminal::close_terminal,
            commands::terminal::terminal_subscribed,
            commands::terminal::open_pod_shell,
            commands::terminal::open_process_shell,
            // Resource watch (replaces 2s polling for migrated lists)
            commands::watch::subscribe_configmap_watch,
            commands::watch::subscribe_secret_watch,
            commands::watch::subscribe_service_watch,
            commands::watch::subscribe_endpoints_watch,
            commands::watch::subscribe_ingress_watch,
            commands::watch::subscribe_pvc_watch,
            commands::watch::subscribe_pod_watch,
            commands::watch::subscribe_deployment_watch,
            commands::watch::subscribe_statefulset_watch,
            commands::watch::subscribe_daemonset_watch,
            commands::watch::subscribe_job_watch,
            commands::watch::subscribe_cronjob_watch,
            commands::watch::subscribe_namespace_watch,
            commands::watch::subscribe_node_watch,
            commands::watch::subscribe_persistentvolume_watch,
            commands::watch::subscribe_storageclass_watch,
            commands::watch::subscribe_custom_resource_watch,
            commands::watch::resource_watch_subscribed,
            commands::watch::unsubscribe_resource_watch,
            // kubectl commands
            commands::kubectl::check_kubectl_availability,
            commands::debug_kubectl_plugins,
            // Helm commands (native + CLI)
            commands::helm::check_helm_availability,
            commands::helm::list_helm_releases_native,
            commands::helm::get_helm_release_detail,
            commands::helm::get_helm_history,
            commands::helm::helm_rollback,
            commands::helm::helm_uninstall,
            commands::helm::list_helm_repos,
            commands::helm::add_helm_repo,
            commands::helm::remove_helm_repo,
            commands::helm::update_helm_repos,
            commands::helm::helm_search_charts,
            commands::helm::helm_install,
            commands::helm::helm_upgrade,
            // Settings commands
            commands::settings::get_app_info,
            // GCP profiles
            commands::settings::list_gcp_profiles,
            commands::settings::get_gcp_profile,
            commands::settings::save_gcp_profile,
            commands::settings::delete_gcp_profile,
            commands::settings::test_gcp_profile,
            // Azure profiles
            commands::settings::list_azure_profiles,
            commands::settings::get_azure_profile,
            commands::settings::save_azure_profile,
            commands::settings::delete_azure_profile,
            commands::settings::test_azure_profile,
            // Context bindings
            commands::settings::list_context_bindings,
            commands::settings::get_context_binding,
            commands::settings::save_context_binding,
            commands::settings::delete_context_binding,
            // CLI paths
            commands::settings::get_cli_paths,
            commands::settings::save_cli_paths,
            // Kubeconfig override
            commands::settings::get_kubeconfig_path,
            commands::settings::set_kubeconfig_path,
            commands::settings::clear_kubeconfig_path,
            // Registry configurations
            commands::settings::list_registry_configs,
            commands::settings::save_registry_config,
            commands::settings::delete_registry_config,
            // Theme configuration
            commands::settings::get_theme_config,
            commands::settings::save_theme_config,
            // YAML editor history
            commands::settings::get_yaml_history,
            commands::settings::add_yaml_history_entry,
            commands::settings::get_all_yaml_history,
            // Infrastructure builder state
            commands::settings::get_infrastructure_state,
            commands::settings::save_infrastructure_state,
            commands::settings::clear_infrastructure_state,
            // Recent items
            commands::settings::get_recent_items,
            commands::settings::add_recent_item,
            // Updater settings
            commands::settings::get_updater_settings,
            commands::settings::save_updater_settings,
            // Cluster preferences
            commands::settings::get_cluster_preferences,
            commands::settings::save_cluster_preferences,
            // Registry commands
            commands::registry::set_registry_credentials,
            commands::registry::delete_registry_credentials,
            commands::registry::get_registry_auth_status,
            commands::registry::import_docker_config,
            commands::registry::search_registry_images,
            // Authentication commands
            commands::auth::cancel_auth_session,
            // Storage commands
            commands::storage::list_persistent_volumes,
            commands::storage::get_persistent_volume,
            commands::storage::delete_persistent_volume,
            commands::storage::list_persistent_volume_claims,
            commands::storage::get_persistent_volume_claim,
            commands::storage::delete_persistent_volume_claim,
            commands::storage::list_storage_classes,
            commands::storage::get_storage_class,
            commands::storage::delete_storage_class,
            // Network commands
            commands::network::list_ingresses,
            commands::network::get_ingress,
            commands::network::resolve_ingress_class,
            commands::network::delete_ingress,
            commands::network::list_endpoints,
            commands::network::list_service_endpoints,
            commands::network::get_endpoints,
            commands::network::delete_endpoints,
            // Stats commands
            commands::stats::get_cluster_stats,
            commands::overview::get_cluster_overview,
            // Metrics API
            commands::metrics::get_pods_metrics,
            commands::metrics::get_nodes_metrics,
            commands::metrics::get_cluster_metrics,
            // Workloads commands
            commands::workloads::list_statefulsets,
            commands::workloads::get_statefulset,
            commands::workloads::get_statefulset_yaml,
            commands::workloads::delete_statefulset,
            commands::workloads::list_daemonsets,
            commands::workloads::get_daemonset,
            commands::workloads::get_daemonset_yaml,
            commands::workloads::delete_daemonset,
            commands::workloads::list_jobs,
            commands::workloads::get_job,
            commands::workloads::get_job_yaml,
            commands::workloads::delete_job,
            commands::workloads::list_cronjobs,
            commands::workloads::get_cronjob,
            commands::workloads::get_cronjob_yaml,
            commands::workloads::delete_cronjob,
            // Manifest commands
            commands::manifest::validate_manifest,
            commands::manifest::apply_manifest,
            commands::manifest::delete_manifest,
            commands::manifest::get_manifest,
            // Logging commands
            commands::logging::log_frontend_event,
            commands::logging::log_frontend_events_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
