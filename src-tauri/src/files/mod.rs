//! Files inside a running container, read and never written.
//!
//! Every level of the tree is one `exec`, without a TTY, with stdout and
//! stderr kept apart and the exit status read: `exit 127` is "the tool is
//! not in this image", which must never be drawn as an empty directory.
//! The listing goes down a ladder — GNU `find`, then a `sh` loop over
//! busybox `stat`, then nothing — and the reader is told which rung
//! answered, or that none did and a debug container would.

pub mod parse;

use std::path::{Path, PathBuf};

use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::api::{Api, AttachParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::error::{Error, Result};
pub use parse::{FileEntry, FileKind};

/// A preview stops here; a text file longer than this is a download.
///
/// Half the IPC budget, not all of it: the whole preview comes back in one
/// command reply, and at exactly `maxMessageBytes` a reply carrying any
/// envelope at all is over it. See `shared/ipc-budget.json`.
pub const PREVIEW_MAX_BYTES: usize = 512 * 1024;
/// The cap a download is cut off at — counted as the bytes arrive, into a
/// scratch file beside the destination, so nothing over it is ever renamed
/// onto the reader's own file.
pub const DOWNLOAD_MAX_BYTES: u64 = 100 * 1024 * 1024;
/// Rows per event on the way to the frontend.
pub const BATCH_ROWS: usize = 500;

/// Reading through an ephemeral debug container: its name, and where the
/// target container's root shows up in it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Via {
    pub container: String,
    /// `/proc/1/root` with a shared process namespace.
    pub root: String,
}

/// Which rung of the ladder answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ListedWith {
    GnuFind,
    BusyboxStat,
}

/// How an exec ended, read from the status channel and not guessed.
#[derive(Debug, Clone, Default)]
pub struct Exit {
    pub code: Option<i32>,
    /// The runtime could not start the command at all: not on `PATH`.
    pub missing_binary: bool,
    pub message: Option<String>,
}

impl Exit {
    /// True on `exit 127` from a shell and on the runtime's own refusal.
    #[must_use]
    pub fn tool_missing(&self) -> bool {
        self.missing_binary || self.code == Some(127)
    }

    #[must_use]
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

/// The exit an API `Status` describes.
#[must_use]
pub fn exit_of(status: Option<Status>) -> Exit {
    let Some(status) = status else {
        return Exit {
            code: None,
            missing_binary: false,
            message: None,
        };
    };
    if status.status.as_deref() == Some("Success") {
        return Exit {
            code: Some(0),
            missing_binary: false,
            message: None,
        };
    }
    let code = status
        .details
        .as_ref()
        .and_then(|d| d.causes.as_ref())
        .and_then(|causes| {
            causes
                .iter()
                .find(|c| c.reason.as_deref() == Some("ExitCode"))
                .and_then(|c| c.message.as_deref())
                .and_then(|m| m.trim().parse::<i32>().ok())
        });
    let message = status.message.clone();
    let text = message.clone().unwrap_or_default().to_lowercase();
    let missing_binary = text.contains("executable file not found")
        || text.contains("no such file or directory")
        || text.contains("command not found");
    Exit {
        code,
        missing_binary,
        message,
    }
}

pub struct Captured {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit: Exit,
}

fn attach_params(container: &str) -> AttachParams {
    AttachParams::default()
        .stdin(false)
        .stdout(true)
        .stderr(true)
        .tty(false)
        .container(container)
}

/// Run one command to completion and keep everything it said.
pub async fn exec_capture(
    client: Client,
    namespace: &str,
    pod: &str,
    container: &str,
    command: &[String],
) -> Result<Captured> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let mut attached = api.exec(pod, command, &attach_params(container)).await?;
    let mut stdout = attached
        .stdout()
        .ok_or_else(|| Error::Internal("exec opened without a stdout channel".to_string()))?;
    let mut stderr = attached
        .stderr()
        .ok_or_else(|| Error::Internal("exec opened without a stderr channel".to_string()))?;
    let status = attached.take_status();

    let mut out = Vec::new();
    let mut err = Vec::new();
    let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
    a.map_err(|e| Error::Internal(format!("exec stdout: {e}")))?;
    b.map_err(|e| Error::Internal(format!("exec stderr: {e}")))?;
    let exit = exit_of(match status {
        Some(future) => future.await,
        None => None,
    });
    Ok(Captured {
        stdout: out,
        stderr: String::from_utf8_lossy(&err).into_owned(),
        exit,
    })
}

/// Where a path lives when read through a debug container.
#[must_use]
pub fn effective_path(path: &str, via: Option<&Via>) -> String {
    match via {
        Some(v) => format!("{}{}", v.root.trim_end_matches('/'), path),
        None => path.to_string(),
    }
}

/// The container the exec goes to.
#[must_use]
pub fn effective_container<'a>(container: &'a str, via: Option<&'a Via>) -> &'a str {
    via.map_or(container, |v| v.container.as_str())
}

/// GNU find, every entry one level down, tab-separated, one line each.
#[must_use]
pub fn gnu_find_command(path: &str) -> Vec<String> {
    vec![
        "find".into(),
        path.into(),
        "-mindepth".into(),
        "1".into(),
        "-maxdepth".into(),
        "1".into(),
        "-printf".into(),
        parse::GNU_FORMAT.into(),
    ]
}

/// A shell loop over busybox `stat`, for images without GNU find.
#[must_use]
pub fn busybox_stat_command(path: &str) -> Vec<String> {
    vec![
        "sh".into(),
        "-c".into(),
        parse::BUSYBOX_SCRIPT.into(),
        "sh".into(),
        path.into(),
    ]
}

/// One directory in one container, reached directly or through a debug container.
#[derive(Debug, Clone)]
pub struct Target<'a> {
    pub namespace: &'a str,
    pub pod: &'a str,
    pub container: &'a str,
    pub via: Option<&'a Via>,
    pub path: &'a str,
}

/// What a listing attempt came to.
pub enum Listing {
    Listed {
        with: ListedWith,
        entries: usize,
    },
    /// Neither rung exists in this image.
    NoTools {
        tried: Vec<String>,
    },
    /// The tool ran and refused: no such directory, permission, …
    Failed {
        exit: Exit,
        stderr: String,
    },
}

/// List one directory, handing entries out in batches as they arrive.
///
/// The ladder is walked here: a rung whose binary is missing is not a
/// failure of the directory, so the next rung is tried; anything else the
/// tool said is the answer.
pub async fn list_dir(
    client: Client,
    at: Target<'_>,
    mut emit: impl FnMut(Vec<FileEntry>),
    cancel: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<Listing> {
    let Target {
        namespace,
        pod,
        container,
        via,
        path,
    } = at;
    let target = effective_path(path, via);
    let exec_in = effective_container(container, via);
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let mut tried = Vec::new();

    for (with, command) in [
        (ListedWith::GnuFind, gnu_find_command(&target)),
        (ListedWith::BusyboxStat, busybox_stat_command(&target)),
    ] {
        tried.push(command[0].clone());
        let mut attached = api.exec(pod, &command, &attach_params(exec_in)).await?;
        let stdout = attached
            .stdout()
            .ok_or_else(|| Error::Internal("exec opened without a stdout channel".to_string()))?;
        let mut stderr = attached
            .stderr()
            .ok_or_else(|| Error::Internal("exec opened without a stderr channel".to_string()))?;
        let status = attached.take_status();

        // Both streams are read by one task, together, the way `exec_capture`
        // does: the multiplexer writes them through small buffers and stalls
        // on whichever nobody is draining. Lines come out through a channel.
        let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<String>(BATCH_ROWS);
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let pump = async {
                // A filename that is not valid UTF-8 makes `next_line`
                // return InvalidData. Stopping there ended the listing at
                // that entry and reported what had arrived as the whole
                // directory; skipping the line keeps reading the rest.
                loop {
                    let line = match lines.next_line().await {
                        Ok(Some(line)) => line,
                        Ok(None) => break,
                        Err(_) => continue,
                    };
                    if line_tx.send(line).await.is_err() {
                        break;
                    }
                }
            };
            let mut err = Vec::new();
            let drain = async {
                let _ = stderr.read_to_end(&mut err).await;
            };
            tokio::join!(pump, drain);
            err
        });

        let mut batch = Vec::new();
        let mut total = 0usize;
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(100));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut cancelled = false;
        loop {
            tokio::select! {
                biased;
                _ = &mut *cancel => {
                    cancelled = true;
                    attached.abort();
                    reader.abort();
                    break;
                }
                _ = ticker.tick() => {
                    if !batch.is_empty() {
                        emit(std::mem::take(&mut batch));
                    }
                }
                next = line_rx.recv() => {
                    match next {
                        Some(line) => {
                            let parsed = match with {
                                ListedWith::GnuFind => parse::gnu_find_line(&line),
                                ListedWith::BusyboxStat => parse::busybox_stat_line(&line),
                            };
                            if let Some(entry) = parsed {
                                total += 1;
                                batch.push(entry);
                                if batch.len() >= BATCH_ROWS {
                                    emit(std::mem::take(&mut batch));
                                }
                            }
                        }
                        None => break,
                    }
                }
            }
        }
        if cancelled {
            // The rows already parsed are the reader's answer to a listing
            // they cut short; dropping the tail batch threw away up to
            // BATCH_ROWS of them.
            if !batch.is_empty() {
                emit(batch);
            }
            return Ok(Listing::Listed {
                with,
                entries: total,
            });
        }
        if !batch.is_empty() {
            emit(batch);
        }
        let err = reader.await.unwrap_or_default();
        let stderr_text = String::from_utf8_lossy(&err).into_owned();
        let ended = exit_of(match status {
            Some(future) => future.await,
            None => None,
        });
        if ended.ok() {
            return Ok(Listing::Listed {
                with,
                entries: total,
            });
        }
        // GNU find in name only: busybox find rejects `-printf` and says so
        // on stderr with exit 1, which is the next rung's cue, not a failure.
        let rejected_flag = stderr_text.contains("unrecognized")
            || stderr_text.contains("bad arg")
            || stderr_text.contains("printf");
        if ended.tool_missing() || (with == ListedWith::GnuFind && rejected_flag && total == 0) {
            continue;
        }
        return Ok(Listing::Failed {
            exit: ended,
            stderr: stderr_text,
        });
    }
    Ok(Listing::NoTools { tried })
}

/// What a preview holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    /// Bytes actually read, capped at `PREVIEW_MAX_BYTES`.
    pub bytes_read: usize,
    /// The file goes on past what was read.
    pub truncated: bool,
    pub binary: bool,
    /// Share of the first 4 KiB that is not text, 0..1.
    pub non_text_share: f32,
    /// The text, when it is text.
    pub text: Option<String>,
}

/// Non-text bytes in a sample: NUL, or control bytes that are not whitespace.
#[must_use]
pub fn non_text_share(sample: &[u8]) -> f32 {
    if sample.is_empty() {
        return 0.0;
    }
    let bad = sample
        .iter()
        .filter(|b| **b == 0 || (**b < 0x20 && !matches!(**b, b'\t' | b'\n' | b'\r' | 0x0c)))
        .count();
    bad as f32 / sample.len() as f32
}

#[must_use]
pub fn looks_binary(sample: &[u8]) -> bool {
    sample.contains(&0) || non_text_share(sample) > 0.3
}

/// The first megabyte, and whether there is more.
pub async fn read_preview(
    client: Client,
    namespace: &str,
    pod: &str,
    container: &str,
    via: Option<&Via>,
    path: &str,
) -> Result<std::result::Result<FilePreview, Exit>> {
    let target = effective_path(path, via);
    let command = vec![
        "head".to_string(),
        "-c".to_string(),
        (PREVIEW_MAX_BYTES + 1).to_string(),
        target,
    ];
    let captured = exec_capture(
        client,
        namespace,
        pod,
        effective_container(container, via),
        &command,
    )
    .await?;
    if !captured.exit.ok() {
        let mut exit = captured.exit;
        if exit.message.is_none() && !captured.stderr.is_empty() {
            exit.message = Some(captured.stderr.trim().to_string());
        }
        return Ok(Err(exit));
    }
    let mut bytes = captured.stdout;
    let truncated = bytes.len() > PREVIEW_MAX_BYTES;
    bytes.truncate(PREVIEW_MAX_BYTES);
    let sample = &bytes[..bytes.len().min(4096)];
    let share = non_text_share(sample);
    let binary = looks_binary(sample);
    Ok(Ok(FilePreview {
        bytes_read: bytes.len(),
        truncated,
        binary,
        non_text_share: share,
        text: if binary {
            None
        } else {
            Some(String::from_utf8_lossy(&bytes).into_owned())
        },
    }))
}

/// Copy one file out, byte for byte, refusing past the cap.
/// A scratch path beside the destination, so the rename onto it is atomic.
///
/// The destination itself is never opened until the bytes are known good.
/// `File::create` truncates, and both failure paths below delete — so a
/// container read that was refused, or whose exit was merely *unknown*, used
/// to destroy whatever the reader had picked in the save dialog. They agreed
/// to have that file replaced by the download, not to be left with nothing.
fn scratch_beside(destination: &Path) -> PathBuf {
    let mut name = destination.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".rubick-{}.part", uuid::Uuid::new_v4()));
    destination.with_file_name(name)
}

pub async fn download(
    client: Client,
    namespace: &str,
    pod: &str,
    container: &str,
    via: Option<&Via>,
    path: &str,
    destination: &Path,
) -> Result<std::result::Result<u64, Exit>> {
    let target = effective_path(path, via);
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let command = vec!["cat".to_string(), target];
    let mut attached = api
        .exec(
            pod,
            &command,
            &attach_params(effective_container(container, via)),
        )
        .await?;
    let mut stdout = attached
        .stdout()
        .ok_or_else(|| Error::Internal("exec opened without a stdout channel".to_string()))?;
    let mut stderr = attached
        .stderr()
        .ok_or_else(|| Error::Internal("exec opened without a stderr channel".to_string()))?;
    let status = attached.take_status();

    let scratch = scratch_beside(destination);
    let mut file = tokio::fs::File::create(&scratch).await?;
    let mut written = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = stdout
            .read(&mut buf)
            .await
            .map_err(|e| Error::Internal(format!("exec stdout: {e}")))?;
        if n == 0 {
            break;
        }
        written += n as u64;
        if written > DOWNLOAD_MAX_BYTES {
            attached.abort();
            drop(file);
            let _ = tokio::fs::remove_file(&scratch).await;
            return Err(Error::InvalidInput(format!(
                "the file is over {} MiB; downloads that large are refused",
                DOWNLOAD_MAX_BYTES / (1024 * 1024)
            )));
        }
        file.write_all(&buf[..n]).await?;
    }
    file.flush().await?;
    let mut err = Vec::new();
    let _ = stderr.read_to_end(&mut err).await;
    let exit = exit_of(match status {
        Some(future) => future.await,
        None => None,
    });
    if !exit.ok() {
        drop(file);
        let _ = tokio::fs::remove_file(&scratch).await;
        let mut exit = exit;
        if exit.message.is_none() && !err.is_empty() {
            exit.message = Some(String::from_utf8_lossy(&err).trim().to_string());
        }
        return Ok(Err(exit));
    }
    // Only now, on a confirmed exit 0, does the reader's file change.
    drop(file);
    tokio::fs::rename(&scratch, destination).await?;
    Ok(Ok(written))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};

    fn failure(reason: &str, message: &str, code: Option<&str>) -> Status {
        Status {
            status: Some("Failure".into()),
            reason: Some(reason.into()),
            message: Some(message.into()),
            details: code.map(|c| StatusDetails {
                causes: Some(vec![StatusCause {
                    reason: Some("ExitCode".into()),
                    message: Some(c.into()),
                    field: None,
                }]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// A missing tool answered as "empty directory" is the one lie this
    /// feature exists to not tell.
    #[test]
    fn a_missing_binary_is_never_a_success() {
        let runtime = exit_of(Some(failure(
            "InternalError",
            "OCI runtime exec failed: exec: \"find\": executable file not found in $PATH",
            None,
        )));
        assert!(runtime.tool_missing());
        assert!(!runtime.ok());

        let shell = exit_of(Some(failure(
            "NonZeroExitCode",
            "command terminated with non-zero exit code",
            Some("127"),
        )));
        assert_eq!(shell.code, Some(127));
        assert!(shell.tool_missing());
    }

    #[test]
    fn success_and_ordinary_failure_read_as_themselves() {
        assert!(exit_of(Some(Status {
            status: Some("Success".into()),
            ..Default::default()
        }))
        .ok());
        let denied = exit_of(Some(failure(
            "NonZeroExitCode",
            "command terminated with non-zero exit code",
            Some("1"),
        )));
        assert_eq!(denied.code, Some(1));
        assert!(!denied.tool_missing());
        assert!(!denied.ok());
        // No status at all is unknown, not success.
        assert!(!exit_of(None).ok());
    }

    #[test]
    fn a_debug_container_reads_the_targets_root() {
        let via = Via {
            container: "debugger-x7k2".into(),
            root: "/proc/1/root".into(),
        };
        assert_eq!(
            effective_path("/etc/app", Some(&via)),
            "/proc/1/root/etc/app"
        );
        assert_eq!(effective_container("app", Some(&via)), "debugger-x7k2");
        assert_eq!(effective_path("/etc/app", None), "/etc/app");
    }

    #[test]
    fn binary_is_a_share_of_the_sample_not_one_odd_byte() {
        assert!(!looks_binary(b"listen = 0.0.0.0:8080\nworkers = 4\n"));
        assert!(looks_binary(b"\x7fELF\x02\x01\x01\x00\x00\x00"));
        let mostly_text = [b"plain text with one stray \x01 byte in it".as_slice()].concat();
        assert!(!looks_binary(&mostly_text));
        assert!(non_text_share(b"\x00\x00ab") > 0.4);
    }
}
