//! A read the far end has not begun to answer is asked again beside it, but
//! only while the far end is answering its siblings.
//!
//! Twice a services list sat on its connection for the whole minute while
//! the same command's other lists answered in milliseconds, and the API
//! server never saw it: it was lost between the app and the proxy. The first
//! ask is kept, so a slow answer that is merely slow still wins, and the
//! quicker of the two is taken; both stay inside the one read deadline.
//! A server answering nothing is queueing, under API Priority and Fairness
//! or plain overload, and a second ask there only adds to the queue.
//! A watch, a log follow or an upgrade is a stream, never asked twice.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use http::{Request, Response};
use kube::client::Body as KubeBody;
use tokio::sync::watch;
use tower::{Layer, Service, ServiceExt};

/// How long a read waits for the head of its answer before it is asked again.
pub(super) const HEDGE_AFTER: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
pub(super) struct Hedge {
    after: Duration,
}

impl Hedge {
    pub(super) fn after(after: Duration) -> Self {
        Self { after }
    }
}

impl<S> Layer<S> for Hedge {
    type Service = Hedged<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Hedged {
            inner,
            after: self.after,
            answered: Arc::new(watch::Sender::new(0)),
        }
    }
}

#[derive(Clone)]
pub(super) struct Hedged<S> {
    inner: S,
    after: Duration,
    /// How many requests on this client the far end has answered.
    answered: Arc<watch::Sender<u64>>,
}

fn hedged(request: &Request<KubeBody>) -> bool {
    let query = request.uri().query().unwrap_or_default();
    super::send_again::is_read(request) && !super::floors::has_param(query, &["watch", "follow"])
}

type Answer<B, E> = Pin<Box<dyn Future<Output = Result<Response<B>, E>> + Send>>;

/// The request's answer, counted as the far end answering once its head arrives.
fn counted<B, E>(
    answer: impl Future<Output = Result<Response<B>, E>> + Send + 'static,
    answered: Arc<watch::Sender<u64>>,
) -> Answer<B, E> {
    Box::pin(async move {
        let answer = answer.await;
        if answer.is_ok() {
            answered.send_modify(|n| *n += 1);
        }
        answer
    })
}

impl<S, B> Service<Request<KubeBody>> for Hedged<S>
where
    S: Service<Request<KubeBody>, Response = Response<B>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    B: Send + 'static,
{
    type Response = Response<B>;
    type Error = S::Error;
    type Future = Answer<B, S::Error>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<KubeBody>) -> Self::Future {
        let copy = hedged(&request)
            .then(|| super::floors::again(&request))
            .flatten();
        let path = request.uri().path().to_string();
        let answered = self.answered.clone();
        let sent = *answered.borrow();
        let mut first = counted(self.inner.call(request), answered.clone());
        let Some(copy) = copy else {
            return first;
        };
        let (spare, after) = (self.inner.clone(), self.after);
        Box::pin(async move {
            if let Ok(answer) = tokio::time::timeout(after, &mut first).await {
                return answer;
            }
            let mut heard = answered.subscribe();
            let siblings = async move { heard.wait_for(|n| *n > sent).await.is_ok() };
            tokio::select! {
                biased;
                answer = &mut first => return answer,
                answering = siblings => if !answering {
                    return first.await;
                },
            }
            tracing::info!(
                path,
                waited_ms = after.as_millis(),
                "no answer yet while others were answered, asked again beside it"
            );
            let mut second = counted(spare.oneshot(copy), answered);
            tokio::select! {
                answer = &mut first => match answer {
                    Ok(response) => Ok(response),
                    Err(_) => second.await,
                },
                answer = &mut second => match answer {
                    Ok(response) => Ok(response),
                    Err(_) => first.await,
                },
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// How the test server treats the `nth` request it reads, counting from 1.
    #[derive(Clone, Copy)]
    enum Reply {
        Now,
        After(Duration),
        Never,
    }

    /// A server answering each request as `reply` says, and the request
    /// lines it read, in order.
    async fn server(
        reply: impl Fn(usize) -> Reply + Send + Sync + 'static,
    ) -> (kube::Client, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let heard = seen.clone();
        let reply = Arc::new(reply);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (heard, reply) = (heard.clone(), reply.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let line = String::from_utf8_lossy(&buf[..n])
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    let nth = {
                        let mut heard = heard.lock().unwrap();
                        heard.push(line);
                        heard.len()
                    };
                    match reply(nth) {
                        Reply::Never => {
                            tokio::time::sleep(Duration::from_secs(3600)).await;
                            return;
                        }
                        Reply::After(wait) => tokio::time::sleep(wait).await,
                        Reply::Now => {}
                    }
                    let body = format!(r#"{{"kind":"NamespaceList","answer":{nth}}}"#);
                    let _ = socket
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await;
                });
            }
        });
        let config = kube::Config::new(
            format!("http://127.0.0.1:{port}")
                .parse()
                .expect("cluster url"),
        );
        let client =
            super::super::client_with(config, Duration::from_secs(1), Duration::from_millis(100))
                .expect("client");
        (client, seen)
    }

    fn get(path: &str) -> http::Request<Vec<u8>> {
        http::Request::get(path).body(Vec::new()).expect("request")
    }

    /// `request`, sent first, while a sibling read on the same client is
    /// answered after it went out.
    async fn beside_an_answered_sibling(
        client: &kube::Client,
        request: http::Request<Vec<u8>>,
    ) -> Result<String, kube::Error> {
        let asked = {
            let client = client.clone();
            tokio::spawn(async move { client.request_text(request).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        client
            .request_text(get("/api/v1/nodes"))
            .await
            .expect("the sibling is answered");
        asked.await.expect("joined")
    }

    /// Sam's services list and Marco's overview each sat 60 s on a request
    /// the API server never received while their siblings were answered.
    /// Fails if such a read is not asked again, or waits out the deadline
    /// instead of the hedge.
    #[tokio::test]
    async fn a_read_left_unanswered_while_its_siblings_are_answered_is_asked_again() {
        let (client, seen) = server(|nth| if nth == 1 { Reply::Never } else { Reply::Now }).await;
        let started = Instant::now();

        let answer = beside_an_answered_sibling(&client, get("/api/v1/namespaces"))
            .await
            .expect("the second ask is answered");

        assert!(answer.contains(r#""answer":3"#), "{answer}");
        assert!(
            started.elapsed() < Duration::from_millis(800),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    /// An API server queueing every request under load answers none of
    /// them, and a second ask of each only lengthens the queue. Fails if a
    /// read is asked again while nothing on its client has been answered
    /// since it went out.
    #[tokio::test]
    async fn a_read_on_a_server_answering_nothing_is_not_asked_again() {
        let (client, seen) = server(|_| Reply::Never).await;
        for path in ["/api/v1/namespaces", "/api/v1/nodes"] {
            let client = client.clone();
            tokio::spawn(async move { client.request_text(get(path)).await });
        }

        tokio::time::sleep(Duration::from_millis(600)).await;

        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    /// A big list on a slow store is slow, not lost. Fails if the first ask
    /// is dropped when the second goes out, which would turn every slow read
    /// into one that waits for an answer starting over.
    #[tokio::test]
    async fn a_slow_answer_already_on_its_way_is_still_taken() {
        let (client, seen) = server(|nth| match nth {
            1 => Reply::After(Duration::from_millis(300)),
            2 => Reply::Now,
            _ => Reply::Never,
        })
        .await;

        let answer = beside_an_answered_sibling(&client, get("/api/v1/namespaces"))
            .await
            .expect("the first ask's answer");

        assert!(answer.contains(r#""answer":1"#), "{answer}");
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    /// Fails if a read that answers in time is asked twice.
    #[tokio::test]
    async fn a_read_answered_in_time_is_asked_once() {
        let (client, seen) = server(|_| Reply::Now).await;
        client
            .request_text(get("/api/v1/namespaces"))
            .await
            .expect("answered");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    /// A watch and a log follow are streams the app lives on, and a write
    /// starts something. Fails if any of them is ever sent twice, even
    /// beside a sibling the server answered.
    #[tokio::test]
    async fn a_watch_a_follow_or_a_write_is_never_asked_twice() {
        for request in [
            get("/api/v1/pods?watch=true"),
            get("/api/v1/namespaces/shop/pods/cart/log?follow=true"),
            http::Request::post("/api/v1/namespaces/shop/pods")
                .body(b"{}".to_vec())
                .expect("request"),
        ] {
            let (client, seen) =
                server(|nth| if nth == 1 { Reply::Never } else { Reply::Now }).await;
            let line = format!("{} {}", request.method(), request.uri());
            assert!(
                beside_an_answered_sibling(&client, request).await.is_err(),
                "{line}"
            );
            assert_eq!(seen.lock().unwrap().len(), 2, "{line}");
        }
    }
}
