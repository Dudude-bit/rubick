//! Pod exec terminal adapter - uses kube API to exec into pods
//!
//! # Why `tty: true` and `stderr: false`
//!
//! The apiserver rejects an exec request that asks for both: **tty and
//! stderr cannot both be true**. That is a Kubernetes API constraint, not
//! a choice this adapter makes.
//!
//! It is also the right shape. Without a TTY a shell prints no prompt,
//! echoes nothing back, buffers its output and loses line editing —
//! arrows and backspace stop working. With one, the PTY merges every
//! stream into stdout, so reading stdout alone is complete: zero bytes
//! read means the connection closed, and no bytes available means
//! nothing was typed, not that anything is wrong.
//!
//! # Why closing hangs the shell up
//!
//! Dropping the exec stream does not end the process it started. With a
//! TTY the container runtime keeps the shell's terminal open after the
//! client is gone, and the shell sits in the container for as long as the
//! container runs. So the shell announces its pid first thing, and closing
//! a session that is still running sends that pid a SIGHUP through a
//! second exec, the signal a terminal hanging up would have sent.
//!
//! # Why a stream that ends is asked how
//!
//! A shell that exits is reported in a status frame, the last thing on the
//! stream. A stream that closes without one was cut: a laptop that slept, a
//! VPN that dropped, an apiserver that restarted. The shell is still in the
//! container then, so that end is a failure the pane shows, and the shell is
//! hung up like any other that is still running.

use crate::error::{KubeErrorExt, Result};
use crate::terminal::session::SessionTarget;
use crate::terminal::TerminalAdapter;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::{
    api::{Api, AttachParams, AttachedProcess, TerminalSize},
    Client,
};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

/// The first thing the shell prints, ahead of its prompt: `ESC ] 777 ;
/// rubick-pid=<pid> BEL`. An OSC a terminal does not know is dropped by
/// it, so a mark that ever got through would draw nothing.
const PID_MARK: &[u8] = b"\x1b]777;rubick-pid=";
const PID_MARK_END: u8 = 0x07;
/// Long enough for the slowest exec to print its first line.
const PID_MARK_WAIT: Duration = Duration::from_secs(5);
/// How long a hang-up may take before the session lets go regardless.
const HANG_UP_WAIT: Duration = Duration::from_secs(5);
/// How long the stream gets to report the shell's exit after the hang-up.
const STREAM_END_WAIT: Duration = Duration::from_secs(3);
/// A hang-up that did not reach the cluster is sent again after each of these.
const HANG_UP_AGAIN: [Duration; 2] = [Duration::from_secs(5), Duration::from_secs(20)];
/// The status frame comes before the stream closes, so this is slack.
const STATUS_WAIT: Duration = Duration::from_millis(500);

const PICK_SHELL: &str = "if command -v fish >/dev/null 2>&1; then exec fish; elif command -v zsh >/dev/null 2>&1; then exec zsh; elif command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";

/// The exec command for a shell that says its pid before anything else.
///
/// `/bin/sh` prints the mark and then `exec`s the shell, which keeps the pid.
/// A named shell is passed as `$0`, never spliced into the script. The
/// terminal is set to the pane's size before the shell starts: busybox 1.36
/// prints a fresh prompt on every resize, and a pane that only said its size
/// once the shell was up opened on three of them.
#[must_use]
pub fn shell_command(shell: Option<&str>, size: Option<(u16, u16)>) -> Vec<String> {
    let mark = "printf '\\033]777;rubick-pid=%s\\007' \"$$\"";
    let size = size
        .map(|(cols, rows)| format!("stty cols {cols} rows {rows} 2>/dev/null; "))
        .unwrap_or_default();
    let mut command = vec!["/bin/sh".to_string(), "-c".to_string()];
    match shell {
        Some(shell) => {
            command.push(format!("{mark}; {size}exec \"$0\""));
            command.push(shell.to_string());
        }
        None => command.push(format!("{mark}; {size}{PICK_SHELL}")),
    }
    command
}

/// What hangs a shell up from outside it.
#[must_use]
pub fn hang_up_command(pid: u32) -> Vec<String> {
    vec![
        "/bin/sh".to_string(),
        "-c".to_string(),
        format!("kill -HUP {pid}"),
    ]
}

/// Where the pid mark stands in what the shell has printed so far.
#[derive(Debug, PartialEq, Eq)]
pub enum PidMark {
    /// Read, and taken out; `rest` is everything else, in order.
    Found { pid: Option<u32>, rest: Vec<u8> },
    /// The bytes so far could still be the start of the mark.
    Partial,
    /// Not there, and nothing more will make it so.
    Absent,
}

#[must_use]
pub fn split_pid_mark(bytes: &[u8]) -> PidMark {
    let Some(start) = bytes
        .windows(PID_MARK.len())
        .position(|window| window == PID_MARK)
    else {
        let tail = bytes.len().min(PID_MARK.len() - 1);
        let could_begin = (1..=tail).any(|n| bytes[bytes.len() - n..] == PID_MARK[..n]);
        return if bytes.is_empty() || could_begin {
            PidMark::Partial
        } else {
            PidMark::Absent
        };
    };
    let digits_from = start + PID_MARK.len();
    let Some(length) = bytes[digits_from..]
        .iter()
        .position(|&byte| byte == PID_MARK_END)
    else {
        return if bytes.len() - digits_from <= 10 {
            PidMark::Partial
        } else {
            PidMark::Absent
        };
    };
    let pid = std::str::from_utf8(&bytes[digits_from..digits_from + length])
        .ok()
        .and_then(|digits| digits.parse().ok());
    let mut rest = bytes[..start].to_vec();
    rest.extend_from_slice(&bytes[digits_from + length + 1..]);
    PidMark::Found { pid, rest }
}

/// How an exec stream ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamEnd {
    /// The server said the process exited.
    Exited,
    /// The stream closed and nothing said so: the connection was cut.
    Dropped,
}

impl StreamEnd {
    /// Read off the status the stream was to deliver before it closed.
    /// `None` is a status somebody already took, which is no word of an exit.
    async fn of(status: Option<impl std::future::Future<Output = Option<Status>>>) -> Self {
        let Some(status) = status else {
            return Self::Dropped;
        };
        match tokio::time::timeout(STATUS_WAIT, status).await {
            Ok(Some(_)) => Self::Exited,
            Ok(None) | Err(_) => Self::Dropped,
        }
    }

    /// What a read at the end of the stream answers: an exit is the quiet
    /// end of a session, a cut is a failure the reader is told about.
    fn read(self) -> Result<Option<Vec<u8>>> {
        match self {
            Self::Exited => Ok(None),
            Self::Dropped => Err(crate::error::Error::Terminal(
                "the connection closed before the shell exited".to_string(),
            )),
        }
    }
}

/// The shell to hang up on close: one that said its pid and has not exited.
/// A stream that was cut leaves it running.
fn to_hang_up(connected: bool, ended: Option<StreamEnd>, pid: Option<u32>) -> Option<u32> {
    pid.filter(|_| connected && ended != Some(StreamEnd::Exited))
}

/// `attempt` now, and again after each wait, until one gets through.
async fn until_reached<F>(waits: &[Duration], mut attempt: impl FnMut() -> F) -> bool
where
    F: std::future::Future<Output = bool>,
{
    if attempt().await {
        return true;
    }
    for wait in waits {
        tokio::time::sleep(*wait).await;
        if attempt().await {
            return true;
        }
    }
    false
}

/// A fresh client for the hang-up, which may come an hour after the connect.
pub type ClientSource = Box<dyn Fn() -> Option<Client> + Send + Sync>;

/// Adapter for executing shell in Kubernetes pods
pub struct PodExecAdapter {
    target: SessionTarget,
    command: Vec<String>,
    size: Option<(u16, u16)>,
    client: Client,
    fresh_client: Option<ClientSource>,
    attached: Option<AttachedProcess>,
    // Store streams separately since AttachedProcess.stdin()/stdout() consume via .take()
    stdin_writer: Option<Box<dyn AsyncWrite + Unpin + Send + Sync>>,
    stdout_reader: Option<Box<dyn AsyncRead + Unpin + Send + Sync>>,
    /// Where the pane's measurements go. `AttachedProcess` hands this over
    /// once, and only when the attach asked for a tty.
    resize_tx: Option<futures::channel::mpsc::Sender<TerminalSize>>,
    /// Read into, again and again: an idle shell is read every few
    /// milliseconds, and a fresh buffer each time was megabytes a second of
    /// allocation for nothing.
    read_buf: Vec<u8>,
    /// What the shell printed while the connect read its pid, for the first
    /// read to hand over.
    pending: Vec<u8>,
    /// The shell's pid in the container, once it has said.
    pid: Option<u32>,
    /// How the stream ended, once it has.
    ///
    /// Separate from `attached`, because "a connection was made" and "it is
    /// over" are different questions and only one of them changes when the
    /// shell exits. The manager learns both through the same `Ok(None)` —
    /// EOF and a quiet tick are indistinguishable to it — so `is_running` is
    /// the only place that can tell them apart, and without this it answered
    /// "still running" forever: the session task span on a 50ms tick, the
    /// entry stayed in the session map, and the pane went on drawing a
    /// terminal whose shell had exited.
    ended: Option<StreamEnd>,
}

impl PodExecAdapter {
    /// A shell in `target`'s container, the one named or the best it has, at
    /// the pane's size when the pane has said it.
    #[must_use]
    pub fn new(
        client: Client,
        target: SessionTarget,
        shell: Option<&str>,
        size: Option<(u16, u16)>,
    ) -> Self {
        Self {
            command: shell_command(shell, size),
            size,
            target,
            client,
            fresh_client: None,
            attached: None,
            stdin_writer: None,
            stdout_reader: None,
            resize_tx: None,
            read_buf: vec![0u8; crate::terminal::session::TERMINAL_BUFFER_SIZE],
            pending: Vec::new(),
            pid: None,
            ended: None,
        }
    }

    /// Where the hang-up gets its client, rather than the one the connect used.
    #[must_use]
    pub fn with_fresh_client(mut self, source: ClientSource) -> Self {
        self.fresh_client = Some(source);
        self
    }

    /// The shell to hang up on close, if there is one.
    #[must_use]
    pub fn hang_up_pid(&self) -> Option<u32> {
        to_hang_up(self.attached.is_some(), self.ended, self.pid)
    }

    async fn read_pid_mark(&mut self) {
        use tokio::io::AsyncReadExt;

        let Some(stdout) = self.stdout_reader.as_mut() else {
            return;
        };
        let deadline = tokio::time::Instant::now() + PID_MARK_WAIT;
        loop {
            let read = tokio::time::timeout_at(deadline, stdout.read(&mut self.read_buf)).await;
            match read {
                // Over before it said a pid; the first read asks how.
                Ok(Ok(0)) => return,
                Ok(Ok(n)) => self.pending.extend_from_slice(&self.read_buf[..n]),
                Ok(Err(_)) | Err(_) => break,
            }
            match split_pid_mark(&self.pending) {
                PidMark::Found { pid, rest } => {
                    self.pid = pid;
                    self.pending = rest;
                    return;
                }
                PidMark::Partial => {}
                PidMark::Absent => break,
            }
        }
        tracing::warn!(
            "{}/{}: the shell did not say its pid, so closing it cannot hang it up",
            self.target.pod,
            self.target.container
        );
    }

    /// Whether the hang-up reached the cluster, whatever the cluster made of it.
    async fn hang_up(&self, pid: u32) -> bool {
        use tokio::io::AsyncReadExt;

        let client = self
            .fresh_client
            .as_ref()
            .and_then(|source| source())
            .unwrap_or_else(|| self.client.clone());
        let api: Api<Pod> = Api::namespaced(client, &self.target.namespace);
        let params = AttachParams::default()
            .container(&self.target.container)
            .stdout(true)
            .stderr(false);
        let outcome = tokio::time::timeout(HANG_UP_WAIT, async {
            let mut process = api
                .exec(&self.target.pod, hang_up_command(pid), &params)
                .await?;
            let status = process.take_status();
            let mut stdout = process.stdout();
            let drain = async {
                if let Some(stdout) = stdout.as_mut() {
                    let mut sink = Vec::new();
                    let _ = stdout.read_to_end(&mut sink).await;
                }
            };
            let wait = async {
                match status {
                    Some(status) => status.await,
                    None => None,
                }
            };
            let ((), status) = tokio::join!(drain, wait);
            Ok::<_, kube::Error>(status)
        })
        .await;
        match outcome {
            Ok(Ok(Some(status))) if status.status.as_deref() == Some("Success") => true,
            Ok(Ok(status)) => {
                let reached = status.is_some();
                tracing::warn!(
                    "hanging up {}/{} pid {pid}: {:?}",
                    self.target.pod,
                    self.target.container,
                    status.and_then(|s| s.message)
                );
                reached
            }
            Ok(Err(error)) => {
                tracing::warn!(
                    "could not hang up {}/{} pid {pid}: {}",
                    self.target.pod,
                    self.target.container,
                    error.display_clean()
                );
                false
            }
            Err(_) => {
                tracing::warn!(
                    "hanging up {}/{} pid {pid} took longer than {}s",
                    self.target.pod,
                    self.target.container,
                    HANG_UP_WAIT.as_secs()
                );
                false
            }
        }
    }
}

#[async_trait::async_trait]
impl TerminalAdapter for PodExecAdapter {
    async fn connect(&mut self) -> Result<()> {
        use crate::commands::helpers::ResourceContext;

        let ctx = ResourceContext::from_client(self.client.clone(), self.target.namespace.clone());
        let api: Api<Pod> = ctx.namespaced_api();

        let attach_params = AttachParams::default()
            .stdin(true)
            .stdout(true)
            .stderr(false) // MUST be false when tty=true (Kubernetes API requirement)
            .tty(true) // CRITICAL: TTY must be true for interactive shells
            .container(&self.target.container);

        let mut attached = api
            .exec(&self.target.pod, &self.command, &attach_params)
            .await
            .map_err(|e| {
                crate::error::Error::Terminal(format!("Failed to exec: {}", e.display_clean()))
            })?;

        // Extract stdin and stdout writers/readers once and store them
        // This is critical - kube-rs AttachedProcess.stdin()/stdout() consume the values via .take()
        // We must call these methods ONCE and store the results
        self.stdin_writer = attached
            .stdin()
            .map(|w| Box::new(w) as Box<dyn AsyncWrite + Unpin + Send + Sync>);
        self.stdout_reader = attached
            .stdout()
            .map(|r| Box::new(r) as Box<dyn AsyncRead + Unpin + Send + Sync>);
        // Also a `.take()`, so once, and only present because `tty` is true.
        self.resize_tx = attached.terminal_size();
        if let (Some((cols, rows)), Some(tx)) = (self.size, self.resize_tx.as_mut()) {
            let _ = tx.try_send(TerminalSize {
                width: cols,
                height: rows,
            });
        }

        self.attached = Some(attached);
        // A reconnect is a new stream, and the old one having ended says
        // nothing about it.
        self.ended = None;
        self.pid = None;
        self.pending.clear();
        self.read_pid_mark().await;
        Ok(())
    }

    async fn read_output(&mut self) -> Result<Option<Vec<u8>>> {
        use tokio::io::AsyncReadExt;

        if !self.pending.is_empty() {
            return Ok(Some(std::mem::take(&mut self.pending)));
        }
        // With tty=true, all output comes through stdout (PTY behavior)
        // stderr is not used when TTY is enabled
        if let Some(stdout) = &mut self.stdout_reader {
            match tokio::time::timeout(
                std::time::Duration::from_millis(10),
                stdout.read(&mut self.read_buf),
            )
            .await
            {
                Ok(Ok(0)) => {
                    // EOF: the shell exited, or the connection was cut under it.
                    let end = if let Some(end) = self.ended {
                        end
                    } else {
                        let status = self
                            .attached
                            .as_mut()
                            .and_then(AttachedProcess::take_status);
                        StreamEnd::of(status).await
                    };
                    self.ended = Some(end);
                    end.read()
                }
                Ok(Ok(n)) => {
                    // Data available (n > 0)
                    Ok(Some(self.read_buf[..n].to_vec()))
                }
                Ok(Err(e)) => Err(crate::error::Error::Terminal(format!("Read error: {e}"))),
                Err(_) => {
                    // Timeout - no data available
                    Ok(None)
                }
            }
        } else {
            Ok(None)
        }
    }

    async fn write_input(&mut self, data: &[u8]) -> Result<()> {
        use tokio::io::AsyncWriteExt;

        let stdin = self.stdin_writer.as_mut().ok_or_else(|| {
            tracing::error!("PodExec: write_input called but stdin not available");
            crate::error::Error::Terminal("stdin not available".to_string())
        })?;

        tracing::debug!("PodExec: writing {} bytes to stdin", data.len());
        stdin.write_all(data).await.map_err(|e| {
            tracing::error!("PodExec: write_all failed: {}", e);
            crate::error::Error::Terminal(format!("Write failed: {e}"))
        })?;
        stdin.flush().await.map_err(|e| {
            tracing::error!("PodExec: flush failed: {}", e);
            crate::error::Error::Terminal(format!("Flush failed: {e}"))
        })?;
        tracing::debug!(
            "PodExec: successfully wrote and flushed {} bytes",
            data.len()
        );
        Ok(())
    }

    /// Tell the far end how wide the pane is.
    ///
    /// This threw the numbers away under a note saying kube could not do it;
    /// kube has sent resizes correctly since 0.89, and everything above here
    /// was already wired. A shell ran at the server's default geometry for
    /// its whole life.
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        use futures::SinkExt as _;

        let Some(tx) = self.resize_tx.as_mut() else {
            return Ok(());
        };
        tx.send(TerminalSize {
            width: cols,
            height: rows,
        })
        .await
        .map_err(|e| crate::error::Error::Terminal(format!("Resize failed: {e}")))
    }

    /// Hang the shell up, then let the stream end: the order matters, since
    /// the shell's exit is what the stream reports last.
    async fn close(&mut self) -> Result<()> {
        if let Some(pid) = self.hang_up_pid() {
            let this = &*self;
            if !until_reached(&HANG_UP_AGAIN, || this.hang_up(pid)).await {
                tracing::warn!(
                    "{}/{}: pid {pid} was not hung up and may still be running",
                    self.target.pod,
                    self.target.container
                );
            }
        }
        let ended = self
            .attached
            .as_mut()
            .and_then(AttachedProcess::take_status);
        self.stdin_writer = None;
        self.stdout_reader = None;
        self.resize_tx = None;
        if let Some(ended) = ended {
            let _ = tokio::time::timeout(STREAM_END_WAIT, ended).await;
        }
        self.attached = None;
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.attached.is_some() && self.ended.is_none()
    }

    fn target(&self) -> Option<SessionTarget> {
        Some(self.target.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Without the mark there is no pid, and without the pid closing the
    /// pane leaves the shell running in the container.
    #[test]
    fn the_shell_says_its_pid_before_anything_else() {
        let picked = shell_command(None, None);
        assert_eq!(picked[..2], ["/bin/sh", "-c"]);
        assert!(picked[2].starts_with("printf '\\033]777;rubick-pid=%s\\007' \"$$\"; "));
        assert!(picked[2].ends_with("else exec sh; fi"));

        let named = shell_command(Some("/bin/ash; reboot"), None);
        assert!(named[2].ends_with("; exec \"$0\""));
        assert_eq!(
            named[3], "/bin/ash; reboot",
            "a named shell is an argument, not script"
        );
    }

    /// Lena's Shell opened on three prompts: busybox drew one for the start
    /// and one for each resize the pane sent after it. Fails if the shell
    /// starts before the terminal has the pane's size.
    #[test]
    fn the_shell_starts_at_the_size_of_the_pane() {
        let picked = shell_command(None, Some((132, 41)));
        let script = &picked[2];
        let stty = script
            .find("stty cols 132 rows 41 2>/dev/null; ")
            .expect("the size is set");
        assert!(stty < script.find("exec").expect("a shell"));
        assert!(script.find("rubick-pid").expect("the mark") < stty);

        let named = shell_command(Some("bash"), Some((80, 24)));
        assert!(named[2].ends_with("stty cols 80 rows 24 2>/dev/null; exec \"$0\""));
        assert!(!shell_command(None, None)[2].contains("stty"));
    }

    /// A laptop that slept left a pane saying "Ended" over a shell still in
    /// the container: a stream that closed was taken for a shell that exited.
    /// Only the server's status frame says the process is gone.
    #[tokio::test]
    async fn a_stream_that_closes_without_a_status_was_cut_and_is_not_an_exit() {
        let exited = Status {
            status: Some("Success".into()),
            ..Status::default()
        };
        let said = StreamEnd::of(Some(std::future::ready(Some(exited)))).await;
        let cut = StreamEnd::of(Some(std::future::ready(None))).await;
        let taken = StreamEnd::of(None::<std::future::Ready<Option<Status>>>).await;

        assert_eq!(said, StreamEnd::Exited);
        assert_eq!(cut, StreamEnd::Dropped);
        assert_eq!(taken, StreamEnd::Dropped);
    }

    /// A status that never comes is no word of an exit either, and the read
    /// that asks must not wait on it forever.
    #[tokio::test]
    async fn a_status_that_never_arrives_is_not_waited_on() {
        let never = std::future::pending::<Option<Status>>();
        assert_eq!(StreamEnd::of(Some(never)).await, StreamEnd::Dropped);
    }

    /// The pane has to say the connection dropped, with a way to reconnect,
    /// and say nothing but "Ended" for a shell that exited.
    #[test]
    fn a_cut_stream_is_a_failure_the_pane_can_retry_and_an_exit_is_not() {
        use crate::state::StreamFailureKind;

        assert!(matches!(StreamEnd::Exited.read(), Ok(None)));
        let cut = StreamEnd::Dropped.read().expect_err("a cut is a failure");
        assert_eq!(StreamFailureKind::classify(&cut), StreamFailureKind::Broken);
    }

    /// The shell whose stream was cut is the one left in the container, so
    /// it is the one closing has to hang up; one that exited has no pid left.
    #[test]
    fn a_shell_whose_stream_was_cut_is_hung_up_and_one_that_exited_is_not() {
        assert_eq!(
            to_hang_up(true, Some(StreamEnd::Dropped), Some(45)),
            Some(45)
        );
        assert_eq!(to_hang_up(true, None, Some(45)), Some(45));
        assert_eq!(to_hang_up(true, Some(StreamEnd::Exited), Some(45)), None);
        assert_eq!(to_hang_up(false, None, Some(45)), None);
        assert_eq!(to_hang_up(true, Some(StreamEnd::Dropped), None), None);
    }

    /// A connection that dropped is usually still down when the hang-up is
    /// first sent. Fails if one refusal is the end of it, or if a hang-up
    /// that got through is sent again.
    #[tokio::test]
    async fn a_hang_up_that_did_not_get_through_is_sent_again_until_one_does() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let waits = [Duration::from_millis(1); 2];
        let sends = |through_on: usize| async move {
            let sent = AtomicUsize::new(0);
            let reached = until_reached(&waits, || {
                let nth = sent.fetch_add(1, Ordering::SeqCst) + 1;
                async move { nth == through_on }
            })
            .await;
            (reached, sent.load(Ordering::SeqCst))
        };

        assert_eq!(sends(1).await, (true, 1));
        assert_eq!(sends(3).await, (true, 3));
        assert_eq!(sends(usize::MAX).await, (false, 1 + waits.len()));
    }

    /// The hang-up is the signal a closed terminal sends, to that pid alone.
    #[test]
    fn the_hang_up_signals_the_shell_it_was_told() {
        assert_eq!(hang_up_command(4242), ["/bin/sh", "-c", "kill -HUP 4242"]);
    }

    /// The pane must never see the mark, and nothing around it may be lost.
    #[test]
    fn the_mark_is_taken_out_of_what_the_shell_printed() {
        assert_eq!(
            split_pid_mark(b"\x1b]777;rubick-pid=45\x07/srv/app # "),
            PidMark::Found {
                pid: Some(45),
                rest: b"/srv/app # ".to_vec()
            }
        );
        assert_eq!(
            split_pid_mark(b"motd\r\n\x1b]777;rubick-pid=7\x07$ "),
            PidMark::Found {
                pid: Some(7),
                rest: b"motd\r\n$ ".to_vec()
            }
        );
    }

    /// A read can end anywhere in the mark; the connect has to read on.
    #[test]
    fn a_mark_cut_by_a_read_is_waited_for() {
        assert_eq!(split_pid_mark(b""), PidMark::Partial);
        assert_eq!(split_pid_mark(b"\x1b]77"), PidMark::Partial);
        assert_eq!(split_pid_mark(b"\x1b]777;rubick-pid=12"), PidMark::Partial);
    }

    /// A shell that printed something else first is not waited on forever.
    #[test]
    fn output_that_cannot_be_the_mark_is_handed_over() {
        assert_eq!(
            split_pid_mark(b"sh: printf: not found\r\n"),
            PidMark::Absent
        );
        assert_eq!(
            split_pid_mark(b"\x1b]777;rubick-pid=123456789012345"),
            PidMark::Absent
        );
        assert_eq!(
            split_pid_mark(b"\x1b]777;rubick-pid=x\x07$ "),
            PidMark::Found {
                pid: None,
                rest: b"$ ".to_vec()
            }
        );
    }
}
