//! Main entry point for the Rubick application

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use k8s_gui_common::{init_tracing, log_dir};
use k8s_gui_lib::{commands, integrations, shell, state::AppState, BUNDLE};
use tauri::{Emitter, Manager};
use tokio::sync::broadcast;

/// Whether this build registers `rubick://` itself at startup.
///
/// Not inside a Flatpak: the exported .desktop file declares
/// `MimeType=x-scheme-handler/rubick`, which is the installer's registration,
/// and the sandbox has no `xdg-mime` to run — asking only put an error and a
/// warning at the top of every log a Flatpak user pastes.
#[cfg(any(windows, target_os = "linux", test))]
fn registers_its_own_scheme(flatpak_id: Option<&std::ffi::OsStr>) -> bool {
    flatpak_id.is_none()
}

fn main() {
    let started = std::time::Instant::now();

    // Install rustls crypto provider before any TLS operations
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    // First: it writes the environment, which nothing else may be reading
    // yet, and tracing below reads `RUST_LOG` from what the profile set.
    //
    // On stderr rather than through tracing, because tracing is what this
    // runs before. Sourcing a profile can block — a `kinit`, a `gcloud auth`
    // refresh, `mise` fetching a toolchain — and the wait is up to the
    // timeout with no window on screen. Without this line a hang produced no
    // evidence at all, not even under `RUST_LOG=trace`, because the
    // subscriber that would carry it does not exist yet.
    // Unix only, because that is where the wait exists: on Windows a GUI
    // app already has the user's environment and the import returns at once.
    #[cfg(unix)]
    eprintln!(
        "rubick: asking the login shell for its environment (up to {}s)",
        shell::SHELL_ENV_TIMEOUT.as_secs()
    );
    let shell_started = std::time::Instant::now();
    let shell_env = shell::import_login_shell_env();
    let shell_env_ms = shell_started.elapsed().as_millis();

    // Initialize tracing. The file is what a reader can hand over: a
    // packaged Windows build is a GUI-subsystem binary with no console, so
    // stderr reaches nobody, and every question about what the app did has
    // had to be answered by guessing.
    init_tracing(log_dir(BUNDLE).as_deref());

    tracing::info!("Starting Rubick application");
    match k8s_gui_common::log_path() {
        Some(file) => tracing::info!(path = %file.display(), "writing this run's log"),
        None => tracing::warn!("no log file this run; this run leaves nothing to send"),
    }
    tracing::info!(?shell_env, shell_env_ms, "login shell environment");
    tracing::info!(
        since_start_ms = started.elapsed().as_millis(),
        "building the window"
    );

    tauri::Builder::default()
        // Registered first: a second launch (a `rubick://` link opened while
        // the app runs) hands its arguments to this instance and exits, and
        // the deep-link plugin below turns them into an `open-url` event.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            tracing::info!(since_start_ms = started.elapsed().as_millis(), "setting up");
            // A packaged build registers `rubick://` through its installer
            // (Info.plist, the Windows registry, the .desktop file); a dev
            // build has no installer, so it registers itself on the platforms
            // that allow it at runtime.
            #[cfg(any(windows, target_os = "linux"))]
            if registers_its_own_scheme(std::env::var_os("FLATPAK_ID").as_deref()) {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(error) = app.deep_link().register_all() {
                    tracing::warn!(%error, "could not register the rubick:// scheme");
                }
            }

            // Initialize application state
            let state = AppState::new()?;
            tracing::info!(
                since_start_ms = started.elapsed().as_millis(),
                "application state built"
            );

            // Subscribe to events and forward to frontend.
            //
            // `event.channel()` and `event.to_json()` live beside `AppEvent`
            // in `state::events`; each event is serialised once, here.
            let mut event_rx = state.subscribe();
            let app_handle = app.handle().clone();
            let perf = state.perf.clone();

            // Lagging is survivable; this loop treating it as the end was not.
            //
            // `recv()` returns `Lagged(n)` when this consumer falls behind the
            // 1000-slot buffer — the n oldest events are gone, and the next
            // `recv()` works normally. `while let Ok(..)` exited on it, and
            // this is the *only* bridge to the frontend: one burst over the
            // buffer and the window loses watch events, log lines, terminal
            // output and port-forward status for the rest of the process, with
            // no error anywhere, because the watcher's own "I failed, start
            // polling" event travels the same dead channel. A cluster-wide pod
            // watch resyncing on a large cluster is exactly that burst.
            //
            tauri::async_runtime::spawn(async move {
                loop {
                    let event = match event_rx.recv().await {
                        Ok(event) => event,
                        Err(broadcast::error::RecvError::Lagged(missed)) => {
                            tracing::warn!("Event bridge fell behind; {missed} events dropped.");
                            // Surviving the lag is half of it. What was dropped
                            // is gone, and for a watch that means the list on
                            // screen is not stale but *short* — a resync clears
                            // the cache and refills from a burst, so N missing
                            // `applied` events are N rows that never come back.
                            // Nothing polls them back either, because a watched
                            // list is on `refresh: false`. So the frontend is
                            // told, and it treats this exactly as a watch
                            // failure: drop the "live" badge, resume polling.
                            let lagged = k8s_gui_lib::state::AppEvent::EventBridgeLagged { missed };
                            if let Ok(payload) = lagged.to_json() {
                                let _ = app_handle.emit_str(lagged.channel(), payload);
                            }
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    };

                    let event_name = event.channel();
                    let payload = match event.to_json() {
                        Ok(payload) => payload,
                        Err(e) => {
                            tracing::error!("Failed to serialise event {event_name}: {e}");
                            continue;
                        }
                    };

                    if perf.is_recording() {
                        let changes = match &event {
                            k8s_gui_lib::state::AppEvent::ResourceWatchEvent {
                                changes, ..
                            } => changes.len(),
                            _ => 0,
                        };
                        perf.observe(payload.len(), changes);
                    }

                    if let Err(e) = app_handle.emit_str(event_name, payload) {
                        tracing::error!("Failed to emit event {}: {}", event_name, e);
                    }
                }
            });

            app.manage(state);

            tracing::info!(
                since_start_ms = started.elapsed().as_millis(),
                "Application state initialized"
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Cluster management
            commands::cluster::list_contexts,
            commands::cluster::get_current_context,
            commands::cluster::connect_cluster,
            commands::cluster::disconnect_cluster,
            commands::cluster::get_cluster_info,
            commands::cluster::connection_attempt,
            commands::cluster::credential_renewal,
            commands::cluster::get_kubeconfig_source,
            commands::access::check_list_access,
            commands::access::check_access,
            commands::access::check_crd_read_access,
            commands::access::check_namespace_access,
            commands::binaries::locate_binaries,
            commands::diagnostics::collect_diagnostics,
            commands::app_events::app_event_types,
            commands::perf::perf_set_recording,
            commands::perf::perf_counters,
            // Namespace management
            commands::namespace::list_namespaces,
            commands::namespace::get_namespace,
            // Cross-cluster search
            commands::search::start_resource_search,
            commands::search::resource_search_subscribed,
            commands::search::cancel_resource_search,
            // CRD commands
            commands::crds::list_crds,
            commands::crds::get_crd,
            commands::crds::get_crd_yaml,
            commands::crds::delete_crd,
            commands::crds::list_custom_resources,
            commands::crds::get_custom_resource,
            commands::crds::get_custom_resource_yaml,
            commands::crds::delete_custom_resource,
            commands::crds::patch_custom_resource,
            commands::crds::patch_custom_resource_json,
            // Pod commands
            commands::pods::list_pods,
            commands::pods::list_pod_rows,
            commands::pods::pod_rows_subscribed,
            commands::pods::stop_pod_rows,
            commands::pods::get_pod,
            commands::pods::delete_pod,
            commands::pods::restart_pod,
            // Checks: a hypothesis tested from the pod
            commands::checks::run_pod_check,
            // Debug commands
            commands::debug::debug_pod_ephemeral,
            commands::debug::debug_pod_copy,
            commands::debug::debug_node,
            commands::debug::delete_debug_pod,
            commands::debug::get_debug_status,
            commands::debug::cancel_debug_operation,
            commands::debug::extend_debug_timeout,
            // Deployment commands
            commands::deployments::list_deployments,
            commands::deployments::get_deployment,
            commands::deployments::delete_deployment,
            commands::deployments::scale_deployment,
            commands::deployments::restart_deployment,
            commands::workloads::restart_statefulset,
            commands::workloads::restart_daemonset,
            commands::deployments::update_deployment_image,
            commands::deployments::get_deployment_pods,
            commands::deployments::get_rollout_status,
            // ReplicaSet commands — a detail page and a Deployment's
            // revisions; deliberately no list, there is no list page.
            commands::replicasets::get_replicaset,
            commands::replicasets::get_replicaset_pods,
            commands::replicasets::get_deployment_replicasets,
            commands::revisions::get_controller_revisions,
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
            commands::config_resources::set_configmap_key,
            // Secret commands
            commands::config_resources::list_secrets,
            commands::config_resources::get_secret,
            commands::config_resources::get_secret_data,
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
            integrations::prometheus::prometheus_targets,
            integrations::prometheus::prometheus_rules,
            integrations::loki::get_loki_connection,
            integrations::loki::save_loki_connection,
            integrations::loki::forget_loki_connection,
            integrations::loki::probe_loki,
            integrations::loki::loki_query_range,
            // Resource references command
            commands::connections::get_resource_connections,
            // Node commands
            commands::nodes::list_nodes,
            commands::nodes::get_node,
            commands::nodes::node_resource_budget,
            commands::nodes::cordon_node,
            commands::nodes::uncordon_node,
            commands::nodes::start_node_drain,
            commands::nodes::node_drain_subscribed,
            commands::nodes::cancel_node_drain,
            // Event commands
            commands::events::list_events,
            // Log commands
            commands::logs::get_pod_logs,
            commands::logs::save_pod_log,
            commands::logs::stop_log_stream,
            commands::logs::stream_pod_logs,
            commands::logs::log_stream_subscribed,
            commands::files::list_container_files,
            commands::files::files_subscribed,
            commands::files::stop_files_listing,
            commands::files::read_container_file,
            commands::files::download_container_file,
            commands::files::write_text_file,
            commands::sharing::list_share_targets,
            commands::sharing::save_share_target,
            commands::sharing::remove_share_target,
            commands::sharing::verify_share_target,
            commands::sharing::publish_report,
            commands::sharing::import_postplan_key,
            // Terminal/Exec commands
            commands::terminal::terminal_input,
            commands::terminal::terminal_resize,
            commands::terminal::close_terminal,
            commands::terminal::terminal_subscribed,
            commands::terminal::open_pod_shell,
            // Resource watch (replaces 2s polling for migrated lists)
            commands::watch::subscribe_configmap_watch,
            commands::watch::subscribe_secret_watch,
            commands::watch::subscribe_service_watch,
            commands::watch::subscribe_endpoints_watch,
            commands::watch::subscribe_ingress_watch,
            commands::watch::subscribe_gateway_watch,
            commands::watch::subscribe_gateway_route_watch,
            commands::watch::subscribe_pvc_watch,
            commands::watch::subscribe_pod_row_watch,
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
            commands::watch::subscribe_object_watch,
            commands::watch::subscribe_custom_object_watch,
            commands::watch::resource_watch_subscribed,
            commands::watch::unsubscribe_resource_watch,
            // kubectl commands
            commands::kubectl::check_kubectl_availability,
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
            commands::settings::save_gcp_profile,
            commands::settings::delete_gcp_profile,
            commands::settings::test_gcp_profile,
            // Azure profiles
            commands::settings::list_azure_profiles,
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
            commands::settings::set_kubeconfig_paths,
            commands::settings::get_kubeconfig_paths,
            commands::settings::clear_kubeconfig_path,
            // Theme configuration
            commands::settings::get_theme_config,
            commands::settings::save_theme_config,
            // YAML editor history
            commands::settings::get_yaml_history,
            commands::settings::add_yaml_history_entry,
            // Recent items
            commands::settings::get_recent_items,
            commands::settings::add_recent_item,
            // Updater settings
            commands::settings::get_updater_settings,
            commands::settings::save_updater_settings,
            commands::settings::updater_can_install,
            // Cluster preferences
            commands::settings::get_cluster_preferences,
            commands::settings::save_cluster_preferences,
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
            commands::network::list_network_policies,
            commands::network::get_network_policy,
            commands::network::delete_network_policy,
            commands::network::get_ingress,
            commands::network::resolve_ingress_class,
            commands::network::delete_ingress,
            commands::network::list_endpoints,
            commands::network::list_service_endpoints,
            commands::network::list_service_backing,
            commands::network::get_endpoints,
            commands::network::delete_endpoints,
            // Gateway API commands
            commands::gateway::detect_gateway_api,
            commands::gateway::list_gateway_classes,
            commands::gateway::get_gateway_class,
            commands::gateway::delete_gateway_class,
            commands::gateway::list_gateways,
            commands::gateway::get_gateway,
            commands::gateway::delete_gateway,
            commands::gateway::list_gateway_routes,
            commands::gateway::get_gateway_route,
            commands::gateway::delete_gateway_route,
            commands::gateway::list_backend_tls_policies,
            commands::gateway::probe_resolve_host,
            commands::gateway::probe_tcp_connect,
            // Stats commands
            commands::overview::get_cluster_overview,
            // Metrics API
            commands::metrics::get_pods_metrics,
            commands::metrics::get_nodes_metrics,
            // Workloads commands
            commands::workloads::list_statefulsets,
            commands::workloads::get_statefulset,
            commands::workloads::scale_statefulset,
            commands::workloads::delete_statefulset,
            commands::workloads::list_daemonsets,
            commands::workloads::get_daemonset,
            commands::workloads::delete_daemonset,
            commands::workloads::list_jobs,
            commands::workloads::get_job,
            commands::workloads::delete_job,
            commands::workloads::list_cronjobs,
            commands::workloads::get_cronjob,
            commands::workloads::delete_cronjob,
            commands::workloads::trigger_cronjob,
            // Manifest commands
            commands::manifest::validate_manifest,
            commands::manifest::apply_manifest,
            commands::manifest::dry_run_manifest,
            commands::manifest::get_manifest,
            commands::manifest::get_object_metadata,
            // Logging commands
            commands::logging::log_frontend_events_batch,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // On the way out, kill any kubectl proxy — Drop does not run when the
        // macOS loop ends the process, and an unauthenticated loopback proxy
        // must not outlive the window.
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                app_handle
                    .state::<AppState>()
                    .client_manager
                    .shutdown_proxies();
            }
        });
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;

    /// A capability's `remote` block hands its permissions to any page on
    /// those URLs. Ours said `https://*`, so a page the window was taken to
    /// could read the clipboard, open programs and emit the app's events;
    /// and every command's scope was resolved against those patterns at
    /// startup, a quarter of a second. Logins open in the browser, so no
    /// remote page here needs IPC, and `auth-*` named a window that never
    /// existed.
    #[test]
    fn no_capability_reaches_a_remote_page_or_a_window_we_do_not_open() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut read = 0;
        for entry in fs::read_dir(&dir).expect("the capabilities folder") {
            let path = entry.expect("an entry").path();
            let json: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).expect("read a capability"))
                    .expect("a capability is JSON");
            assert!(
                json.get("remote").is_none(),
                "{} grants remote pages IPC",
                path.display()
            );
            assert_eq!(
                json["windows"],
                serde_json::json!(["main"]),
                "{} names a window the app does not open",
                path.display()
            );
            read += 1;
        }
        assert!(read > 0, "no capability was read");
    }

    /// A Flatpak's exported .desktop file is its registration of `rubick://`,
    /// and the sandbox has no `xdg-mime`: registering from inside put an
    /// error and a warning at the top of every Flatpak log. Everywhere else
    /// — a dev build above all — the app still registers itself.
    #[test]
    fn a_flatpak_leaves_the_scheme_to_its_desktop_file() {
        assert!(!super::registers_its_own_scheme(Some(
            std::ffi::OsStr::new("com.k8s_gui.app")
        )));
        assert!(super::registers_its_own_scheme(None));
    }

    /// Every `#[tauri::command]` in the tree, by the name the frontend calls.
    fn commands_in(dir: &Path, found: &mut BTreeSet<String>) {
        for entry in fs::read_dir(dir).expect("read the source tree") {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                commands_in(&path, found);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let source = fs::read_to_string(&path).expect("read a source file");
            let mut lines = source.lines().peekable();
            while let Some(line) = lines.next() {
                // Parameterised forms count too — `#[tauri::command(rename_all
                // = "snake_case")]` is still a command, and matching the bare
                // attribute alone left a hole in the very guard this is.
                let attribute = line.trim();
                if attribute != "#[tauri::command]" && !attribute.starts_with("#[tauri::command(") {
                    continue;
                }
                // The signature can be several lines down, past other
                // attributes; the name is on the first `fn` after it.
                for next in lines.by_ref() {
                    if let Some(rest) = next.split(" fn ").nth(1) {
                        let name: String = rest
                            .chars()
                            .take_while(|c| c.is_alphanumeric() || *c == '_')
                            .collect();
                        if !name.is_empty() {
                            found.insert(name);
                        }
                        break;
                    }
                }
            }
        }
    }

    /// Nothing else in this repository holds these two together.
    ///
    /// The TypeScript binding is generated from the attribute alone: the
    /// generator was pointed at a two-command crate with one of them left
    /// out of `generate_handler!` and emitted a binding for it anyway,
    /// exiting 0. So a command that is written, registered in no handler
    /// list, type-checks on both sides, builds green, and fails at runtime
    /// with `__cmd__x not found` — which is how v2.1.0 shipped with ninety
    /// of them. The list is edited by hand beside conflict-resolved hunks;
    /// this is the thing that notices.
    #[test]
    fn every_command_is_registered_in_the_handler() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut written = BTreeSet::new();
        commands_in(&root, &mut written);
        assert!(
            written.len() > 200,
            "the scan found only {} commands; it is not reading the tree",
            written.len()
        );

        let main = fs::read_to_string(root.join("main.rs")).expect("read main.rs");
        let list = main
            .split_once("generate_handler![")
            .expect("the handler list")
            .1
            .split_once("])")
            .expect("the end of the handler list")
            .0;
        let registered: BTreeSet<String> = list
            .lines()
            .filter_map(|line| {
                let line = line.trim().trim_end_matches(',');
                if line.is_empty() || line.starts_with("//") {
                    return None;
                }
                line.rsplit("::").next().map(str::to_string)
            })
            .collect();

        let missing: Vec<&String> = written.difference(&registered).collect();
        assert!(
            missing.is_empty(),
            "written as commands and never registered, so they exist only at \
             build time: {missing:?}"
        );
    }
}
