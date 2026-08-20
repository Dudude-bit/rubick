//! Auth exec process adapter — spawns the kubeconfig `exec` plugin under
//! a portable PTY so that interactive prompts (kubelogin password input,
//! `getpass`-style readers that check `isatty(stdin)`) actually appear
//! and accept input. Stdout+stderr are merged through the PTY master
//! into one byte stream, mirroring how a real terminal sees the process.

use crate::error::Result;
use crate::terminal::TerminalAdapter;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task;

/// Maximum stdout size to collect for JSON parsing (1MB).
/// The terminal stream itself is bounded by xterm scrollback, not this cap.
const MAX_STDOUT_SIZE: usize = 1024 * 1024;

/// PTY default size at spawn. The frontend sends a real resize as soon
/// as xterm measures itself, so this is just a sane initial value.
const INITIAL_COLS: u16 = 80;
const INITIAL_ROWS: u16 = 24;

/// Adapter for interactive auth-exec processes.
pub struct AuthExecAdapter {
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,

    /// PTY master, kept around so we can `resize`. Wrapped because both
    /// the async caller (resize) and Drop need access.
    master: Option<Arc<Mutex<Box<dyn MasterPty + Send>>>>,
    /// Sync writer to the PTY master, used from `spawn_blocking`.
    writer: Option<Arc<Mutex<Box<dyn Write + Send>>>>,
    /// Output bytes from the PTY, pushed by the reader thread.
    output_rx: Option<mpsc::UnboundedReceiver<Vec<u8>>>,
    /// Tells the wait-thread to stop polling and tear down. Becomes
    /// disconnected when the adapter is closed/dropped.
    _shutdown_tx: Option<mpsc::Sender<()>>,
    /// Liveness flag flipped by the wait-thread when the child exits.
    is_alive: Arc<std::sync::atomic::AtomicBool>,

    /// Last exit code returned by the child, populated by the wait
    /// thread on process termination. `None` while the child is
    /// alive or if waiting failed before the status was readable.
    /// Surfacing this to the auth flow is the only way to tell apart
    /// "plugin produced no JSON because it crashed with status 1" from
    /// "plugin produced no JSON because it exited 0 with empty output."
    last_exit_status: Arc<Mutex<Option<i32>>>,

    /// Collected output for `ExecCredential` JSON parsing. The PTY stream
    /// contains both prompts and the final JSON; downstream `serde_json`
    /// extracts the credential payload from the buffer's tail.
    collected_stdout: Arc<Mutex<Vec<u8>>>,
}

impl AuthExecAdapter {
    /// Create new auth exec adapter
    #[must_use]
    pub fn new(command: String, args: Vec<String>, env: HashMap<String, String>) -> Self {
        Self {
            command,
            args,
            env,
            master: None,
            writer: None,
            output_rx: None,
            _shutdown_tx: None,
            is_alive: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            last_exit_status: Arc::new(Mutex::new(None)),
            collected_stdout: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Get collected stdout (for JSON parsing after process completes).
    /// Synchronous lock — the auth flow grabs this once after the
    /// process exits, so contention is nil.
    #[must_use]
    pub fn collected_stdout(&self) -> Arc<Mutex<Vec<u8>>> {
        self.collected_stdout.clone()
    }

    /// Get a handle to the child's last exit status. `None` until the
    /// child has terminated. Used by the auth flow to enrich error
    /// messages when JSON extraction fails ("plugin exited 1 with 6
    /// bytes: \"foo\\n\\r\"" is debuggable; "no JSON" alone is not).
    #[must_use]
    pub fn last_exit_status(&self) -> Arc<Mutex<Option<i32>>> {
        self.last_exit_status.clone()
    }
}

#[async_trait::async_trait]
impl TerminalAdapter for AuthExecAdapter {
    async fn connect(&mut self) -> Result<()> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: INITIAL_ROWS,
                cols: INITIAL_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| crate::error::Error::Terminal(format!("openpty failed: {e}")))?;

        let mut cmd = CommandBuilder::new(&self.command);
        for arg in &self.args {
            cmd.arg(arg);
        }
        for (k, v) in &self.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| crate::error::Error::Terminal(format!("spawn failed: {e}")))?;

        // Drop the slave handle so EOF propagates on the master once
        // the child closes its side. Without this, reads block forever
        // even after the child exits.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| crate::error::Error::Terminal(format!("clone reader failed: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| crate::error::Error::Terminal(format!("take writer failed: {e}")))?;

        let (output_tx, output_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let collected = self.collected_stdout.clone();

        // Reader thread: blocking reads off the PTY master, tees into
        // the JSON collector, forwards to the async side via mpsc.
        // Lives until EOF (child exited and slave dropped).
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = vec![0u8; crate::terminal::session::TERMINAL_BUFFER_SIZE];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        {
                            let mut c = collected.lock();
                            if c.len() + data.len() <= MAX_STDOUT_SIZE {
                                c.extend_from_slice(&data);
                            } else if c.len() < MAX_STDOUT_SIZE {
                                let remaining = MAX_STDOUT_SIZE - c.len();
                                c.extend_from_slice(&data[..remaining]);
                            }
                        }
                        if output_tx.send(data).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Wait thread: blocks on child.wait() so we can flip is_alive
        // when the process exits, without polling try_wait every tick.
        // We also capture the exit status so the auth flow can include
        // it in error messages when no JSON ExecCredential turned up.
        let (shutdown_tx, _shutdown_rx) = mpsc::channel::<()>(1);
        self.is_alive
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let alive = self.is_alive.clone();
        let exit_handle = self.last_exit_status.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            if let Ok(s) = status {
                let mut slot = exit_handle.lock();
                *slot = Some(s.exit_code() as i32);
            }
            alive.store(false, std::sync::atomic::Ordering::SeqCst);
        });

        self.master = Some(Arc::new(Mutex::new(pair.master)));
        self.writer = Some(Arc::new(Mutex::new(writer)));
        self.output_rx = Some(output_rx);
        self._shutdown_tx = Some(shutdown_tx);

        Ok(())
    }

    async fn read_output(&mut self) -> Result<Option<Vec<u8>>> {
        let rx = match self.output_rx.as_mut() {
            Some(rx) => rx,
            None => return Ok(None),
        };

        // Short timeout matches the manager's 50ms read tick — it lets
        // the I/O loop interleave with input and cancel checks.
        match tokio::time::timeout(std::time::Duration::from_millis(10), rx.recv()).await {
            Ok(Some(data)) => Ok(Some(data)),
            Ok(None) => Ok(None), // sender dropped: child exited
            Err(_) => Ok(None),   // timeout: no bytes this tick
        }
    }

    async fn write_input(&mut self, data: &[u8]) -> Result<()> {
        let writer = self
            .writer
            .as_ref()
            .ok_or_else(|| crate::error::Error::Terminal("PTY not connected".to_string()))?
            .clone();
        let data = data.to_vec();

        task::spawn_blocking(move || -> std::io::Result<()> {
            let mut w = writer.lock();
            w.write_all(&data)?;
            w.flush()
        })
        .await
        .map_err(|e| crate::error::Error::Terminal(format!("write join failed: {e}")))?
        .map_err(|e| crate::error::Error::Terminal(format!("PTY write failed: {e}")))?;

        Ok(())
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        let master = match self.master.as_ref() {
            Some(m) => m.clone(),
            None => return Ok(()),
        };

        task::spawn_blocking(move || {
            let m = master.lock();
            m.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
        })
        .await
        .map_err(|e| crate::error::Error::Terminal(format!("resize join failed: {e}")))?
        .map_err(|e| crate::error::Error::Terminal(format!("PTY resize failed: {e}")))?;

        Ok(())
    }

    async fn close(&mut self) -> Result<()> {
        // Drop the writer first so the child sees stdin EOF.
        self.writer = None;
        // Drop the master to close the PTY — this triggers EOF on the
        // reader and the reader thread exits naturally.
        self.master = None;
        self._shutdown_tx = None;

        // Drain any buffered output so callers that read after close
        // don't block on a closed-empty channel.
        if let Some(mut rx) = self.output_rx.take() {
            rx.close();
            while rx.recv().await.is_some() {}
        }

        Ok(())
    }

    fn is_running(&self) -> bool {
        self.is_alive.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Drain `read_output` into a single buffer until either the
    /// process stops emitting for several ticks (and is no longer
    /// running), or `total_timeout` elapses. Used to assert what the
    /// terminal would see across the full lifetime of a short command.
    async fn drain(adapter: &mut AuthExecAdapter, total_timeout: Duration) -> Vec<u8> {
        let mut out = Vec::new();
        let deadline = tokio::time::Instant::now() + total_timeout;
        let mut idle_ticks = 0;
        while tokio::time::Instant::now() < deadline {
            match adapter.read_output().await {
                Ok(Some(chunk)) => {
                    out.extend_from_slice(&chunk);
                    idle_ticks = 0;
                }
                Ok(None) => {
                    idle_ticks += 1;
                    if idle_ticks > 10 && !adapter.is_running() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(_) => break,
            }
        }
        out
    }

    #[tokio::test]
    async fn read_output_returns_stdout_to_terminal() {
        // Many OIDC drivers (kubelogin --grant-type=authcode-keyboard,
        // some `kubectl-oidc_login` builds) write the "open this URL"
        // prompt to stdout. PTY merges stdout+stderr into one stream,
        // so this should arrive whole.
        let mut adapter = AuthExecAdapter::new(
            "/bin/sh".into(),
            vec!["-c".into(), "printf STDOUT_PROMPT".into()],
            HashMap::new(),
        );

        adapter.connect().await.expect("spawn");
        let drained = drain(&mut adapter, Duration::from_secs(2)).await;
        adapter.close().await.expect("close");

        let text = String::from_utf8_lossy(&drained);
        assert!(
            text.contains("STDOUT_PROMPT"),
            "stdout was not delivered to terminal; got {text:?}"
        );
    }

    #[tokio::test]
    async fn read_output_still_returns_stderr() {
        let mut adapter = AuthExecAdapter::new(
            "/bin/sh".into(),
            vec!["-c".into(), "printf STDERR_LINE 1>&2".into()],
            HashMap::new(),
        );

        adapter.connect().await.expect("spawn");
        let drained = drain(&mut adapter, Duration::from_secs(2)).await;
        adapter.close().await.expect("close");

        let text = String::from_utf8_lossy(&drained);
        assert!(
            text.contains("STDERR_LINE"),
            "stderr regressed; got {text:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn child_runs_under_a_real_tty() {
        // The whole reason we adopted portable-pty: tools like kubelogin
        // call term.ReadPassword / getpass which check isatty(stdin) and
        // refuse to prompt without a real terminal. `tty` exits 0 and
        // prints the device name when stdin is a terminal, exits non-zero
        // and prints "not a tty" otherwise. If we ever regress to pipes,
        // this test goes red.
        let mut adapter = AuthExecAdapter::new(
            "/bin/sh".into(),
            vec!["-c".into(), "tty".into()],
            HashMap::new(),
        );

        adapter.connect().await.expect("spawn");
        let drained = drain(&mut adapter, Duration::from_secs(2)).await;
        adapter.close().await.expect("close");

        let text = String::from_utf8_lossy(&drained);
        assert!(
            !text.contains("not a tty"),
            "child saw a pipe, not a tty; got {text:?}"
        );
        assert!(
            text.contains("/dev/"),
            "expected tty device path in output; got {text:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn child_inherits_parent_process_env() {
        // `portable_pty::CommandBuilder::new` ships an *empty*
        // environment by default. Without inheriting the parent
        // process env, kubectl exec-credential plugins (oidc-login,
        // kubelogin, etc.) lose HOME/USER/XDG_CACHE_HOME and bail
        // out before printing their `ExecCredential` JSON — the
        // user sees "expected value at line 2 column 1" from
        // serde_json because the buffer is empty or contains an
        // error message instead of JSON.
        //
        // This test pins inheritance by setting a recognisable
        // marker on the test process env and asserting the child
        // can see it. If a future refactor accidentally clears env
        // again, the assertion catches it.
        let marker_value = format!("auth-exec-env-marker-{}", std::process::id());
        // SAFETY: tests run single-threaded enough for this; the
        // marker is unique per test process.
        unsafe {
            std::env::set_var("AUTH_EXEC_ENV_PROBE", &marker_value);
        }

        let mut adapter = AuthExecAdapter::new(
            "/bin/sh".into(),
            vec![
                "-c".into(),
                "printf 'PROBE=%s' \"$AUTH_EXEC_ENV_PROBE\"".into(),
            ],
            HashMap::new(),
        );

        adapter.connect().await.expect("spawn");
        let drained = drain(&mut adapter, Duration::from_secs(2)).await;
        adapter.close().await.expect("close");

        let text = String::from_utf8_lossy(&drained);
        let expected = format!("PROBE={marker_value}");
        assert!(
            text.contains(&expected),
            "child did not inherit AUTH_EXEC_ENV_PROBE; got {text:?}, expected substring {expected:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_env_overrides_inherited_env() {
        // If the caller passes an explicit value for an env var that
        // also exists in the parent process, the explicit value wins.
        // This matches how `auth/interactive/exec.rs` overrides PATH
        // to prepend our kubectl shim directory.
        unsafe {
            std::env::set_var("AUTH_EXEC_OVERRIDE_PROBE", "from-parent");
        }

        let mut env = HashMap::new();
        env.insert(
            "AUTH_EXEC_OVERRIDE_PROBE".to_string(),
            "from-explicit".to_string(),
        );

        let mut adapter = AuthExecAdapter::new(
            "/bin/sh".into(),
            vec![
                "-c".into(),
                "printf 'OVERRIDE=%s' \"$AUTH_EXEC_OVERRIDE_PROBE\"".into(),
            ],
            env,
        );

        adapter.connect().await.expect("spawn");
        let drained = drain(&mut adapter, Duration::from_secs(2)).await;
        adapter.close().await.expect("close");

        let text = String::from_utf8_lossy(&drained);
        assert!(
            text.contains("OVERRIDE=from-explicit"),
            "explicit env did not override inherited value; got {text:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn last_exit_status_captures_zero_for_clean_exit() {
        // After the child exits successfully, `last_exit_status` must
        // return Some(0). Before this lands, the wait thread did
        // `let _ = child.wait()` and threw the status on the floor —
        // making it impossible for the auth flow to tell apart
        // "plugin exited 0 with empty stdout" from "plugin crashed
        // with a non-zero status and a tiny error message".
        let mut adapter = AuthExecAdapter::new(
            "/bin/sh".into(),
            vec!["-c".into(), "exit 0".into()],
            HashMap::new(),
        );
        let status_handle = adapter.last_exit_status();

        adapter.connect().await.expect("spawn");
        let _ = drain(&mut adapter, Duration::from_secs(2)).await;
        // Give the wait thread a tick to record the exit before close.
        tokio::time::sleep(Duration::from_millis(100)).await;
        adapter.close().await.expect("close");

        let status = *status_handle.lock();
        assert_eq!(
            status,
            Some(0),
            "expected Some(0) after clean exit, got {status:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn last_exit_status_captures_nonzero_exit_code() {
        // Plugins like kubectl-oidc_login fail with non-zero exit
        // codes when env preconditions aren't met. We need to surface
        // that to the user. `exit 42` produces status 42.
        let mut adapter = AuthExecAdapter::new(
            "/bin/sh".into(),
            vec!["-c".into(), "exit 42".into()],
            HashMap::new(),
        );
        let status_handle = adapter.last_exit_status();

        adapter.connect().await.expect("spawn");
        let _ = drain(&mut adapter, Duration::from_secs(2)).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        adapter.close().await.expect("close");

        let status = *status_handle.lock();
        assert_eq!(
            status,
            Some(42),
            "expected Some(42) after exit 42, got {status:?}"
        );
    }

    #[tokio::test]
    async fn collected_stdout_still_captures_json_payload() {
        // The auth flow downstream parses JSON ExecCredential from
        // `collected_stdout()`. PTY-tee'ing must NOT break that path.
        let mut adapter = AuthExecAdapter::new(
            "/bin/sh".into(),
            vec!["-c".into(), "printf '{\"kind\":\"ExecCredential\"}'".into()],
            HashMap::new(),
        );
        let collected_handle = adapter.collected_stdout();

        adapter.connect().await.expect("spawn");
        let _ = drain(&mut adapter, Duration::from_secs(2)).await;
        adapter.close().await.expect("close");

        let collected = collected_handle.lock();
        let text = String::from_utf8_lossy(&collected);
        assert!(
            text.contains("\"kind\":\"ExecCredential\""),
            "collected_stdout lost the JSON payload; got {text:?}"
        );
    }
}
