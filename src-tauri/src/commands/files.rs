//! Files inside a container: list, preview, download. Read-only by design.

use std::time::{Duration, Instant};

use tauri::State;
use tokio::sync::oneshot;

use crate::error::{Error, Result};

/// How long a preview may take before it is given up on. A FIFO or a device
/// node never ends on its own.
const PREVIEW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
use crate::files::{self, Exit, FilePreview, Listing, Via};
use crate::state::{AppEvent, AppState, LogStream, RemoveOnDrop};
use crate::utils::normalize_optional_namespace;

const SUBSCRIBE_TIMEOUT: Duration = Duration::from_mins(1);

fn check_path(path: &str) -> Result<()> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err(Error::InvalidInput(format!(
            "a container path is absolute and has no NUL: {path:?}"
        )));
    }
    Ok(())
}

fn check_via(via: Option<&Via>) -> Result<()> {
    if let Some(v) = via {
        crate::validation::validate_dns_label(&v.container)?;
        check_path(&v.root)?;
    }
    Ok(())
}

fn current_client(state: &State<'_, AppState>) -> Result<kube::Client> {
    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;
    let client = state
        .client_manager
        .get_client(&context)
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLIENT.to_string()))?;
    Ok((*client).clone())
}

/// Why a listing ended without rows, in words the frontend switches on.
fn failure_reason(error: &Error) -> &'static str {
    if error.is_refusal() {
        "refused"
    } else if matches!(error, Error::KubeApi(kube::Error::Api(r)) if r.code == 400 || r.code == 404)
    {
        // The API answers 400 for a container that is not running and 404
        // for a pod that is gone; both mean there is nothing to exec into.
        "notRunning"
    } else {
        "failed"
    }
}

/// Start listing one directory; rows arrive as `files-batch` events and the
/// end as exactly one `files-done` or `files-failed`.
#[tauri::command]
pub async fn list_container_files(
    pod: String,
    namespace: Option<String>,
    container: String,
    path: String,
    via: Option<Via>,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_dns_label(&pod)?;
    crate::validation::validate_dns_label(&container)?;
    check_path(&path)?;
    check_via(via.as_ref())?;
    let namespace = normalize_optional_namespace(namespace).unwrap_or_else(|| "default".into());
    let client = current_client(&state)?;

    let stream_id = crate::utils::generate_id("files");
    let event_tx = state.event_tx.clone();
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let (subscribe_tx, subscribe_rx) = oneshot::channel::<()>();
    let streams = state.log_streams.clone();
    streams.insert(
        stream_id.clone(),
        LogStream {
            id: stream_id.clone(),
            pod: pod.clone(),
            container: container.clone(),
            namespace: namespace.clone(),
            cancel_tx,
            subscribe_tx: Some(subscribe_tx),
        },
    );

    let id = stream_id.clone();
    tokio::spawn(async move {
        let _cleanup = RemoveOnDrop {
            map: streams,
            key: id.clone(),
        };
        let started = tokio::select! {
            biased;
            _ = &mut cancel_rx => false,
            subscribed = subscribe_rx => subscribed.is_ok(),
            () = tokio::time::sleep(SUBSCRIBE_TIMEOUT) => true,
        };
        if !started {
            return;
        }
        let began = Instant::now();
        let emit_batch = |entries: Vec<files::FileEntry>| {
            let _ = event_tx.send(AppEvent::FilesBatch {
                stream_id: id.clone(),
                entries,
            });
        };
        let outcome = files::list_dir(
            client,
            files::Target {
                namespace: &namespace,
                pod: &pod,
                container: &container,
                via: via.as_ref(),
                path: &path,
            },
            emit_batch,
            &mut cancel_rx,
        )
        .await;
        let elapsed_ms = began.elapsed().as_millis() as u64;
        let terminal = match outcome {
            Ok(Listing::Listed {
                with,
                entries,
                partial,
                unreadable,
            }) => AppEvent::FilesDone {
                stream_id: id.clone(),
                with,
                entries,
                partial,
                unreadable,
                elapsed_ms,
            },
            // No code, and no sentence. A rung counts as missing on `exit
            // 127` *or* on the runtime's own "executable file not found",
            // which carries no code at all — so `Some(127)` was a number
            // this side made up. The words are built from `tried` on the
            // other side, where a scanner can see them.
            Ok(Listing::NoTools { tried }) => AppEvent::FilesFailed {
                stream_id: id.clone(),
                reason: "noTools".into(),
                message: String::new(),
                exit_code: None,
                stderr: String::new(),
                tried,
            },
            // Our own script's exit 2. The words are the frontend's; this
            // side carries only which of the ladder's contracts was hit.
            Ok(Listing::Unopenable) => AppEvent::FilesFailed {
                stream_id: id.clone(),
                reason: "unopenable".into(),
                message: String::new(),
                exit_code: None,
                stderr: String::new(),
                tried: Vec::new(),
            },
            Ok(Listing::Failed { exit, stderr }) => AppEvent::FilesFailed {
                stream_id: id.clone(),
                reason: "failed".into(),
                message: exit
                    .message
                    .clone()
                    .unwrap_or_else(|| stderr.trim().to_string()),
                exit_code: exit.code,
                stderr,
                tried: Vec::new(),
            },
            Err(error) => AppEvent::FilesFailed {
                stream_id: id.clone(),
                reason: failure_reason(&error).into(),
                message: error.to_string(),
                exit_code: None,
                stderr: String::new(),
                tried: Vec::new(),
            },
        };
        let _ = event_tx.send(terminal);
    });

    Ok(stream_id)
}

/// The frontend's listener is up; let the rows flow.
#[tauri::command]
pub fn files_subscribed(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some(mut entry) = state.log_streams.get_mut(&stream_id) {
        if let Some(tx) = entry.subscribe_tx.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

/// Stop a listing that is still arriving. What arrived stays.
#[tauri::command]
pub fn stop_files_listing(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some((_, stream)) = state.log_streams.remove(&stream_id) {
        let _ = stream.cancel_tx.send(());
    }
    Ok(())
}

/// How a read of one file ended when it did not end in bytes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum FileRead {
    Preview {
        preview: FilePreview,
    },
    /// A download landed. Its own variant because a download reads no
    /// bytes into memory: reporting it as a `Preview` meant answering
    /// "is it binary" and "how much of it is not text" about a file
    /// nothing had looked at, with a confident `false` and `0.0`.
    Written {
        bytes: u64,
    },
    /// The tool is not in the image.
    NoTools,
    /// The tool ran and refused.
    Failed {
        exit_code: Option<i32>,
        message: String,
    },
}

fn read_outcome(result: std::result::Result<FilePreview, Exit>) -> FileRead {
    match result {
        Ok(preview) => FileRead::Preview { preview },
        Err(exit) if exit.tool_missing() => FileRead::NoTools,
        Err(exit) => FileRead::Failed {
            exit_code: exit.code,
            message: exit.message.unwrap_or_default(),
        },
    }
}

/// The first megabyte of a file, or why not.
#[tauri::command]
pub async fn read_container_file(
    pod: String,
    namespace: Option<String>,
    container: String,
    path: String,
    via: Option<Via>,
    state: State<'_, AppState>,
) -> Result<FileRead> {
    crate::validation::validate_dns_label(&pod)?;
    crate::validation::validate_dns_label(&container)?;
    check_path(&path)?;
    check_via(via.as_ref())?;
    let namespace = normalize_optional_namespace(namespace).unwrap_or_else(|| "default".into());
    let client = current_client(&state)?;
    // A preview that can never finish — a FIFO nobody writes to, a device
    // that blocks — left the panel on "reading…" for as long as the tab was
    // open and leaked the exec session. Every other read here that can hang
    // is bounded; this one was not.
    let result = tokio::time::timeout(
        PREVIEW_TIMEOUT,
        files::read_preview(client, &namespace, &pod, &container, via.as_ref(), &path),
    )
    .await
    .map_err(|_| {
        Error::Timeout(format!(
            "reading {path} took longer than {}s and was given up on",
            PREVIEW_TIMEOUT.as_secs()
        ))
    })??;
    Ok(read_outcome(result))
}

/// Copy one file to a path the person chose. Nothing is written into the
/// container; nothing over the cap is written anywhere.
#[tauri::command]
pub async fn download_container_file(
    pod: String,
    namespace: Option<String>,
    container: String,
    path: String,
    via: Option<Via>,
    destination: String,
    state: State<'_, AppState>,
) -> Result<FileRead> {
    crate::validation::validate_dns_label(&pod)?;
    crate::validation::validate_dns_label(&container)?;
    check_path(&path)?;
    check_via(via.as_ref())?;
    let namespace = normalize_optional_namespace(namespace).unwrap_or_else(|| "default".into());
    let client = current_client(&state)?;
    let written = files::download(
        client,
        &namespace,
        &pod,
        &container,
        via.as_ref(),
        &path,
        std::path::Path::new(&destination),
    )
    .await?;
    Ok(match written {
        Ok(bytes) => FileRead::Written { bytes },
        Err(exit) => read_outcome(Err(exit)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_into_a_container_is_absolute() {
        assert!(check_path("/etc/app").is_ok());
        assert!(check_path("etc/app").is_err());
        assert!(check_path("/etc\0app").is_err());
    }

    /// The listing's own rule, applied to a file: a missing `head` is not a
    /// file that could not be read.
    #[test]
    fn a_missing_tool_is_reported_as_such_and_not_as_a_failed_file() {
        let missing = read_outcome(Err(Exit {
            code: Some(127),
            missing_binary: false,
            message: None,
        }));
        assert!(matches!(missing, FileRead::NoTools));
        let denied = read_outcome(Err(Exit {
            code: Some(1),
            missing_binary: false,
            message: Some("head: /root/x: Permission denied".into()),
        }));
        assert!(matches!(
            denied,
            FileRead::Failed {
                exit_code: Some(1),
                ..
            }
        ));
    }
}
