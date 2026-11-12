//! Where a command's time went: the requests it made and how long each waited
//! on the cluster, against its own wall time. Read only by the commands that
//! ask through [`timed`], and written to the log only for a slow one.

use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use http::{Request, Response};
use http_body::{Body, Frame, SizeHint};
use tower::{Layer, Service};

use crate::state::perf::PerfCounters;

/// A command at least this slow says where its time went.
const SLOW: Duration = Duration::from_millis(100);

/// One request a command made: when it left, when its head came back, and
/// when its body was read to the end.
#[derive(Debug, Clone)]
struct Call {
    path: String,
    sent: Instant,
    head: Duration,
    total: Duration,
}

tokio::task_local! {
    static CALLS: RefCell<Vec<Call>>;
}

/// Kept only on the task of a command being [`timed`]; a watch's stream and
/// every other caller pay for an `Instant` and a path, and keep nothing.
fn note(call: Call) {
    let _ = CALLS.try_with(|calls| calls.borrow_mut().push(call));
}

/// `work`'s wall time and the requests made on its task, counted into a
/// recording and logged where it is at least [`SLOW`]. Requests made on a
/// task it spawns are not its own here.
pub async fn timed<T>(
    perf: &PerfCounters,
    command: &'static str,
    work: impl Future<Output = T>,
) -> T {
    let started = Instant::now();
    let (answer, calls) = CALLS
        .scope(RefCell::default(), async move {
            let answer = work.await;
            (answer, CALLS.with(RefCell::take))
        })
        .await;
    let total = started.elapsed();
    perf.observe_command(command, total, calls.len());
    if total >= SLOW {
        let split = Split::of(started, total, &calls);
        tracing::info!(
            command,
            total_ms = split.total,
            before_first_ms = split.before_first,
            on_cluster_ms = split.on_cluster,
            elsewhere_ms = split.elsewhere,
            api_calls = calls.len(),
            waits = %split.waits,
            "slow command"
        );
    }
    answer
}

/// How many bytes `snake_case` has once its underscores are gone.
#[must_use]
pub const fn camel_len(snake: &str) -> usize {
    let bytes = snake.as_bytes();
    let (mut at, mut kept) = (0, 0);
    while at < bytes.len() {
        if bytes[at] != b'_' {
            kept += 1;
        }
        at += 1;
    }
    kept
}

/// `snake_case` as `snakeCase`, the name the frontend invokes a command by.
#[must_use]
pub const fn camel_case<const N: usize>(snake: &str) -> [u8; N] {
    let bytes = snake.as_bytes();
    let mut out = [0; N];
    let (mut at, mut put, mut upper) = (0, 0, false);
    while at < bytes.len() {
        if bytes[at] == b'_' {
            upper = true;
        } else {
            out[put] = if upper {
                bytes[at].to_ascii_uppercase()
            } else {
                bytes[at]
            };
            put += 1;
            upper = false;
        }
        at += 1;
    }
    out
}

/// A command's name as the frontend invokes it, from the name of its `fn`,
/// worked out at compile time for the commands a macro stamps out.
macro_rules! command_name {
    ($cmd:ident) => {{
        const LEN: usize = $crate::client::clock::camel_len(stringify!($cmd));
        const BYTES: [u8; LEN] = $crate::client::clock::camel_case(stringify!($cmd));
        const NAME: &str = match ::core::str::from_utf8(&BYTES) {
            Ok(name) => name,
            Err(_) => panic!("a command name is ASCII"),
        };
        NAME
    }};
}
pub(crate) use command_name;

/// A command's wall time cut three ways: before its first request left, with
/// at least one request open, and the rest.
struct Split {
    total: u128,
    before_first: u128,
    on_cluster: u128,
    elsewhere: u128,
    waits: String,
}

impl Split {
    fn of(started: Instant, total: Duration, calls: &[Call]) -> Self {
        let mut spans: Vec<(Instant, Instant)> =
            calls.iter().map(|c| (c.sent, c.sent + c.total)).collect();
        spans.sort_unstable();
        let mut open = Duration::ZERO;
        let mut reach: Option<(Instant, Instant)> = None;
        for (from, to) in spans {
            reach = match reach {
                Some((start, end)) if from <= end => Some((start, end.max(to))),
                Some((start, end)) => {
                    open += end - start;
                    Some((from, to))
                }
                None => Some((from, to)),
            };
        }
        if let Some((start, end)) = reach {
            open += end - start;
        }
        let before_first = calls
            .iter()
            .map(|c| c.sent)
            .min()
            .map_or(total, |first| first.saturating_duration_since(started));
        let mut by_wait: Vec<&Call> = calls.iter().collect();
        by_wait.sort_by_key(|c| std::cmp::Reverse(c.total));
        let waits = by_wait
            .iter()
            .map(|c| {
                let last = c.path.rsplit('/').next().unwrap_or(&c.path);
                format!("{last}:{}/{}", c.head.as_millis(), c.total.as_millis())
            })
            .collect::<Vec<_>>()
            .join(" ");
        Self {
            total: total.as_millis(),
            before_first: before_first.as_millis(),
            on_cluster: open.as_millis(),
            elsewhere: total.saturating_sub(open).as_millis(),
            waits,
        }
    }
}

/// The client's outermost layer, so a request's wait includes its retries.
#[derive(Clone, Copy, Default)]
pub(super) struct Clock;

impl<S> Layer<S> for Clock {
    type Service = Clocked<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Clocked(inner)
    }
}

#[derive(Clone)]
pub(super) struct Clocked<S>(S);

impl<S, B, R> Service<Request<R>> for Clocked<S>
where
    S: Service<Request<R>, Response = Response<B>>,
    S::Future: Send + 'static,
{
    type Response = Response<Timed<B>>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0.poll_ready(cx)
    }

    fn call(&mut self, request: Request<R>) -> Self::Future {
        let path = request.uri().path().to_owned();
        let sent = Instant::now();
        let answer = self.0.call(request);
        Box::pin(async move {
            match answer.await {
                Ok(response) => {
                    let head = sent.elapsed();
                    Ok(response.map(|inner| Timed {
                        inner,
                        call: Some(Call {
                            path,
                            sent,
                            head,
                            total: head,
                        }),
                    }))
                }
                Err(error) => {
                    let total = sent.elapsed();
                    note(Call {
                        path,
                        sent,
                        head: total,
                        total,
                    });
                    Err(error)
                }
            }
        })
    }
}

/// A response body that notes its request once read to the end, on the task
/// reading it, which is the command's own.
pub(super) struct Timed<B> {
    inner: B,
    call: Option<Call>,
}

impl<B> Timed<B> {
    fn finish(&mut self) {
        if let Some(mut call) = self.call.take() {
            call.total = call.sent.elapsed();
            note(call);
        }
    }
}

impl<B> Drop for Timed<B> {
    fn drop(&mut self) {
        self.finish();
    }
}

impl<B: Body + Unpin> Body for Timed<B> {
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let frame = Pin::new(&mut self.inner).poll_frame(cx);
        if matches!(frame, Poll::Ready(None | Some(Err(_)))) {
            self.finish();
        }
        frame
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::{Api, ListParams};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    type Asked = Arc<Mutex<Vec<String>>>;

    /// An API server answering each request target with `answer`'s status and
    /// body pieces, each a chunk of its own written 150 ms after the last.
    pub(in crate::client) async fn server(
        answer: impl Fn(&str) -> (u16, Vec<String>) + Send + Sync + 'static,
    ) -> (kube::Client, Asked) {
        slow_server(move |target| Some((Duration::ZERO, answer(target)))).await
    }

    /// As [`server`], each answer begun after its delay, and none ever where
    /// it is `None`: a cache waiting on a version, or a connection gone quiet.
    pub(in crate::client) async fn slow_server(
        answer: impl Fn(&str) -> Option<(Duration, (u16, Vec<String>))> + Send + Sync + 'static,
    ) -> (kube::Client, Asked) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let asked = Asked::default();
        let seen = asked.clone();
        let answer = Arc::new(answer);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (answer, seen) = (answer.clone(), seen.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    seen.lock().unwrap().push(target.clone());
                    let Some((delay, (status, pieces))) = answer(&target) else {
                        return std::future::pending::<()>().await;
                    };
                    tokio::time::sleep(delay).await;
                    let start = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n\
                         transfer-encoding: chunked\r\nconnection: close\r\n\r\n"
                    );
                    let _ = socket.write_all(start.as_bytes()).await;
                    for (at, piece) in pieces.iter().enumerate() {
                        if at > 0 {
                            tokio::time::sleep(Duration::from_millis(150)).await;
                        }
                        let chunk = format!("{:x}\r\n{piece}\r\n", piece.len());
                        let _ = socket.write_all(chunk.as_bytes()).await;
                        let _ = socket.flush().await;
                    }
                    let _ = socket.write_all(b"0\r\n\r\n").await;
                });
            }
        });
        let config = super::super::without_client_retries(kube::Config::new(
            format!("http://127.0.0.1:{port}").parse().expect("url"),
        ));
        let client =
            super::super::client_with_deadline(config, Duration::from_secs(5)).expect("client");
        (client, asked)
    }

    /// A name spelled differently from the one the frontend invokes would
    /// file a command's numbers under a row nothing looks up.
    #[test]
    fn a_stamped_commands_name_is_its_fn_name_in_camel_case() {
        assert_eq!(
            command_name!(list_ingress_health_inputs),
            "listIngressHealthInputs"
        );
        assert_eq!(command_name!(list_pods), "listPods");
        assert_eq!(command_name!(probe), "probe");
    }

    /// A dozen lists in flight together that each took 700 ms are 700 ms on
    /// the cluster, not eight seconds, and the log would say the latter.
    #[test]
    fn requests_that_overlap_are_counted_once_and_the_rest_is_elsewhere() {
        let started = Instant::now();
        let call = |from: u64, to: u64| Call {
            path: "/api/v1/pods".into(),
            sent: started + Duration::from_millis(from),
            head: Duration::from_millis(to - from),
            total: Duration::from_millis(to - from),
        };
        let split = Split::of(
            started,
            Duration::from_millis(500),
            &[call(20, 120), call(70, 170), call(300, 400)],
        );
        assert_eq!(
            (split.before_first, split.on_cluster, split.elsewhere),
            (20, 250, 250)
        );
    }

    /// Would count another task's requests, a watch's above all, against
    /// whichever command happened to be running beside it.
    #[tokio::test]
    async fn a_timed_command_counts_the_requests_made_on_its_own_task() {
        let (client, _) = server(|_| {
            (
                200,
                vec![r#"{"kind":"PodList","apiVersion":"v1","metadata":{},"items":[]}"#.into()],
            )
        })
        .await;
        let perf = PerfCounters::default();
        perf.set_recording(true);
        let pods: Api<Pod> = Api::namespaced(client, "shop");
        let elsewhere = pods.clone();

        timed(&perf, "readTwice", async {
            pods.list(&ListParams::default()).await.expect("first");
            pods.list(&ListParams::default()).await.expect("second");
            tokio::spawn(async move { elsewhere.list(&ListParams::default()).await })
                .await
                .expect("joined")
                .expect("on another task");
        })
        .await;

        assert_eq!(perf.snapshot().commands["readTwice"].max_api_calls, 2);
    }
}
