//! Exec-credential authentication flow + browser-script helpers.
//!
//! When kubeconfig declares an `exec` block, we either short-circuit
//! through `cloud::try_native_cloud_auth` or actually spawn the exec
//! command in a terminal session, capturing its stdout (the JSON
//! `ExecCredential`) and any auth URL it printed via the
//! `BROWSER` / `K8S_GUI_AUTH_URL_FILE` env hooks.

use crate::commands::kubectl::kubectl_manager;
use crate::error::{AuthError, Error, Result};
use crate::state::{AppEvent, AppState, AuthOutcome};
use kube::config::{ExecAuthCluster, ExecConfig, ExecInteractiveMode};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use tokio::time::{Duration, Instant};

use super::cloud::{resolve_cloud_cli_path, try_native_cloud_auth};
use super::cred::{
    ExecCredential, ExecCredentialRequest, ExecCredentialSpec, ExecCredentialStatus,
    ExecTerminalParams,
};

/// Timeout injected into kubelogin-family exec plugins via
/// `--authentication-timeout-sec` when the user hasn't set their own.
///
/// Paired with the [`AUTH_FLOW_TIMEOUT_SECS`] outer cap: an explicit value
/// lets the plugin print its own clean "context deadline exceeded" on a
/// predictable schedule (3 min) instead of hanging until the 30-min cap
/// kills it. 180 s matches kubelogin's own historical default — long
/// enough for a real browser-auth flow (SSO, MFA), short enough to surface
/// a stuck attempt while the user is still looking at the screen.
const KUBELOGIN_INJECTED_AUTH_TIMEOUT_SECS: u64 = 180;

/// Whether to add `--authentication-timeout-sec=<N>` to the args handed to
/// the exec plugin. True only when both:
///   * the command (by basename) is kubelogin or kubectl-oidc_login —
///     including `kubectl oidc-login …`, where kubectl invokes the plugin
///     as a subcommand
///   * the user hasn't already set `--authentication-timeout-sec`
///     themselves (either form: `--flag=N` or `--flag N`)
///
/// Any other plugin (gke-gcloud-auth-plugin, aws-iam-authenticator,
/// corporate exec plugins, …) would reject the flag as unknown, so its args
/// are left alone and it falls back to the 30-min outer cap.
fn should_inject_kubelogin_timeout(command: &str, args: &[String]) -> bool {
    let basename = std::path::Path::new(command)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(command);

    let is_kubelogin_family = matches!(basename, "kubelogin" | "kubectl-oidc_login")
        || (basename == "kubectl"
            && args.first().map(std::string::String::as_str) == Some("oidc-login"));

    if !is_kubelogin_family {
        return false;
    }

    let user_already_set = args.iter().any(|a| {
        a == "--authentication-timeout-sec" || a.starts_with("--authentication-timeout-sec=")
    });
    !user_already_set
}

/// Hard cap on how long the auth flow waits for the spawned exec
/// plugin before giving up and killing the terminal session.
///
/// **Sized to outlast any reasonable plugin's own timeout**, not to race
/// it. Never pin this against a plugin's current default: that number
/// lives in someone else's source tree, and the moment they bump it we
/// silently start killing the plugin first, swallowing its real error and
/// leaving the user a useless "no JSON" toast.
///
/// 30 minutes covers:
///   * kubelogin's 180 s default and any future bump (3-5x headroom)
///   * cloud-CLI plugins (gke-gcloud-auth-plugin / aws-iam-authenticator)
///     that occasionally take minutes on first-time MFA prompts
///   * a real human walking away to fetch a `YubiKey`
///
/// The user is never trapped: the auth modal has a Cancel button
/// (`cancel_auth_session` Tauri command → `cancel_rx` branch of the
/// select! below), so this only protects against a genuinely hung plugin
/// holding system resources forever.
const AUTH_FLOW_TIMEOUT_SECS: u64 = 30 * 60;

pub(super) async fn run_exec_auth(
    state: &AppState,
    context: &str,
    exec: &ExecConfig,
    exec_cluster: Option<ExecAuthCluster>,
) -> Result<ExecCredentialStatus> {
    // Create the auth session BEFORE attempting native auth so a
    // concurrent `disconnect_cluster` (or any caller of
    // `cancel_auth_sessions_for_context`) can interrupt this attempt.
    // Native GCP/Azure auth's ADC retries take 5+ seconds
    // (`gcp_auth::ConfigDefaultCredentials` looking for application default
    // credentials, then `MetadataServiceAccount`) — long enough for the
    // user to switch contexts first, and `AuthTerminalSessionCreated` then
    // lands as an orphan modal over whatever cluster they landed on.
    let (session_id, mut cancel_rx) = state.create_auth_session(context, "exec");

    // Race native cloud auth against the cancel signal. Dropping the
    // native_auth future at the select branch aborts gcp_auth's HTTP
    // retries at the next .await point — no orphan task left running.
    let native_result = tokio::select! {
        result = try_native_cloud_auth(exec, context) => result,
        _ = &mut cancel_rx => {
            state.remove_auth_session(&session_id);
            state.emit(AppEvent::AuthFlowCancelled {
                session_id: session_id.clone(),
                context: context.to_string(),
                why: None,
            });
            return Err(Error::Auth(AuthError::Kubeconfig(
                "Authentication cancelled".to_string(),
            )));
        }
    };

    if let Some(result) = native_result {
        // Native auth succeeded — drop the holding session, no terminal
        // ever spawned, no event sent to the frontend.
        state.remove_auth_session(&session_id);
        return result;
    }

    // Native skipped/failed → fall through to spawned exec terminal.
    let (browser_script, url_file, bin_dir) = match create_browser_script(&session_id) {
        Ok(paths) => paths,
        Err(err) => {
            state.remove_auth_session(&session_id);
            return Err(err);
        }
    };

    let params =
        match build_exec_terminal_params(exec, &browser_script, &url_file, &bin_dir, exec_cluster)
            .await
        {
            Ok(params) => params,
            Err(err) => {
                cleanup_auth_artifacts(&browser_script, &url_file, &bin_dir);
                state.remove_auth_session(&session_id);
                return Err(err);
            }
        };

    // A missing kubectl plugin is caught here rather than left to
    // kubectl, whose own message names neither the file it wanted nor
    // where it looked.
    if let Err(err) =
        crate::commands::binaries::ensure_kubectl_plugin_present(&params.command, &params.args)
    {
        cleanup_auth_artifacts(&browser_script, &url_file, &bin_dir);
        state.remove_auth_session(&session_id);
        return Err(err);
    }

    // Subscribe to events BEFORE creating session to avoid race condition
    let mut event_rx = state.event_tx.subscribe();

    // Create terminal session for exec auth
    let adapter = crate::terminal::AuthExecAdapter::new(
        params.command.clone(),
        params.args.clone(),
        params.env,
    );

    // Extract collected_stdout Arc before moving adapter
    let collected_stdout = adapter.collected_stdout();
    let last_exit_status = adapter.last_exit_status();

    let terminal_session_id = state
        .terminal_manager
        .create_session(Box::new(adapter))
        .await
        .map_err(|e| {
            cleanup_auth_artifacts(&browser_script, &url_file, &bin_dir);
            state.remove_auth_session(&session_id);
            Error::Auth(AuthError::Kubeconfig(format!(
                "Failed to create terminal session: {e}"
            )))
        })?;

    state.emit(AppEvent::AuthTerminalSessionCreated {
        auth_session_id: session_id.clone(),
        terminal_session_id: terminal_session_id.clone(),
        context: context.to_string(),
        command: format!("{} {}", params.command, params.args.join(" ")),
    });

    let mut url_emitted = false;
    let mut last_url = String::new();
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    let started = Instant::now();

    // Wait for terminal session to complete
    loop {
        tokio::select! {
            Ok(event) = event_rx.recv() => {
                if let AppEvent::TerminalClosed { session_id: sid, .. } = event {
                    if sid == terminal_session_id {
                        break;
                    }
                }
            }
            _ = interval.tick() => {
                if !url_emitted {
                    if let Ok(url) = read_auth_url(&url_file).await {
                        if !url.is_empty() && url != last_url {
                            last_url.clone_from(&url);
                            url_emitted = true;
                            state.emit(AppEvent::AuthUrlRequested {
                                context: context.to_string(),
                                url,
                                flow: "exec".to_string(),
                                session_id: Some(session_id.clone()),
                                // The plugin runs its own flow; where it sends the browser back is
                                // its business and not visible from here.
                                redirect_uri: None,
                            });
                        }
                    }
                }
            }
            _ = &mut cancel_rx => {
                state.terminal_manager.close_session(&terminal_session_id)?;
                cleanup_auth_artifacts(&browser_script, &url_file, &bin_dir);
                state.remove_auth_session(&session_id);
                state.emit(AppEvent::AuthFlowCancelled {
                    session_id,
                    context: context.to_string(),
                    why: None,
                });
                return Err(Error::Auth(AuthError::Kubeconfig("Authentication cancelled".to_string())));
            }
        }
        if started.elapsed() > Duration::from_secs(AUTH_FLOW_TIMEOUT_SECS) {
            state.terminal_manager.close_session(&terminal_session_id)?;
            cleanup_auth_artifacts(&browser_script, &url_file, &bin_dir);
            state.remove_auth_session(&session_id);
            state.emit(AppEvent::AuthFlowCompleted {
                session_id,
                context: context.to_string(),
                success: false,
                why: Some(AuthOutcome::TimedOut),
            });
            return Err(Error::Timeout("Authentication timed out".to_string()));
        }
    }

    cleanup_auth_artifacts(&browser_script, &url_file, &bin_dir);
    state.remove_auth_session(&session_id);

    // Read collected stdout from terminal session
    let stdout_data = collected_stdout.lock();

    if stdout_data.is_empty() {
        // An interactive OIDC plugin (kubectl-oidc_login / kubelogin)
        // under a PTY stays completely silent while it waits for the
        // browser leg of the auth-code flow — it prints nothing until
        // it either receives the callback or hits its own timeout.
        // An empty buffer here therefore almost always means the user
        // never completed (or never saw) the browser login, not that
        // the plugin is broken.
        let msg = "The authentication plugin produced no output. If this is an \
             interactive OIDC plugin (kubectl-oidc_login / kubelogin), it was \
             waiting for you to finish signing in through the browser — make \
             sure the authentication URL opened and you completed the login."
            .to_string();
        state.emit(AppEvent::AuthFlowCompleted {
            session_id,
            context: context.to_string(),
            success: false,
            why: Some(AuthOutcome::Said { text: msg.clone() }),
        });
        return Err(Error::Auth(AuthError::Kubeconfig(msg)));
    }

    // Real-world PTY output mixes prompts, blank lines and occasional ANSI
    // control sequences with the final JSON ExecCredential, so
    // `serde_json::from_slice` on the raw buffer fails with "expected value
    // at line 2 column 1" — the bytes don't start at the `{`.
    // `extract_exec_credential` locates the JSON object inside the buffer.
    // On failure the child's exit code and an escaped stdout preview are
    // tacked on: without them "no JSON object found in N bytes" cannot be
    // told apart from "exited 0 with whitespace", "exited 1 with an error
    // string", or "printed something the extractor chokes on".
    let creds: ExecCredential =
        crate::auth::interactive::cred::extract_exec_credential(&stdout_data).map_err(|msg| {
            let exit_str = match *last_exit_status.lock() {
                Some(code) => format!("exit code {code}"),
                None => "exit code unknown".to_string(),
            };
            let preview = preview_bytes(&stdout_data, 200);
            Error::Auth(AuthError::Kubeconfig(format!(
                "Invalid exec credentials ({exit_str}): {msg}. Stdout preview: {preview}"
            )))
        })?;
    // The extractor only ever returns a status-less credential when nothing
    // in the whole buffer had one — so this is not "the plugin forgot a
    // field", it is "we could not find the credential and settled for a
    // fragment". Say what was actually there, or the next report is another
    // bare "missing status" with nothing to work from (#106).
    let status = creds.status.ok_or_else(|| {
        let exit_str = match *last_exit_status.lock() {
            Some(code) => format!("exit code {code}"),
            None => "exit code unknown".to_string(),
        };
        let preview = preview_bytes(&stdout_data, 200);
        Error::Auth(AuthError::Kubeconfig(format!(
            "Exec credentials missing status ({exit_str}, {} bytes of stdout). \
             Stdout preview: {preview}",
            stdout_data.len()
        )))
    })?;
    if status.token.is_none()
        && (status.client_certificate_data.is_none() || status.client_key_data.is_none())
    {
        state.emit(AppEvent::AuthFlowCompleted {
            session_id,
            context: context.to_string(),
            success: false,
            why: Some(AuthOutcome::NoTokenInCredential),
        });
        return Err(Error::Auth(AuthError::Kubeconfig(
            "Exec credentials missing token".to_string(),
        )));
    }

    state.emit(AppEvent::AuthFlowCompleted {
        session_id,
        context: context.to_string(),
        success: true,
        why: None,
    });

    Ok(status)
}

async fn build_exec_terminal_params(
    exec: &ExecConfig,
    browser_script: &std::path::Path,
    url_file: &std::path::Path,
    bin_dir: &std::path::Path,
    exec_cluster: Option<ExecAuthCluster>,
) -> Result<ExecTerminalParams> {
    let command = exec
        .command
        .as_ref()
        .ok_or_else(|| Error::Auth(AuthError::Kubeconfig("Exec command missing".to_string())))?;

    // Try to resolve the command path for cloud CLIs
    let resolved_command = resolve_cloud_cli_path(command)
        .await
        .map_or_else(|| command.clone(), |p| p.to_string_lossy().to_string());

    // Collect args
    let mut args = exec.args.clone().unwrap_or_default();

    // For kubelogin family: inject a deterministic
    // --authentication-timeout-sec so the plugin's own "context
    // deadline exceeded" diagnostic fires on a predictable schedule
    // (3 min) instead of hanging until our 30-min outer cap. Pure
    // additive — never overrides a flag the user set in kubeconfig,
    // never touches non-kubelogin plugins. See
    // [`should_inject_kubelogin_timeout`] for the exact rules.
    if should_inject_kubelogin_timeout(&resolved_command, &args) {
        args.push(format!(
            "--authentication-timeout-sec={KUBELOGIN_INJECTED_AUTH_TIMEOUT_SECS}"
        ));
    }

    // Collect env
    let mut env = HashMap::new();
    if let Some(exec_env) = &exec.env {
        for entry in exec_env {
            if let (Some(name), Some(value)) = (entry.get("name"), entry.get("value")) {
                env.insert(name.clone(), value.clone());
            }
        }
    }

    let interactive = exec.interactive_mode != Some(ExecInteractiveMode::Never);
    let exec_info = ExecCredentialRequest {
        api_version: exec.api_version.clone(),
        kind: Some("ExecCredential".to_string()),
        spec: Some(ExecCredentialSpec {
            interactive: Some(interactive),
            cluster: exec_cluster,
        }),
        status: None,
    };
    let exec_info = serde_json::to_string(&exec_info).map_err(|e| {
        Error::Auth(AuthError::Kubeconfig(format!(
            "Exec info serialize failed: {e}"
        )))
    })?;

    env.insert("KUBERNETES_EXEC_INFO".to_string(), exec_info);
    env.insert(
        "K8S_GUI_AUTH_URL_FILE".to_string(),
        url_file.to_string_lossy().to_string(),
    );
    env.insert(
        "BROWSER".to_string(),
        browser_script.to_string_lossy().to_string(),
    );

    // Find kubectl directory to add to PATH (for exec plugins like oidc-login)
    let kubectl_dir = kubectl_manager()
        .await
        .resolve_path()
        .await
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()));

    // Prepend our bin directory and kubectl directory to PATH
    // Use shell-resolved PATH to include homebrew and user paths
    let current_path = crate::shell::get_user_path();
    let current_path = if current_path.is_empty() {
        std::env::var("PATH").unwrap_or_default()
    } else {
        current_path.to_string()
    };

    // Use OS-agnostic path separator (';' on Windows, ':' on Unix)
    let sep = crate::cli::PathResolver::separator();
    let new_path = match kubectl_dir {
        Some(kdir) => format!("{}{sep}{kdir}{sep}{current_path}", bin_dir.display()),
        None => format!("{}{sep}{current_path}", bin_dir.display()),
    };
    env.insert("PATH".to_string(), new_path);

    Ok(ExecTerminalParams {
        command: resolved_command,
        args,
        env,
    })
}

async fn read_auth_url(path: &PathBuf) -> Result<String> {
    let contents = tokio::fs::read_to_string(path).await?;
    Ok(contents.trim().to_string())
}

/// Render up to `max_bytes` of `data` as a debuggable preview string:
/// printable bytes pass through, others become `\xNN` escapes (with the
/// common ones — newline, return, tab — using their conventional `\n`
/// `\r` `\t` forms). Truncates with a "+N more" tail.
///
/// Enriches `Invalid exec credentials` messages with the actual bytes the
/// plugin printed: without them "no JSON object found in 6 bytes" is
/// indistinguishable from PTY init noise, a one-line plugin error, a
/// truncated JSON header or an empty terminal response.
fn preview_bytes(data: &[u8], max_bytes: usize) -> String {
    let truncated = data.len() > max_bytes;
    let slice = &data[..data.len().min(max_bytes)];
    let mut out = String::with_capacity(slice.len() + 4);
    out.push('"');
    for &b in slice {
        match b {
            b'\\' => out.push_str("\\\\"),
            b'"' => out.push_str("\\\""),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7e => out.push(b as char),
            other => {
                let _ = write!(out, "\\x{other:02x}");
            }
        }
    }
    out.push('"');
    if truncated {
        let _ = write!(out, " (+{} more bytes)", data.len() - max_bytes);
    }
    out
}

fn create_browser_script(session_id: &str) -> Result<(PathBuf, PathBuf, PathBuf)> {
    let mut dir = std::env::temp_dir();
    dir.push("k8s-gui-auth");
    dir.push(session_id);
    std::fs::create_dir_all(&dir)?;

    let mut url_file = dir.clone();
    url_file.push("auth-url.txt");

    let mut script_path = dir.clone();

    // Create bin directory for PATH override
    let mut bin_dir = dir.clone();
    bin_dir.push("bin");
    std::fs::create_dir_all(&bin_dir)?;

    #[cfg(target_os = "windows")]
    {
        script_path.push("open-url.cmd");
        let script = "@echo off\r\nif \"%1\"==\"\" exit /b 0\r\necho %1> \"%K8S_GUI_AUTH_URL_FILE%\"\r\nexit /b 0\r\n";
        std::fs::write(&script_path, script)?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        script_path.push("open-url.sh");
        // Script that captures URL and writes to file
        let script = r#"#!/bin/sh
if [ -n "$1" ]; then
  printf "%s" "$1" > "$K8S_GUI_AUTH_URL_FILE"
fi
exit 0
"#;
        std::fs::write(&script_path, script)?;

        // Create fake 'open' command for macOS (gcloud uses 'open' directly)
        #[cfg(target_os = "macos")]
        {
            let mut open_script = bin_dir.clone();
            open_script.push("open");
            let open_script_content = r#"#!/bin/sh
# Intercept 'open' command to capture auth URLs
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      if [ -n "$K8S_GUI_AUTH_URL_FILE" ]; then
        printf "%s" "$arg" > "$K8S_GUI_AUTH_URL_FILE"
        exit 0
      fi
      ;;
  esac
done
# Fall back to real open for non-URL arguments
exec /usr/bin/open "$@"
"#;
            std::fs::write(&open_script, open_script_content)?;
        }

        // Create fake 'xdg-open' for Linux
        #[cfg(target_os = "linux")]
        {
            let mut xdg_script = bin_dir.clone();
            xdg_script.push("xdg-open");
            let xdg_script_content = r#"#!/bin/sh
# Intercept 'xdg-open' command to capture auth URLs
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      if [ -n "$K8S_GUI_AUTH_URL_FILE" ]; then
        printf "%s" "$arg" > "$K8S_GUI_AUTH_URL_FILE"
        exit 0
      fi
      ;;
  esac
done
# Fall back to real xdg-open for non-URL arguments
exec /usr/bin/xdg-open "$@"
"#;
            std::fs::write(&xdg_script, xdg_script_content)?;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script_path)?.permissions();
            perms.set_mode(0o700);
            std::fs::set_permissions(&script_path, perms)?;

            // Make all scripts in bin directory executable
            if let Ok(entries) = std::fs::read_dir(&bin_dir) {
                for entry in entries.flatten() {
                    if let Ok(mut perms) = std::fs::metadata(entry.path()).map(|m| m.permissions())
                    {
                        perms.set_mode(0o700);
                        let _ = std::fs::set_permissions(entry.path(), perms);
                    }
                }
            }
        }
    }

    Ok((script_path, url_file, bin_dir))
}

fn cleanup_auth_artifacts(script_path: &PathBuf, url_file: &PathBuf, bin_dir: &PathBuf) {
    let _ = std::fs::remove_file(script_path);
    let _ = std::fs::remove_file(url_file);
    let _ = std::fs::remove_dir_all(bin_dir);
}

#[cfg(test)]
mod inject_tests {
    use super::should_inject_kubelogin_timeout;

    fn args(strs: &[&str]) -> Vec<String> {
        strs.iter().map(std::string::ToString::to_string).collect()
    }

    #[test]
    fn injects_for_standalone_kubelogin() {
        assert!(should_inject_kubelogin_timeout(
            "kubelogin",
            &args(&["get-token", "--oidc-issuer-url=https://x"]),
        ));
    }

    #[test]
    fn injects_for_kubectl_oidc_login_plugin_binary() {
        // When the kubeconfig lists the plugin binary directly
        // (`command: kubectl-oidc_login`).
        assert!(should_inject_kubelogin_timeout(
            "kubectl-oidc_login",
            &args(&["get-token", "--oidc-issuer-url=https://x"]),
        ));
    }

    #[test]
    fn injects_for_kubectl_oidc_login_subcommand_form() {
        // Most kubeconfigs in the wild use `command: kubectl` +
        // `args: ["oidc-login", "get-token", …]`. kubectl just
        // re-execs the plugin, but our flag injection has to land
        // on the args list before kubectl hands it off.
        assert!(should_inject_kubelogin_timeout(
            "kubectl",
            &args(&["oidc-login", "get-token", "--oidc-issuer-url=https://x",]),
        ));
    }

    #[test]
    fn detects_by_basename_when_command_is_full_path() {
        assert!(should_inject_kubelogin_timeout(
            "/opt/homebrew/bin/kubelogin",
            &args(&["get-token"]),
        ));
        assert!(should_inject_kubelogin_timeout(
            "/usr/local/bin/kubectl-oidc_login",
            &args(&["get-token"]),
        ));
    }

    #[test]
    fn skips_when_user_set_explicit_timeout_with_equals() {
        assert!(!should_inject_kubelogin_timeout(
            "kubelogin",
            &args(&["get-token", "--authentication-timeout-sec=300"]),
        ));
    }

    #[test]
    fn skips_when_user_set_explicit_timeout_with_space() {
        // The `--flag VALUE` form is just as legal as `--flag=VALUE`
        // and shows up in real kubeconfigs.
        assert!(!should_inject_kubelogin_timeout(
            "kubelogin",
            &args(&["get-token", "--authentication-timeout-sec", "300"]),
        ));
    }

    #[test]
    fn skips_unrelated_exec_plugins() {
        // gke / aws / oci / any corporate plugin won't recognise
        // --authentication-timeout-sec and would crash on it. The
        // outer 30-min cap is the right fallback for these.
        assert!(!should_inject_kubelogin_timeout(
            "gke-gcloud-auth-plugin",
            &args(&[]),
        ));
        assert!(!should_inject_kubelogin_timeout(
            "aws-iam-authenticator",
            &args(&["token", "-i", "my-cluster"]),
        ));
        assert!(!should_inject_kubelogin_timeout(
            "oci",
            &args(&["ce", "cluster", "generate-token"]),
        ));
    }

    #[test]
    fn skips_kubectl_with_non_oidc_subcommand() {
        // `command: kubectl` + something other than `oidc-login` is
        // not a kubelogin invocation. Don't poison those args.
        assert!(!should_inject_kubelogin_timeout(
            "kubectl",
            &args(&["get", "pods"]),
        ));
    }

    #[test]
    fn skips_when_args_are_empty_for_bare_kubectl() {
        // Edge case — `command: kubectl` with no args at all isn't
        // a plugin call.
        assert!(!should_inject_kubelogin_timeout("kubectl", &args(&[])));
    }
}

#[cfg(test)]
mod preview_tests {
    use super::{preview_bytes, AUTH_FLOW_TIMEOUT_SECS};

    #[test]
    // Constant on purpose: the point is to fail the moment somebody lowers
    // the timeout, and the message needs both values in it.
    #[allow(clippy::assertions_on_constants)]
    fn auth_flow_timeout_is_large_enough_to_outlast_any_reasonable_plugin() {
        // Deliberately NOT pinned against a specific plugin's current
        // default. The invariant asserted instead: the timeout is large
        // enough that a plugin with a *reasonable* internal one
        // (kubelogin's 180 s, AWS IAM's ~10 min) always gets to print its
        // own diagnostic and exit before our killer fires.
        //
        // 15 minutes is the conservative lower bound. A plugin with a
        // longer default is doing something exotic, and whoever hits that
        // should bump the constant intentionally rather than hide the
        // regression behind a passing test.
        const MIN_REASONABLE_TIMEOUT_SECS: u64 = 15 * 60;
        assert!(
            AUTH_FLOW_TIMEOUT_SECS >= MIN_REASONABLE_TIMEOUT_SECS,
            "auth flow timeout is {AUTH_FLOW_TIMEOUT_SECS}s — too short \
             to safely outlast common exec-plugin internal timeouts. \
             Bump AUTH_FLOW_TIMEOUT_SECS to at least \
             {MIN_REASONABLE_TIMEOUT_SECS}s (see its doc-comment for why)."
        );
    }

    #[test]
    fn prints_printable_ascii_as_is() {
        assert_eq!(preview_bytes(b"hello", 100), "\"hello\"");
    }

    #[test]
    fn escapes_common_control_chars() {
        assert_eq!(preview_bytes(b"a\nb\rc\td", 100), "\"a\\nb\\rc\\td\"");
    }

    #[test]
    fn escapes_non_printable_bytes_as_hex() {
        // PTY init sequences are often non-printable. Hex escape lets
        // a human eyeball "\\x1b[0m" and recognise it.
        assert_eq!(
            preview_bytes(&[0x1b, b'[', b'0', b'm'], 100),
            "\"\\x1b[0m\""
        );
    }

    #[test]
    fn escapes_backslash_and_double_quote() {
        assert_eq!(preview_bytes(b"a\"b\\c", 100), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn truncates_with_suffix_when_over_limit() {
        let data = vec![b'x'; 250];
        let preview = preview_bytes(&data, 200);
        assert!(
            preview.ends_with("(+50 more bytes)"),
            "expected truncation suffix; got {preview:?}"
        );
        // 200 'x' chars between the surrounding quotes.
        assert!(preview.starts_with(&format!("\"{}\"", "x".repeat(200))));
    }

    #[test]
    fn reproduces_a_realistic_6_byte_pty_payload() {
        // The actual production failure: 6 bytes of stdout, no JSON. This
        // payload is a guess at them — "\\x1b[0m\\n" (ANSI reset + newline)
        // is 5 — and the preview has to let a human see it at a glance.
        // Adjust it if the real bytes turn out different; at least we
        // will know.
        let bytes = b"\x1b[0m\n";
        let preview = preview_bytes(bytes, 200);
        assert_eq!(preview, "\"\\x1b[0m\\n\"");
    }
}
