//! Files inside a container: list, preview, download. Read-only by design.

use std::time::Instant;

use tauri::State;

use crate::error::{Error, Result};

/// How long a preview may take before it is given up on. A FIFO or a device
/// node never ends on its own.
const PREVIEW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
use crate::files::{self, Exit, FilePreview, Listing, ListingFailure, Via};
use crate::state::streams::SUBSCRIBE_TIMEOUT;
use crate::state::{AppEvent, AppState};
use crate::utils::normalize_optional_namespace;

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
    Ok((*state.current_client()?).clone())
}

/// Why a listing ended without rows.
fn failure_reason(error: &Error) -> ListingFailure {
    if error.is_refusal() {
        ListingFailure::Refused
    } else if matches!(error, Error::KubeApi(kube::Error::Api(r)) if r.code == 400 || r.code == 404)
    {
        // The API answers 400 for a container that is not running and 404
        // for a pod that is gone; both mean there is nothing to exec into.
        ListingFailure::NotRunning
    } else {
        ListingFailure::Failed
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
    crate::validation::validate_name::<k8s_openapi::api::core::v1::Pod>(&pod)?;
    crate::validation::validate_dns_label(&container)?;
    check_path(&path)?;
    check_via(via.as_ref())?;
    let namespace = normalize_optional_namespace(namespace).unwrap_or_else(|| "default".into());
    let client = current_client(&state)?;

    let stream_id = crate::utils::generate_id("files");
    let event_tx = state.event_tx.clone();
    let opened = state.file_listings.open(stream_id.clone());

    let listing = ListingTarget {
        namespace,
        pod,
        container,
        path,
        via,
    };
    tokio::spawn(run_listing(
        opened,
        event_tx,
        client,
        listing,
        SUBSCRIBE_TIMEOUT,
    ));

    Ok(stream_id)
}

/// What one listing reads.
struct ListingTarget {
    namespace: String,
    pod: String,
    container: String,
    path: String,
    via: Option<Via>,
}

/// The listing task: the gate, the ladder, and exactly one terminal event.
async fn run_listing(
    mut opened: crate::state::streams::Opened,
    event_tx: tokio::sync::broadcast::Sender<AppEvent>,
    client: kube::Client,
    listing: ListingTarget,
    gate: std::time::Duration,
) {
    let id = opened.id.clone();
    if !opened.wait_for_subscriber(gate).await {
        // The terminal event on this path too: a listener that went up
        // and was then stopped waits on it, and events have no replay.
        let _ = event_tx.send(AppEvent::FilesDone {
            stream_id: id.clone(),
            with: None,
            entries: 0,
            partial: true,
            unreadable: 0,
            elapsed_ms: 0,
        });
        return;
    }
    let (cancel, _held) = opened.split();
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
            namespace: &listing.namespace,
            pod: &listing.pod,
            container: &listing.container,
            via: listing.via.as_ref(),
            path: &listing.path,
        },
        emit_batch,
        &cancel,
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
            with: Some(with),
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
            reason: ListingFailure::NoTools,
            message: String::new(),
            exit_code: None,
            stderr: String::new(),
            tried,
        },
        // Our own script's exit 2. The words are the frontend's; this
        // side carries only which of the ladder's contracts was hit.
        Ok(Listing::Unopenable) => AppEvent::FilesFailed {
            stream_id: id.clone(),
            reason: ListingFailure::Unopenable,
            message: String::new(),
            exit_code: None,
            stderr: String::new(),
            tried: Vec::new(),
        },
        Ok(Listing::Failed { exit, stderr }) => AppEvent::FilesFailed {
            stream_id: id.clone(),
            reason: ListingFailure::Failed,
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
            reason: failure_reason(&error),
            message: error.to_string(),
            exit_code: None,
            stderr: String::new(),
            tried: Vec::new(),
        },
    };
    let _ = event_tx.send(terminal);
}

/// The frontend's listener is up; let the rows flow.
#[tauri::command]
pub fn files_subscribed(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    let _ = state.file_listings.subscribed(&stream_id);
    Ok(())
}

/// Stop a listing that is still arriving. What arrived stays.
#[tauri::command]
pub fn stop_files_listing(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    let _ = state.file_listings.stop(&stream_id);
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
    crate::validation::validate_name::<k8s_openapi::api::core::v1::Pod>(&pod)?;
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

/// Writes a report the frontend composed to a path the reader picked.
///
/// The path came back from the save dialog, so it is the reader's own
/// choice and not a name from the cluster; what is validated is that this
/// is a write of text to a file, not a directory traversal built from a
/// resource name. Existing content is replaced, the way a save dialog's
/// "replace?" already promised.
#[tauri::command]
pub async fn write_text_file(destination: String, contents: String) -> Result<()> {
    let path = std::path::PathBuf::from(&destination);
    if path.is_dir() {
        return Err(Error::InvalidInput(format!(
            "{destination} is a directory, not a file"
        )));
    }
    std::fs::write(&path, contents.as_bytes())
        .map_err(|e| Error::InvalidInput(format!("could not write {destination}: {e}")))?;
    Ok(())
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
    crate::validation::validate_name::<k8s_openapi::api::core::v1::Pod>(&pod)?;
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

    /// A listing stopped before its listener was up still ends: listeners
    /// that went up and then asked it to stop wait on exactly one terminal
    /// event, and events have no replay. It says no rung ran, not which.
    #[tokio::test]
    async fn a_listing_stopped_before_it_starts_still_says_it_ended() {
        let streams = crate::state::streams::Streams::default();
        let opened = streams.open("files-1".into());
        let _ = streams.stop("files-1");
        let (event_tx, mut rx) = tokio::sync::broadcast::channel(8);
        let config = kube::Config::new("http://127.0.0.1:1".parse().expect("a uri"));
        crate::tls::provider();
        let client = kube::Client::try_from(config).expect("a client that never connects");
        let target = ListingTarget {
            namespace: "default".into(),
            pod: "p".into(),
            container: "c".into(),
            path: "/".into(),
            via: None,
        };

        run_listing(
            opened,
            event_tx,
            client,
            target,
            std::time::Duration::from_secs(5),
        )
        .await;

        match rx.try_recv().expect("a terminal event") {
            AppEvent::FilesDone {
                stream_id,
                with,
                partial,
                ..
            } => {
                assert_eq!(stream_id, "files-1");
                assert_eq!(with, None, "no rung ran");
                assert!(partial);
            }
            other => panic!("expected files-done, got {other:?}"),
        }
    }
}
