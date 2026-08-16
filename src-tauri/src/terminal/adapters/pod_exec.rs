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

use crate::error::Result;
use crate::terminal::TerminalAdapter;
use k8s_openapi::api::core::v1::Pod;
use kube::{api::AttachedProcess, Client};
use tokio::io::{AsyncRead, AsyncWrite};

/// Adapter for executing shell in Kubernetes pods
pub struct PodExecAdapter {
    namespace: String,
    pod: String,
    container: String,
    command: Vec<String>,
    client: Client,
    attached: Option<AttachedProcess>,
    // Store streams separately since AttachedProcess.stdin()/stdout() consume via .take()
    stdin_writer: Option<Box<dyn AsyncWrite + Unpin + Send + Sync>>,
    stdout_reader: Option<Box<dyn AsyncRead + Unpin + Send + Sync>>,
}

impl PodExecAdapter {
    /// Create new pod exec adapter
    pub fn new(
        client: Client,
        namespace: String,
        pod: String,
        container: String,
        command: Vec<String>,
    ) -> Self {
        Self {
            namespace,
            pod,
            container,
            command,
            client,
            attached: None,
            stdin_writer: None,
            stdout_reader: None,
        }
    }
}

#[async_trait::async_trait]
impl TerminalAdapter for PodExecAdapter {
    async fn connect(&mut self) -> Result<()> {
        use crate::commands::helpers::ResourceContext;
        use kube::api::{Api, AttachParams};

        let ctx = ResourceContext::from_client(self.client.clone(), self.namespace.clone());
        let api: Api<Pod> = ctx.namespaced_api();

        let attach_params = AttachParams::default()
            .stdin(true)
            .stdout(true)
            .stderr(false) // MUST be false when tty=true (Kubernetes API requirement)
            .tty(true) // CRITICAL: TTY must be true for interactive shells
            .container(&self.container);

        let mut attached = api
            .exec(&self.pod, &self.command, &attach_params)
            .await
            .map_err(|e| crate::error::Error::Terminal(format!("Failed to exec: {e}")))?;

        // Extract stdin and stdout writers/readers once and store them
        // This is critical - kube-rs AttachedProcess.stdin()/stdout() consume the values via .take()
        // We must call these methods ONCE and store the results
        self.stdin_writer = attached
            .stdin()
            .map(|w| Box::new(w) as Box<dyn AsyncWrite + Unpin + Send + Sync>);
        self.stdout_reader = attached
            .stdout()
            .map(|r| Box::new(r) as Box<dyn AsyncRead + Unpin + Send + Sync>);

        self.attached = Some(attached);
        Ok(())
    }

    async fn read_output(&mut self) -> Result<Option<Vec<u8>>> {
        use tokio::io::AsyncReadExt;

        let mut buf = vec![0u8; crate::terminal::session::TERMINAL_BUFFER_SIZE];

        // With tty=true, all output comes through stdout (PTY behavior)
        // stderr is not used when TTY is enabled
        if let Some(stdout) = &mut self.stdout_reader {
            match tokio::time::timeout(std::time::Duration::from_millis(10), stdout.read(&mut buf))
                .await
            {
                Ok(Ok(0)) => {
                    // EOF - connection closed
                    Ok(None)
                }
                Ok(Ok(n)) => {
                    // Data available (n > 0)
                    Ok(Some(buf[..n].to_vec()))
                }
                Ok(Err(e)) => {
                    // Read error
                    Err(crate::error::Error::Terminal(format!("Read error: {e}")))
                }
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

    async fn resize(&mut self, _cols: u16, _rows: u16) -> Result<()> {
        // kube exec doesn't support resize currently
        // This is a known limitation - PTY resize would require kube API extension
        Ok(())
    }

    async fn close(&mut self) -> Result<()> {
        self.stdin_writer = None;
        self.stdout_reader = None;
        self.attached = None;
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.attached.is_some()
    }
}
