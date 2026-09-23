//! The streams the frontend opens: one table, one subscribe gate and one
//! cancel per stream, and an entry that leaves with the task that owns it.
//!
//! Tauri events have no replay, so a stream waits for the frontend to say its
//! listeners are up before it emits anything. Four subsystems wrote that table,
//! that gate and that cleanup by hand; the watch's gate raced its own cancel.
//! What each stream emits, and how it ends, stays with the stream.

use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// How long a stream waits to hear that someone is listening before it
/// starts anyway. Long enough that a slow first render never loses a batch;
/// short enough that a frontend which crashed between starting a stream and
/// subscribing to it does not pin one open for the life of the process.
pub const SUBSCRIBE_TIMEOUT: Duration = Duration::from_mins(1);

struct Entry {
    cancel: CancellationToken,
    subscribe: Option<oneshot::Sender<()>>,
}

/// An entry leaving cancels its stream, one stop or all of them.
impl Drop for Entry {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Open streams by id.
#[derive(Default)]
pub struct Streams {
    map: Arc<DashMap<String, Entry>>,
}

impl Streams {
    /// Register a stream. The task that runs it holds the [`Opened`], and
    /// the entry leaves when that is dropped — on every exit, a panic's
    /// included.
    #[must_use]
    pub fn open(&self, id: String) -> Opened {
        let cancel = CancellationToken::new();
        let (subscribe_tx, subscribe_rx) = oneshot::channel();
        self.map.insert(
            id.clone(),
            Entry {
                cancel: cancel.clone(),
                subscribe: Some(subscribe_tx),
            },
        );
        let map = self.map.clone();
        let key = id.clone();
        Opened {
            id,
            cancel,
            subscribed: Some(subscribe_rx),
            held: Held {
                _leave: Leave { map, key },
            },
        }
    }

    /// Release a stream's gate. `false` where there is no gate to release:
    /// the id was never opened, the stream has ended or been stopped, or it
    /// was released already. Each command decides what that means for it.
    #[must_use]
    pub fn subscribed(&self, id: &str) -> bool {
        self.map
            .get_mut(id)
            .and_then(|mut entry| entry.subscribe.take())
            .is_some_and(|gate| gate.send(()).is_ok())
    }

    /// Stop a stream. A no-op for one that has already gone.
    #[must_use]
    pub fn stop(&self, id: &str) -> bool {
        self.map.remove(id).is_some()
    }

    /// Stop every stream in the table.
    pub fn stop_all(&self) {
        self.map.clear();
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Whether a stream is open.
    #[must_use]
    pub fn contains(&self, id: &str) -> bool {
        self.map.contains_key(id)
    }
}

struct Leave {
    map: Arc<DashMap<String, Entry>>,
    key: String,
}

impl Drop for Leave {
    fn drop(&mut self) {
        self.map.remove(&self.key);
    }
}

/// One open stream, held by the task that runs it.
pub struct Opened {
    pub id: String,
    /// Fires when the stream is stopped, or when its entry is dropped
    /// without a stop — both mean nobody wants what it would send. Cloned
    /// into every task that works for the stream.
    pub cancel: CancellationToken,
    subscribed: Option<oneshot::Receiver<()>>,
    held: Held,
}

/// Keeps a stream's entry in the table; it leaves when this is dropped.
pub struct Held {
    _leave: Leave,
}

impl Opened {
    /// The cancel signal by value, for a loop that takes it, and what keeps
    /// the entry: hold it for as long as the stream runs.
    #[must_use]
    pub fn split(self) -> (CancellationToken, Held) {
        (self.cancel, self.held)
    }

    /// Hold the stream shut until someone is listening.
    ///
    /// `false` where it should not start at all. Cancel is checked first and
    /// wins outright: a reader flipping three filters starts and drops two
    /// streams before either is subscribed to, and an unbiased `select!` gave
    /// a cancelled one a coin flip's chance of opening a connection anyway.
    /// A dropped gate counts as cancelled: only its entry leaving drops it.
    /// After `timeout` the stream starts regardless; the listener may still
    /// be coming.
    pub async fn wait_for_subscriber(&mut self, timeout: Duration) -> bool {
        let Some(subscribed) = self.subscribed.take() else {
            return true;
        };
        tokio::select! {
            biased;
            () = self.cancel.cancelled() => false,
            answer = subscribed => answer.is_ok(),
            () = tokio::time::sleep(timeout) => {
                tracing::warn!(
                    "Stream {} was not subscribed to within {}s; starting anyway",
                    self.id,
                    timeout.as_secs()
                );
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOON: Duration = Duration::from_secs(5);

    /// The gate opens on subscribe, and only once.
    #[tokio::test]
    async fn a_stream_starts_when_it_is_subscribed_to() {
        let streams = Streams::default();
        let mut opened = streams.open("s-1".into());
        assert!(streams.subscribed("s-1"));
        assert!(
            !streams.subscribed("s-1"),
            "a released gate is not released twice"
        );
        assert!(opened.wait_for_subscriber(SOON).await);
    }

    /// A stop that lands with the subscribe still loses nothing: cancel wins,
    /// every time, and the stream never starts.
    #[tokio::test]
    async fn a_stop_beats_a_subscribe_that_arrives_with_it() {
        for _ in 0..50 {
            let streams = Streams::default();
            let mut opened = streams.open("s-1".into());
            // Both ready before the task looks.
            let gate = streams
                .map
                .get_mut("s-1")
                .and_then(|mut entry| entry.subscribe.take())
                .expect("gate");
            let _ = gate.send(());
            assert!(streams.stop("s-1"));
            assert!(!opened.wait_for_subscriber(SOON).await);
        }
    }

    /// The entry leaves with the task, so nothing stale is left to release
    /// or stop, and a late subscribe says there was no gate.
    #[tokio::test]
    async fn the_entry_leaves_when_the_task_drops_its_stream() {
        let streams = Streams::default();
        let opened = streams.open("s-1".into());
        assert!(streams.contains("s-1"));
        drop(opened);
        assert!(streams.is_empty());
        assert!(!streams.subscribed("s-1"));
        assert!(!streams.stop("s-1"));
    }

    /// A search's clusters and a drain's pass and pause all wait on one stop.
    /// A single-receiver cancel reached only one of them, which is why both
    /// kept their own tables.
    #[tokio::test]
    async fn a_stop_reaches_every_task_working_for_the_stream() {
        let streams = Streams::default();
        let (cancel, _held) = streams.open("s-1".into()).split();
        let workers = [cancel.clone(), cancel.clone()];
        assert!(streams.stop("s-1"));
        for worker in workers {
            tokio::time::timeout(SOON, worker.cancelled())
                .await
                .expect("every clone hears the stop");
        }
    }

    /// A new search stops every older one.
    #[tokio::test]
    async fn stopping_everything_stops_each_stream() {
        let streams = Streams::default();
        let (a, _a) = streams.open("s-1".into()).split();
        let (b, _b) = streams.open("s-2".into()).split();
        streams.stop_all();
        assert!(a.is_cancelled() && b.is_cancelled());
        assert!(streams.is_empty());
    }

    /// Nobody subscribing is not a reason never to start: after the timeout
    /// the stream runs, in case the listener is merely slow.
    #[tokio::test]
    async fn a_stream_nobody_subscribes_to_starts_after_the_timeout() {
        let streams = Streams::default();
        let mut opened = streams.open("s-1".into());
        assert!(opened.wait_for_subscriber(Duration::from_millis(20)).await);
    }
}
