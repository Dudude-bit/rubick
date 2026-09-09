//! `kubectl proxy` as the second way in.
//!
//! When the app's own credential path fails — an exec plugin it cannot run,
//! a token the cluster will not take — kubectl on the same machine often
//! still works, because kubectl runs the plugin itself and keeps the token
//! fresh. So the fallback is to let it: start `kubectl proxy` on a loopback
//! port, and talk to the cluster through that, with no credentials of our
//! own at all.

use std::net::TcpListener;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::shell::get_user_path;

/// How long the proxy gets to answer `/version` before it is given up on.
const READY_WITHIN: Duration = Duration::from_secs(20);
/// The most of the proxy's own output kept for the report.
const OUTPUT_CAP: usize = 8 * 1024;

/// A running `kubectl proxy`, killed when dropped.
pub struct KubectlProxy {
    child: Child,
    pub port: u16,
    pub kubectl: String,
    stdout: Arc<Mutex<String>>,
    stderr: Arc<Mutex<String>>,
}

/// Why a proxy did not come up, with everything kubectl said.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyFailure {
    pub error: String,
    pub stdout: String,
    pub stderr: String,
}

impl KubectlProxy {
    /// The address a client talks to.
    #[must_use]
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    #[must_use]
    pub fn stderr(&self) -> String {
        self.stderr.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Start `kubectl proxy` for one context and wait until it answers.
    ///
    /// `kubeconfig` is what the app itself read, handed over as `KUBECONFIG`
    /// so kubectl resolves the same context from the same files. Empty means
    /// kubectl's own defaults, which are also the app's.
    pub async fn start(
        kubectl: &str,
        context: &str,
        kubeconfig: &[std::path::PathBuf],
    ) -> std::result::Result<Self, ProxyFailure> {
        let port = free_port().map_err(|e| ProxyFailure {
            error: format!("no free loopback port: {e}"),
            stdout: String::new(),
            stderr: String::new(),
        })?;

        let mut cmd = Command::new(kubectl);
        cmd.arg("--context")
            .arg(context)
            .arg("proxy")
            .arg("--address")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let user_path = get_user_path();
        if !user_path.is_empty() {
            cmd.env("PATH", user_path);
        }
        if !kubeconfig.is_empty() {
            let joined = std::env::join_paths(kubeconfig).map_err(|e| ProxyFailure {
                error: format!("kubeconfig paths cannot be joined for kubectl: {e}"),
                stdout: String::new(),
                stderr: String::new(),
            })?;
            cmd.env("KUBECONFIG", joined);
        }

        let mut child = cmd.spawn().map_err(|e| ProxyFailure {
            error: format!("could not start {kubectl}: {e}"),
            stdout: String::new(),
            stderr: String::new(),
        })?;

        let stdout = Arc::new(Mutex::new(String::new()));
        let stderr = Arc::new(Mutex::new(String::new()));
        if let Some(out) = child.stdout.take() {
            tokio::spawn(capture(out, stdout.clone()));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(capture(err, stderr.clone()));
        }

        let mut proxy = Self {
            child,
            port,
            kubectl: kubectl.to_string(),
            stdout,
            stderr,
        };
        match proxy.wait_ready().await {
            Ok(()) => Ok(proxy),
            Err(error) => {
                let _ = proxy.child.start_kill();
                // The reader on the pipe needs a moment to drain what the
                // exiting process said; the report is worth it.
                tokio::time::sleep(Duration::from_millis(100)).await;
                Err(ProxyFailure {
                    error,
                    stdout: proxy.stdout.lock().map(|s| s.clone()).unwrap_or_default(),
                    stderr: proxy.stderr(),
                })
            }
        }
    }

    /// `/version` through the proxy, which proves both that the proxy is up
    /// and that kubectl's credentials are accepted behind it.
    async fn wait_ready(&mut self) -> std::result::Result<(), String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("{}/version", self.url());
        let started = tokio::time::Instant::now();
        let mut last = String::from("no answer yet");
        while started.elapsed() < READY_WITHIN {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!("kubectl proxy exited: {status}"));
            }
            match http.get(&url).send().await {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) => {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    last = format!("{status}: {}", body.trim());
                }
                Err(e) => last = e.to_string(),
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(format!(
            "kubectl proxy did not answer /version within {}s (last: {last})",
            READY_WITHIN.as_secs()
        ))
    }
}

impl Drop for KubectlProxy {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

async fn capture(pipe: impl tokio::io::AsyncRead + Unpin, into: Arc<Mutex<String>>) {
    let mut lines = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(mut buf) = into.lock() {
            if buf.len() < OUTPUT_CAP {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
    }
}

/// A port the kernel says is free right now. The proxy binds it a moment
/// later; the race is real and small, and a lost race reads as "exited".
fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_free_port_is_on_the_loopback_ephemeral_range() {
        let port = free_port().expect("a port");
        assert!(port >= 1024);
    }

    /// A binary that is not there is the commonest failure, and the report
    /// must name it rather than time out twenty seconds later.
    #[tokio::test]
    async fn a_missing_kubectl_fails_at_once_with_the_reason() {
        let failed = KubectlProxy::start("/nonexistent/kubectl", "ctx", &[])
            .await
            .err()
            .expect("cannot start");
        assert!(failed.error.contains("could not start"), "{}", failed.error);
    }
}
