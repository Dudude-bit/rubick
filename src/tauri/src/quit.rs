//! The way out, however the app is asked to go: its window, a logout, a
//! shutdown, `kill`, or Ctrl+C in the terminal that started it. A Windows
//! session ending reaches `RunEvent::Exit` through the window, not here.

use std::sync::Arc;
use std::time::Duration;

use crate::client::K8sClientManager;
use crate::state::AppState;
use crate::terminal::TerminalManager;

/// How long quitting waits for the shells to hang up.
const SHELLS_WITHIN: Duration = Duration::from_secs(6);

/// What has to end with the app or it outlives the window: a `kubectl proxy`
/// serving the cluster on loopback, and a shell in a container nobody can reach.
pub struct WayOut {
    clients: Arc<K8sClientManager>,
    terminals: Arc<TerminalManager>,
}

impl WayOut {
    #[must_use]
    pub fn of(state: &AppState) -> Self {
        Self {
            clients: state.client_manager.clone(),
            terminals: state.terminal_manager.clone(),
        }
    }

    pub async fn take(&self) {
        self.clients.shutdown_proxies();
        self.terminals.close_all(SHELLS_WITHIN).await;
    }
}

/// The signals that ask the app to stop.
#[cfg(unix)]
pub struct Termination {
    term: tokio::signal::unix::Signal,
    int: tokio::signal::unix::Signal,
    hup: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Termination {
    /// Once this returns they are heard here instead of ending the process outright.
    pub fn listen() -> std::io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            term: signal(SignalKind::terminate())?,
            int: signal(SignalKind::interrupt())?,
            hup: signal(SignalKind::hangup())?,
        })
    }

    /// The first one to arrive.
    pub async fn arrived(mut self) -> &'static str {
        tokio::select! {
            _ = self.term.recv() => "SIGTERM",
            _ = self.int.recv() => "SIGINT",
            _ = self.hup.recv() => "SIGHUP",
        }
    }
}

/// The console events that ask the app to stop.
#[cfg(windows)]
pub struct Termination {
    ctrl_c: tokio::signal::windows::CtrlC,
    ctrl_break: tokio::signal::windows::CtrlBreak,
    ctrl_close: tokio::signal::windows::CtrlClose,
}

#[cfg(windows)]
impl Termination {
    /// Once this returns they are heard here instead of ending the process outright.
    pub fn listen() -> std::io::Result<Self> {
        use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close};
        Ok(Self {
            ctrl_c: ctrl_c()?,
            ctrl_break: ctrl_break()?,
            ctrl_close: ctrl_close()?,
        })
    }

    /// The first one to arrive.
    pub async fn arrived(mut self) -> &'static str {
        tokio::select! {
            _ = self.ctrl_c.recv() => "CTRL_C_EVENT",
            _ = self.ctrl_break.recv() => "CTRL_BREAK_EVENT",
            _ = self.ctrl_close.recv() => "CTRL_CLOSE_EVENT",
        }
    }
}

/// When asked to stop: the way out quitting from the window takes, then `exit`.
pub async fn quit_on(termination: Termination, way_out: WayOut, exit: impl FnOnce(&'static str)) {
    let heard = termination.arrived().await;
    tracing::info!(signal = heard, "asked to quit; ending every shell first");
    way_out.take().await;
    exit(heard);
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::terminal::{SessionTarget, TerminalAdapter};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::broadcast;

    /// A shell in a container that takes a moment to hang up.
    struct Shell {
        hung_up: Arc<AtomicBool>,
    }

    #[async_trait::async_trait]
    impl TerminalAdapter for Shell {
        async fn connect(&mut self) -> crate::Result<()> {
            Ok(())
        }
        async fn read_output(&mut self) -> crate::Result<Option<Vec<u8>>> {
            tokio::time::sleep(Duration::from_millis(5)).await;
            Ok(None)
        }
        async fn write_input(&mut self, _data: &[u8]) -> crate::Result<()> {
            Ok(())
        }
        async fn resize(&mut self, _cols: u16, _rows: u16) -> crate::Result<()> {
            Ok(())
        }
        async fn close(&mut self) -> crate::Result<()> {
            tokio::time::sleep(Duration::from_millis(100)).await;
            self.hung_up.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn is_running(&self) -> bool {
            !self.hung_up.load(Ordering::SeqCst)
        }
        fn target(&self) -> Option<SessionTarget> {
            Some(SessionTarget {
                context: "acme-staging".into(),
                namespace: "shop".into(),
                pod: "cart-667846ff79-4f68h".into(),
                container: "app".into(),
            })
        }
    }

    /// Dana sent SIGTERM with a shell open in cart-667846ff79-4f68h and `sh`
    /// ran on in the pod seven minutes later. Fails if a signal ends the app
    /// without hanging every shell up first.
    #[tokio::test]
    async fn a_logout_a_kill_or_ctrl_c_hangs_every_shell_up_before_the_app_exits() {
        for (signal, name) in [
            (libc::SIGTERM, "SIGTERM"),
            (libc::SIGINT, "SIGINT"),
            (libc::SIGHUP, "SIGHUP"),
        ] {
            let (event_tx, _event_rx) = broadcast::channel(64);
            let terminals = Arc::new(TerminalManager::new(event_tx));
            let hung_up = Arc::new(AtomicBool::new(false));
            let id = terminals
                .create_session(Box::new(Shell {
                    hung_up: hung_up.clone(),
                }))
                .expect("a shell");
            terminals.mark_subscribed(&id).expect("subscribed");
            let way_out = WayOut {
                clients: Arc::new(K8sClientManager::new()),
                terminals: terminals.clone(),
            };

            let termination = Termination::listen().expect("listening");
            let (exited, exit) = tokio::sync::oneshot::channel();
            let quitting = tokio::spawn(quit_on(termination, way_out, move |heard| {
                let _ = exited.send((heard, hung_up.load(Ordering::SeqCst)));
            }));
            // SAFETY: `listen` has replaced the signal's default action.
            assert_eq!(unsafe { libc::raise(signal) }, 0);

            let (heard, hung_up_first) = tokio::time::timeout(Duration::from_secs(5), exit)
                .await
                .unwrap_or_else(|_| panic!("{name} never reached the way out"))
                .expect("the way out called exit");
            assert_eq!(heard, name);
            assert!(hung_up_first, "{name} exited with the shell still running");
            assert_eq!(terminals.session_count(), 0);
            quitting.await.expect("the way out finished");
        }
    }
}
