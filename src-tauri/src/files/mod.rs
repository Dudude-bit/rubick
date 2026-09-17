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
/// onto the reader's own file. Wide, because the exec channel is the only
/// slow part and the frontend asks before starting anything that large.
pub const DOWNLOAD_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Rows per event on the way to the frontend.
pub const BATCH_ROWS: usize = 500;
/// The most rows one listing hands over. Nothing capped this: `list_dir`
/// streamed every line the tool printed, and the frontend accumulated,
/// filtered and sorted all of it on the main thread. A directory past this
/// is answered as `partial`, never as though it were the whole of it.
pub const MAX_ENTRIES: usize = 20_000;

/// How long a download may go without a byte before it is given up on.
///
/// Not a bound on the whole read — 100 MiB over a slow link is a legitimate
/// several minutes — but on silence. `cat` on a FIFO, a character device or
/// a symlink into `/proc/self/fd` never reaches EOF, and with no bound the
/// loop never ended: the command's future never resolved, the exec session
/// stayed open on the apiserver, and the scratch file stayed in the folder
/// the reader had picked. Stock `nginx:alpine` ships such a file.
pub const DOWNLOAD_IDLE: std::time::Duration = std::time::Duration::from_secs(30);

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
        /// The listing did not run to the end — cut short by the reader or by
        /// `MAX_ENTRIES`. `entries` is then what was seen, never the total.
        partial: bool,
        /// Lines the parser could not read. Dropped silently, they made
        /// `entries` assert a completeness nothing had established.
        unreadable: usize,
    },
    /// Neither rung exists in this image.
    NoTools { tried: Vec<String> },
    /// The busybox rung's own `exit 2`, which it reaches only at its two
    /// guards: the path is not a directory, or this container may not open
    /// it. Its own outcome because the code is a contract we wrote, so the
    /// reader can be told what it means instead of "the listing did not
    /// finish: 2" over the apiserver's boilerplate.
    Unopenable,
    /// The tool ran and refused: no such directory, permission, …
    Failed { exit: Exit, stderr: String },
}

/// One line off the tool's stdout, or the fact that one could not be read.
///
/// The pump used to answer both with a `String` and drop the second case, so
/// a filename that is not valid UTF-8 — legal on any Linux filesystem, and
/// written verbatim by `find -printf %f` — left a listing that said it was
/// whole with a row missing from it.
enum Pumped {
    Line(String),
    Undecodable,
}

/// Whether a non-zero exit is the busybox rung's own guard rather than the
/// tool's. Only that rung writes `exit 2`, and only with nothing on stderr —
/// anything the tool said itself is a better answer than our sentence.
#[must_use]
fn unopenable(with: ListedWith, code: Option<i32>, stderr: &str) -> bool {
    with == ListedWith::BusyboxStat && code == Some(2) && stderr.trim().is_empty()
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
        let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<Pumped>(BATCH_ROWS);
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let pump = async {
                // A filename that is not valid UTF-8 makes `next_line`
                // return InvalidData. Stopping there ended the listing at
                // that entry and reported what had arrived as the whole
                // directory; skipping it keeps reading the rest — but
                // skipping it *silently* was the same lie one step later,
                // so the skip is sent on and counted like any other row
                // nobody could read.
                loop {
                    let pumped = match lines.next_line().await {
                        Ok(Some(line)) => Pumped::Line(line),
                        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                            Pumped::Undecodable
                        }
                        // End of stream, or the stream itself failing — and
                        // reading on past the latter would spin. Either way
                        // the exit status is what decides what happened.
                        Ok(None) | Err(_) => break,
                    };
                    if line_tx.send(pumped).await.is_err() {
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
        let mut unreadable = 0usize;
        let mut capped = false;
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
                        // A name the stream could not decode. There is no
                        // row to draw and no name to draw it under; what is
                        // left is that one is missing, which is what the
                        // tab is told.
                        Some(Pumped::Undecodable) => {
                            unreadable += 1;
                        }
                        Some(Pumped::Line(line)) => {
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
                                if total >= MAX_ENTRIES {
                                    capped = true;
                                    attached.abort();
                                    reader.abort();
                                    break;
                                }
                            } else {
                                // Counted, not shrugged off: a line nobody
                                // could read is a row missing from the answer.
                                unreadable += 1;
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
                partial: true,
                unreadable,
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
        if ended.ok() || capped {
            return Ok(Listing::Listed {
                with,
                entries: total,
                partial: capped,
                unreadable,
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
        if unopenable(with, ended.code, &stderr_text) {
            return Ok(Listing::Unopenable);
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
    /// The bytes were not valid UTF-8 and the text below is a repair, with
    /// every bad byte replaced by U+FFFD. Without this the reader is shown
    /// a file that differs from the one on disk and told it is the file.
    pub lossy: bool,
    /// The text, when it is text.
    pub text: Option<String>,
}

/// The bytes as text, and whether that cost anything.
///
/// `from_utf8_lossy` alone cannot tell a file with bad bytes in it from a
/// clean file whose last character the cap cut in half — both come back with
/// a U+FFFD in them. The half character is an artefact of our own reading, so
/// it is dropped; anything else is a real difference between what is on disk
/// and what the reader is looking at, and is reported.
#[must_use]
pub fn decode_text(bytes: &[u8], truncated: bool) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), false),
        Err(error) => {
            let good = error.valid_up_to();
            // `error_len() == None` means the input simply stops mid-character.
            let only_the_cut = truncated && error.error_len().is_none();
            if only_the_cut {
                // Valid by construction: `valid_up_to` is a boundary.
                (String::from_utf8_lossy(&bytes[..good]).into_owned(), false)
            } else {
                (String::from_utf8_lossy(bytes).into_owned(), true)
            }
        }
    }
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
        // The tool's own words win. The apiserver sets `Status.message` on
        // every non-zero exit ("command terminated with exit code 1"), so
        // `is_none()` was never true and the container's actual reason —
        // "Permission denied", "No such file or directory" — was thrown
        // away, leaving a refusal indistinguishable from any other failure.
        let said = captured.stderr.trim();
        if !said.is_empty() {
            exit.message = Some(said.to_string());
        }
        return Ok(Err(exit));
    }
    let mut bytes = captured.stdout;
    let truncated = bytes.len() > PREVIEW_MAX_BYTES;
    bytes.truncate(PREVIEW_MAX_BYTES);
    let sample = &bytes[..bytes.len().min(4096)];
    let share = non_text_share(sample);
    let binary = looks_binary(sample);
    let (text, lossy) = if binary {
        (None, false)
    } else {
        let (decoded, lossy) = decode_text(&bytes, truncated);
        (Some(decoded), lossy)
    };
    Ok(Ok(FilePreview {
        bytes_read: bytes.len(),
        truncated,
        binary,
        non_text_share: share,
        lossy,
        text,
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

/// The scratch file, removed on every way out but the one that renames it.
///
/// There are seven ways out of `download` before the rename — two deliberate
/// refusals and five `?`s — and each one that was not spelled out by hand
/// left a `.rubick-<uuid>.part` beside the file the reader had picked. A
/// guard cannot forget a path a `?` takes.
struct Scratch(Option<PathBuf>);

impl Scratch {
    fn path(&self) -> &Path {
        self.0.as_deref().unwrap_or(Path::new(""))
    }

    /// The bytes are good; the file is about to become the reader's.
    fn keep(&mut self) -> PathBuf {
        self.0.take().unwrap_or_default()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            // Blocking, and deliberately: a `Drop` cannot await, and this is
            // one unlink of a local file the process just created.
            let _ = std::fs::remove_file(path);
        }
    }
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

    // Declared before the handle, so the handle is dropped first and the
    // unlink is of a closed file — which is the only kind Windows removes.
    let mut scratch = Scratch(Some(scratch_beside(destination)));
    let mut file = tokio::fs::File::create(scratch.path()).await?;
    let mut written = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let Ok(read) = tokio::time::timeout(DOWNLOAD_IDLE, stdout.read(&mut buf)).await else {
            attached.abort();
            return Err(Error::Internal(format!(
                "nothing arrived for {}s; the file may be a pipe or a device rather than \
                 something with an end",
                DOWNLOAD_IDLE.as_secs()
            )));
        };
        let n = read.map_err(|e| Error::Internal(format!("exec stdout: {e}")))?;
        if n == 0 {
            break;
        }
        written += n as u64;
        if written > DOWNLOAD_MAX_BYTES {
            attached.abort();
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
        let mut exit = exit;
        let said = String::from_utf8_lossy(&err);
        let said = said.trim();
        if !said.is_empty() {
            exit.message = Some(said.to_string());
        }
        return Ok(Err(exit));
    }
    // Only now, on a confirmed exit 0, does the reader's file change.
    drop(file);
    tokio::fs::rename(scratch.keep(), destination).await?;
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

    /// The other half of `shared/file-limits.json`. A comment saying
    /// "mirrored" is not a check: these three numbers are applied on both
    /// sides of the IPC boundary, and the download cap used to be spelled
    /// three times with nothing holding them equal.
    #[test]
    fn the_caps_match_the_shared_file() {
        const LIMITS: &str = include_str!("../../../shared/file-limits.json");
        let shared: serde_json::Value = serde_json::from_str(LIMITS).expect("valid json");
        assert_eq!(
            shared["downloadMaxBytes"].as_u64(),
            Some(DOWNLOAD_MAX_BYTES)
        );
        assert_eq!(
            shared["previewMaxBytes"].as_u64(),
            Some(PREVIEW_MAX_BYTES as u64)
        );
        assert_eq!(shared["maxEntries"].as_u64(), Some(MAX_ENTRIES as u64));
    }

    /// `from_utf8_lossy` repairs a file silently: a byte the tool never wrote
    /// becomes U+FFFD and the reader is told they are looking at the file. A
    /// preview stopped mid-character by our own cap is a different thing and
    /// must not be reported as a difference. Fails if either arm is dropped.
    #[test]
    fn a_repaired_preview_says_it_was_repaired_and_a_cut_character_does_not() {
        let (text, lossy) = decode_text(b"port: 8080\n", false);
        assert_eq!(text, "port: 8080\n");
        assert!(!lossy, "clean ASCII is not a repair");

        // 0xff never appears in UTF-8.
        let (text, lossy) = decode_text(b"key=\xffvalue", false);
        assert!(lossy, "a byte no UTF-8 file contains is a repair");
        assert!(text.contains('\u{fffd}'));

        // "\u{43f}" is 0xd0 0xbf; the cap kept only the first byte.
        let (text, lossy) = decode_text(b"\xd0\xbf\xd0", true);
        assert_eq!(
            text, "\u{43f}",
            "the half character our cap made is dropped"
        );
        assert!(!lossy, "our own cut is not the file being different");

        // The same half byte with no cap in play is the file really ending
        // mid-character, and that is a repair.
        let (_, lossy) = decode_text(b"\xd0\xbf\xd0", false);
        assert!(lossy);
    }

    /// The rung's own `exit 2` is a contract this module wrote: it fires only
    /// at the two guards, so it can be named rather than shown to the reader
    /// as a number over the apiserver's "command terminated with exit code 2".
    /// A code the rung did not choose, or one with the tool's own words on
    /// stderr, stays an ordinary failure — those words are worth more than
    /// our sentence. Fails if the arm stops checking any of the three.
    #[test]
    fn the_rungs_own_refusal_is_told_apart_from_a_tool_that_failed() {
        assert!(unopenable(ListedWith::BusyboxStat, Some(2), ""));
        assert!(
            !unopenable(ListedWith::GnuFind, Some(2), ""),
            "find did not write our guard and its 2 means something else"
        );
        assert!(
            !unopenable(ListedWith::BusyboxStat, Some(1), ""),
            "only 2 is the guard"
        );
        assert!(
            !unopenable(ListedWith::BusyboxStat, Some(2), "stat: Permission denied"),
            "the tool's own words beat ours"
        );
    }
}
