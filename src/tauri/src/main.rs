//! Main entry point for the Rubick application

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use k8s_gui_lib::app_log::{init_tracing, log_dir};
use k8s_gui_lib::{commands, integrations, quit, shell, state::AppState, BUNDLE};
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

    // Before any TLS: kube's client takes the process default, and rustls
    // installs plain ring as that default on the first config built without
    // one.
    k8s_gui_lib::tls::provider();
    assert!(
        k8s_gui_lib::tls::default_is_ours(),
        "another TLS provider was installed before this one"
    );

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
    match k8s_gui_lib::app_log::log_path() {
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

            let way_out = quit::WayOut::of(&state);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match quit::Termination::listen() {
                    Ok(termination) => {
                        quit::quit_on(termination, way_out, |_| handle.exit(0)).await;
                    }
                    Err(error) => {
                        tracing::warn!(%error, "not listening for quit signals; a kill leaves shells running");
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
            commands::cluster::focus_cluster,
            commands::cluster::release_clusters,
            commands::cluster::get_cluster_info,
            commands::cluster::connection_attempt,
            commands::cluster::credential_renewal,
            commands::cluster::get_kubeconfig_source,
            commands::access::check_list_access,
            commands::access::check_access,
            commands::access::check_namespace_access,
            commands::access::review_own_rules,
            commands::rbac::list_role_bindings_in,
            commands::rbac::list_cluster_role_bindings,
            commands::binaries::locate_binaries,
            commands::diagnostics::collect_diagnostics,
            commands::diagnostics::path_identity,
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
            commands::crds::list_custom_resources_in,
            commands::crds::get_custom_resource,
            commands::crds::get_custom_resource_yaml,
            commands::catalog::list_api_catalog,
            commands::catalog::forget_discovery,
            commands::catalog::list_resource_table,
            commands::catalog::get_served_object,
            commands::catalog::get_served_object_yaml,
            commands::catalog::list_served_objects,
            commands::ownership::list_dependents,
            commands::ownership::preview_cascade,
            commands::ownership::object_lineage,
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
            commands::deployments::list_deployments_in,
            commands::deployments::get_deployment,
            commands::deployments::delete_deployment,
            commands::deployments::scale_deployment,
            commands::deployments::restart_deployment,
            commands::workloads::restart_statefulset,
            commands::workloads::restart_daemonset,
            commands::deployments::update_deployment_image,
            commands::deployments::get_deployment_pods,
            // ReplicaSet commands — a detail page and a Deployment's
            // revisions; deliberately no list, there is no list page.
            commands::replicasets::get_replicaset,
            commands::replicasets::get_replicaset_pods,
            commands::replicasets::get_deployment_replicasets,
            commands::revisions::get_controller_revisions,
            commands::revisions::rollback_workload,
            // Service commands
            commands::services::list_services,
            commands::services::list_services_in,
            commands::services::get_service,
            commands::services::delete_service,
            // Port-forward commands
            commands::port_forward::port_forward_pod,
            commands::port_forward::port_forward_service,
            commands::port_forward::port_forward_subscribed,
            commands::port_forward::stop_port_forward,
            commands::port_forward::list_port_forwards,
            commands::port_forward::list_port_forward_configs,
            commands::port_forward::create_port_forward_config,
            commands::port_forward::update_port_forward_config,
            commands::port_forward::delete_port_forward_config,
            // ConfigMap commands
            commands::config_resources::list_configmaps_in,
            commands::config_resources::get_configmap,
            commands::config_resources::get_configmap_data,
            commands::config_resources::delete_configmap,
            commands::config_resources::set_configmap_key,
            // Secret commands
            commands::config_resources::list_secrets_in,
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
            commands::events::get_pod_setup_warnings,
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
            commands::files::container_working_dir,
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
            commands::terminal::list_terminal_sessions,
            commands::terminal::terminal_subscribed,
            commands::terminal::open_pod_shell,
            // Resource watch (replaces 2s polling for migrated lists)
            commands::watch::subscribe_configmap_watch,
            commands::watch::subscribe_secret_watch,
            commands::watch::subscribe_service_watch,
            commands::watch::subscribe_endpoints_watch,
            commands::watch::subscribe_ingress_watch,
            commands::watch::subscribe_gateway_route_watch,
            commands::watch::subscribe_pvc_watch,
            commands::watch::subscribe_pod_row_watch,
            commands::watch::subscribe_deployment_watch,
            commands::watch::subscribe_statefulset_watch,
            commands::watch::subscribe_daemonset_watch,
            commands::watch::subscribe_job_watch,
            commands::watch::subscribe_cronjob_watch,
            commands::watch::subscribe_event_watch,
            commands::watch::subscribe_namespace_watch,
            commands::watch::subscribe_node_watch,
            commands::watch::subscribe_persistentvolume_watch,
            commands::watch::subscribe_storageclass_watch,
            commands::watch::subscribe_custom_resource_watch,
            commands::watch::subscribe_object_watch,
            commands::watch::subscribe_owned_pod_watch,
            commands::watch::subscribe_service_slice_watch,
            commands::watch::subscribe_custom_object_watch,
            commands::watch::resource_watch_subscribed,
            commands::watch::unsubscribe_resource_watch,
            // kubectl commands
            commands::kubectl::check_kubectl_availability,
            // Helm commands (native + CLI)
            commands::helm::check_helm_availability,
            commands::helm::list_helm_releases_in,
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
            commands::storage::list_persistent_volume_claims_in,
            commands::storage::get_persistent_volume_claim,
            commands::storage::delete_persistent_volume_claim,
            commands::storage::list_storage_classes,
            commands::storage::get_storage_class,
            commands::storage::delete_storage_class,
            // Network commands
            commands::network::list_ingresses,
            commands::network::list_ingresses_in,
            commands::network::list_ingress_health_inputs,
            commands::network::list_network_policies_in,
            commands::network::get_network_policy,
            commands::network::delete_network_policy,
            commands::network::get_ingress,
            commands::network::resolve_ingress_class,
            commands::network::delete_ingress,
            commands::network::list_endpoints_in,
            commands::network::list_service_endpoints,
            commands::network::list_service_backing,
            commands::network::list_service_health_inputs,
            commands::network::get_endpoints,
            commands::network::delete_endpoints,
            // Gateway API commands
            commands::gateway::detect_gateway_api,
            commands::gateway::list_gateway_classes,
            commands::gateway::get_gateway_class,
            commands::gateway::delete_gateway_class,
            commands::gateway::list_gateways,
            commands::gateway::list_gateways_in,
            commands::gateway::get_gateway,
            commands::gateway::delete_gateway,
            commands::gateway::list_gateway_routes,
            commands::gateway::list_gateway_routes_in,
            commands::gateway::get_gateway_route,
            commands::gateway::delete_gateway_route,
            commands::gateway::list_backend_tls_policies,
            commands::gateway::probe_resolve_host,
            commands::gateway::probe_tcp_connect,
            // Stats commands
            commands::overview::get_cluster_overview,
            // Metrics API
            commands::metrics::get_pods_metrics,
            commands::metrics::get_pods_metrics_in,
            commands::metrics::get_nodes_metrics,
            commands::metrics::recheck_metrics,
            // Workloads commands
            commands::workloads::list_statefulsets,
            commands::workloads::list_statefulsets_in,
            commands::workloads::get_statefulset,
            commands::workloads::scale_statefulset,
            commands::autoscalers::set_autoscaler_bounds,
            commands::autoscalers::list_autoscalers_in,
            commands::workloads::delete_statefulset,
            commands::workloads::list_daemonsets,
            commands::workloads::list_daemonsets_in,
            commands::workloads::get_daemonset,
            commands::workloads::delete_daemonset,
            commands::workloads::list_jobs,
            commands::workloads::list_jobs_in,
            commands::workloads::get_job,
            commands::workloads::delete_job,
            commands::workloads::list_cronjobs_in,
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
        // Drop does not run when the macOS loop ends the process.
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let way_out = quit::WayOut::of(&app_handle.state::<AppState>());
                tauri::async_runtime::block_on(way_out.take());
            }
        });
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
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

    /// Every source file under `dir`.
    fn sources_in(dir: &Path, found: &mut Vec<String>) {
        for entry in fs::read_dir(dir).expect("read the source tree") {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                sources_in(&path, found);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                found.push(fs::read_to_string(&path).expect("read a source file"));
            }
        }
    }

    fn ident(text: &str) -> String {
        text.chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect()
    }

    /// Every command in `sources`, by the name the frontend calls: each
    /// `#[tauri::command]` fn, and each call of a macro that stamps one out.
    fn commands_in(sources: &[String]) -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        let mut stamps = BTreeSet::new();
        for source in sources {
            // The macro being read, and the first of its parameters.
            let mut inside: Option<(String, Option<String>)> = None;
            let mut lines = source.lines();
            while let Some(line) = lines.next() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("macro_rules!") {
                    inside = Some((ident(rest.trim_start()), None));
                    continue;
                }
                if let Some((_, first @ None)) = inside.as_mut() {
                    if let Some((_, after)) = line.split_once('$') {
                        *first = Some(ident(after));
                    }
                }
                // Parameterised forms count too — `#[tauri::command(rename_all
                // = "snake_case")]` is still a command, and matching the bare
                // attribute alone left a hole in the very guard this is.
                if trimmed != "#[tauri::command]" && !trimmed.starts_with("#[tauri::command(") {
                    continue;
                }
                // The signature can be several lines down, past other
                // attributes; the name is on the first `fn` after it.
                for next in lines.by_ref() {
                    let Some(rest) = next.split(" fn ").nth(1) else {
                        continue;
                    };
                    if let Some(param) = rest.strip_prefix('$') {
                        let (stamp, first) = inside.as_ref().expect("`fn $name` outside a macro");
                        assert_eq!(
                            first.as_deref(),
                            Some(ident(param).as_str()),
                            "`{stamp}!` names its command by a parameter other than its \
                             first, and the first is the one read at its calls"
                        );
                        stamps.insert(stamp.clone());
                    } else if !ident(rest).is_empty() {
                        found.insert(ident(rest));
                    }
                    break;
                }
            }
        }
        for stamp in &stamps {
            found.extend(stamped_by(sources, stamp));
        }
        found
    }

    /// The first argument of each call of the macro `stamp`, which is the
    /// name of the command that call stamps out.
    fn stamped_by(sources: &[String], stamp: &str) -> BTreeSet<String> {
        let call = format!("{stamp}!(");
        let mut named = BTreeSet::new();
        for source in sources {
            let mut lines = source.lines().map(str::trim);
            while let Some(line) = lines.next() {
                if line.starts_with("//") {
                    continue;
                }
                let Some(at) = line.find(&call) else { continue };
                if line[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_') {
                    continue;
                }
                let mut rest = &line[at + call.len()..];
                // A call wrapped by rustfmt names the command on the next line.
                while rest.is_empty() {
                    rest = lines.next().expect("the rest of a macro call");
                }
                if !ident(rest).is_empty() {
                    named.insert(ident(rest));
                }
            }
        }
        named
    }

    /// Every command named in `generate_handler!`, as the fn is called.
    fn registered_commands(root: &Path) -> BTreeSet<String> {
        let main = fs::read_to_string(root.join("main.rs")).expect("read main.rs");
        let list = main
            .split_once("generate_handler![")
            .expect("the handler list")
            .1
            .split_once("])")
            .expect("the end of the handler list")
            .0;
        list.lines()
            .filter_map(|line| {
                let line = line.trim().trim_end_matches(',');
                if line.is_empty() || line.starts_with("//") {
                    return None;
                }
                line.rsplit("::").next().map(str::to_string)
            })
            .collect()
    }

    /// Would pass a command stamped out by a macro and registered nowhere:
    /// the attribute sits on `fn $cmd(`, which names nothing, so every
    /// `list_*_in` and `subscribe_*_watch` was outside the guard below.
    #[test]
    fn a_command_a_macro_stamps_out_is_found_by_the_name_it_is_called_with() {
        let calls = "stamp!(list_one_in, Pod);\n\
                     // stamp!(commented_out, Pod);\n\
                     not_a_stamp!(list_nothing_in, Pod);\n\
                     stamp!(\n    list_other_in,\n    Service,\n);\n\
                     #[tauri::command]\npub async fn plain() {}\n";
        let definition = "macro_rules! stamp {\n    (\n        $cmd:ident,\n        \
                          $kind:ty $(,)?\n    ) => {\n        #[tauri::command]\n        \
                          pub async fn $cmd() {}\n    };\n}\n";
        let found = commands_in(&[calls.to_string(), definition.to_string()]);
        assert_eq!(
            found,
            BTreeSet::from(["list_one_in", "list_other_in", "plain"].map(String::from))
        );
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
        let mut sources = Vec::new();
        sources_in(&root, &mut sources);
        let written = commands_in(&sources);
        assert!(
            written.len() > 200,
            "the scan found only {} commands; it is not reading the tree",
            written.len()
        );

        let registered = registered_commands(&root);

        let missing: Vec<&String> = written.difference(&registered).collect();
        assert!(
            missing.is_empty(),
            "written as commands and never registered, so they exist only at \
             build time: {missing:?}"
        );
    }

    /// Would let a live harness document a command that runs nothing:
    /// libtest exits 0 when its filter matches no test, so the command reads
    /// as a pass. `live_connections::listenerset` was one.
    #[test]
    fn every_command_a_live_harness_documents_runs_a_test() {
        const RUN: &str = "cargo test --test live ";
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/live");
        let mut tests = Vec::new();
        let mut commands = Vec::new();
        for entry in fs::read_dir(&dir).expect("the live harnesses") {
            let path = entry.expect("an entry").path();
            let module = path.file_stem().expect("a name").to_string_lossy();
            let source = fs::read_to_string(&path).expect("a harness");
            let mut marked = false;
            for line in source.lines().map(str::trim) {
                if line.starts_with("#[tokio::test") || line.starts_with("#[test") {
                    marked = true;
                } else if let Some(rest) =
                    line.strip_prefix("async fn ").or(line.strip_prefix("fn "))
                {
                    if std::mem::take(&mut marked) {
                        let name = rest.split('(').next().unwrap_or_default();
                        tests.push(format!("{module}::{name}"));
                    }
                }
            }
            // A command may run on past a `\` into the next doc line.
            let prose = source
                .lines()
                .map(|line| line.trim().trim_start_matches('/').trim_start_matches('!'))
                .collect::<Vec<_>>()
                .join("\n")
                .replace("\\\n", " ");
            for line in prose.lines() {
                if let Some((_, args)) = line.split_once(RUN) {
                    let args: Vec<&str> = args.split_whitespace().collect();
                    let filter = args.first().copied().unwrap_or_default().to_string();
                    commands.push((module.to_string(), filter, args.contains(&"--exact")));
                }
            }
        }
        assert!(tests.len() > 40, "found only {} tests", tests.len());
        assert!(
            commands.len() > 20,
            "found only {} commands",
            commands.len()
        );

        for (module, filter, exact) in commands {
            let runs = tests.iter().any(|test| {
                if exact {
                    *test == filter
                } else {
                    test.contains(&filter)
                }
            });
            assert!(runs, "{module} documents `{filter}`, which runs no test");
        }
    }

    /// `list_events` as the recorder files it: `listEvents`.
    fn camel(snake: &str) -> String {
        snake
            .split('_')
            .enumerate()
            .map(|(at, word)| {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) if at > 0 => first.to_uppercase().chain(chars).collect(),
                    _ => word.to_string(),
                }
            })
            .collect()
    }

    /// The macros whose expansion times the command it stamps out.
    fn timing_macros(sources: &[String]) -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        for source in sources {
            let mut lines = source.lines();
            while let Some(line) = lines.next() {
                let Some(rest) = line.trim().strip_prefix("macro_rules!") else {
                    continue;
                };
                let name = ident(rest.trim_start());
                if lines
                    .by_ref()
                    .take_while(|body| *body != "}")
                    .any(|body| body.contains("command_name!("))
                {
                    found.insert(name);
                }
            }
        }
        found
    }

    /// Every command that is timed, by the name it is timed under: the
    /// literal each call of `timed` passes, and each command a timing macro
    /// stamps out.
    fn timed_commands(sources: &[String]) -> BTreeSet<String> {
        const CALL: &str = concat!("clock::", "timed(");
        let mut timed = BTreeSet::new();
        for source in sources {
            for (at, _) in source.match_indices(CALL) {
                if source[..at]
                    .rsplit('\n')
                    .next()
                    .is_some_and(|line| line.trim_start().starts_with("//"))
                {
                    continue;
                }
                let rest = source[at + CALL.len()..].trim_start();
                let rest = rest
                    .strip_prefix("&state.perf,")
                    .unwrap_or_else(|| panic!("a timed call the guard cannot read: {rest:.60}"))
                    .trim_start();
                if let Some(name) = rest.strip_prefix('"') {
                    timed.insert(name.split('"').next().unwrap_or_default().to_string());
                } else {
                    assert!(
                        rest.starts_with("$crate::client::clock::command_name!("),
                        "a timed call names its command neither by literal nor by macro: {rest:.60}"
                    );
                }
            }
        }
        for stamp in timing_macros(sources) {
            timed.extend(stamped_by(sources, &stamp).iter().map(|name| camel(name)));
        }
        timed
    }

    fn command_sources() -> (std::path::PathBuf, Vec<String>) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut sources = Vec::new();
        sources_in(&root, &mut sources);
        (root, sources)
    }

    /// Would let a timed call and a timing macro be missed, and with them a
    /// command the guards below think is untimed, or timed under a typo.
    #[test]
    fn a_timed_call_and_a_timing_macro_are_both_read_as_timing() {
        let times = "macro_rules! times {\n    ($cmd:ident) => {\n        pub async fn $cmd() {\n            \
                     $crate::client::@timed(\n                &state.perf,\n                \
                     $crate::client::clock::command_name!($cmd),\n                work,\n            \
                     )\n        }\n    };\n}\n";
        let plain = "macro_rules! plain {\n    ($cmd:ident) => {\n        pub async fn $cmd() {}\n    };\n}\n";
        let calls = "times!(list_one_in, Pod);\nplain!(list_two_in, Pod);\n\
                     // crate::client::@timed(&state.perf, \"commented\", x)\n\
                     fn a() { crate::client::@timed(\n    &state.perf,\n    \"getThree\",\n    x) }\n";
        assert_eq!(
            timed_commands(&[times, plain, calls].map(|text| text.replace('@', "clock::"))),
            BTreeSet::from(["listOneIn", "getThree"].map(String::from))
        );
    }

    /// A name `timed` files numbers under that no command has is a row the
    /// recorder shows and nothing invokes, and leaves the command it was
    /// meant for reading "not timed".
    #[test]
    fn every_name_a_command_is_timed_under_belongs_to_a_registered_command() {
        let (root, sources) = command_sources();
        let registered: BTreeSet<String> = registered_commands(&root)
            .iter()
            .map(|name| camel(name))
            .collect();
        let timed = timed_commands(&sources);
        assert!(
            timed.len() > 60,
            "the scan found only {} timed commands; it is not reading the tree",
            timed.len()
        );

        let strangers: Vec<&String> = timed.difference(&registered).collect();
        assert!(
            strangers.is_empty(),
            "timed under a name no registered command has: {strangers:?}"
        );
    }

    /// A `list_*` or `get_*` command left out of `timed` reads "not timed" in
    /// the performance panel, which is how thirteen of nineteen rows of one
    /// recording read while the cluster reads among them took the time.
    #[test]
    fn every_list_and_get_command_that_reads_the_cluster_is_timed() {
        const NOT_THE_CLUSTER: [&str; 25] = [
            "get_app_info",
            "get_cli_paths",
            "get_cluster_preferences",
            "get_context_binding",
            "get_current_context",
            "get_kubeconfig_path",
            "get_kubeconfig_paths",
            "get_kubeconfig_source",
            "get_loki_connection",
            "get_prometheus_connection",
            "get_recent_items",
            "get_theme_config",
            "get_updater_settings",
            "get_yaml_history",
            "list_azure_profiles",
            "list_container_files",
            "list_context_bindings",
            "list_contexts",
            "list_gcp_profiles",
            "list_helm_repos",
            "list_pod_rows",
            "list_port_forward_configs",
            "list_port_forwards",
            "list_share_targets",
            "list_terminal_sessions",
        ];
        let (root, sources) = command_sources();
        let registered = registered_commands(&root);
        let timed = timed_commands(&sources);

        for name in NOT_THE_CLUSTER {
            assert!(
                registered.contains(name),
                "{name} is exempted and no longer a command"
            );
            assert!(
                !timed.contains(&camel(name)),
                "{name} is exempted and timed; drop the exemption"
            );
        }
        let untimed: Vec<&String> = registered
            .iter()
            .filter(|name| name.starts_with("list_") || name.starts_with("get_"))
            .filter(|name| !NOT_THE_CLUSTER.contains(&name.as_str()))
            .filter(|name| !timed.contains(&camel(name)))
            .collect();
        assert!(
            untimed.is_empty(),
            "read the cluster and are not timed, or answer from this machine and belong in \
             the exemptions: {untimed:?}"
        );
    }

    /// Every sync command by name, with its body. A `#[tauri::command(async)]`
    /// runs on the async runtime and is left out, as an `async fn` is.
    fn sync_commands_in(sources: &[String]) -> BTreeMap<String, String> {
        let mut found = BTreeMap::new();
        for source in sources {
            let mut lines = source.lines();
            while let Some(line) = lines.next() {
                let attribute = line.trim();
                if attribute != "#[tauri::command]" && !attribute.starts_with("#[tauri::command(") {
                    continue;
                }
                for next in lines.by_ref() {
                    let Some(rest) = next.split(" fn ").nth(1) else {
                        continue;
                    };
                    if attribute.contains("async") || next.contains("async fn") {
                        break;
                    }
                    let end = format!("{}}}", &next[..next.len() - next.trim_start().len()]);
                    let body: Vec<&str> = lines.by_ref().take_while(|l| *l != end).collect();
                    found.insert(ident(rest), body.join("\n"));
                    break;
                }
            }
        }
        found
    }

    /// Tauri runs a sync command on the thread that draws the window, so a
    /// save of config.toml that ended in an fsync froze every frame and every
    /// answer for 1.7 to 3.2 s on a busy disk, and saving the namespace did it
    /// on every switch. Fails if a sync command is not one of these, which
    /// touch only memory, or if one of these names a way to the disk.
    #[test]
    fn a_command_on_the_window_thread_touches_only_memory() {
        const ON_THE_WINDOW_THREAD: [&str; 26] = [
            "cancel_auth_session",
            "cancel_node_drain",
            "cancel_resource_search",
            "close_terminal",
            "connection_attempt",
            "credential_renewal",
            "disconnect_cluster",
            "files_subscribed",
            "focus_cluster",
            "get_app_info",
            "list_port_forwards",
            "list_terminal_sessions",
            "log_stream_subscribed",
            "node_drain_subscribed",
            "pod_rows_subscribed",
            "port_forward_subscribed",
            "recheck_metrics",
            "release_clusters",
            "resource_search_subscribed",
            "resource_watch_subscribed",
            "stop_files_listing",
            "stop_log_stream",
            "stop_pod_rows",
            "stop_port_forward",
            "terminal_subscribed",
            "unsubscribe_resource_watch",
        ];
        const WAYS_TO_THE_DISK: [&str; 12] = [
            "fs::",
            "File",
            "Path",
            "AppConfig",
            "config_path",
            "read_config",
            "update_config",
            "with_config",
            "entry_for",
            "in_sandbox",
            "dirs::",
            "read_to_string",
        ];
        let (_, sources) = command_sources();
        let sync = sync_commands_in(&sources);
        assert!(
            sync.len() >= 20,
            "the scan found only {} sync commands; it is not reading the tree",
            sync.len()
        );

        let unlisted: Vec<&String> = sync
            .keys()
            .filter(|name| !ON_THE_WINDOW_THREAD.contains(&name.as_str()))
            .collect();
        assert!(
            unlisted.is_empty(),
            "sync commands run on the window thread: make these async and do their disk \
             work through settings::off_main, or list them if they touch only memory: \
             {unlisted:?}"
        );
        for name in ON_THE_WINDOW_THREAD {
            let body = sync
                .get(name)
                .unwrap_or_else(|| panic!("{name} is listed and is no longer a sync command"));
            let way = WAYS_TO_THE_DISK.iter().find(|way| body.contains(*way));
            assert!(
                way.is_none(),
                "{name} runs on the window thread and reaches the disk through {way:?}"
            );
        }
    }
}
