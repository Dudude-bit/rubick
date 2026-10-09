//! A read sent again when the far end had already closed the keep-alive
//! connection it went out on. kube's pool keeps an idle connection for 90 s
//! with no setting for it; a front end that forgets one sooner fails the next
//! request as `SendRequest`, which neither hyper-util nor kube retries.

use http::{header::UPGRADE, Method, Request, Response};
use kube::client::Body;
use tower::{retry::Policy, BoxError};

/// Each such failure uses up one dead pooled connection, and a pool holds several.
const AT_MOST: usize = 8;

#[derive(Clone)]
pub(super) struct SendAgain {
    left: usize,
}

impl Default for SendAgain {
    fn default() -> Self {
        Self { left: AT_MOST }
    }
}

impl<B> Policy<Request<Body>, Response<B>, BoxError> for SendAgain {
    type Future = std::future::Ready<()>;

    fn retry(
        &mut self,
        request: &mut Request<Body>,
        result: &mut Result<Response<B>, BoxError>,
    ) -> Option<Self::Future> {
        let Err(error) = result else {
            return None;
        };
        if !closed_under_request(error.as_ref()) {
            return None;
        }
        if self.left == 0 {
            tracing::warn!(
                method = %request.method(),
                path = request.uri().path(),
                "{} connections in a row closed under the request",
                AT_MOST + 1
            );
            return None;
        }
        self.left -= 1;
        tracing::debug!(
            method = %request.method(),
            path = request.uri().path(),
            "the connection closed under the request, sending it again"
        );
        Some(std::future::ready(()))
    }

    fn clone_request(&mut self, request: &Request<Body>) -> Option<Request<Body>> {
        if !is_read(request) {
            return None;
        }
        let mut copy = Request::new(request.body().try_clone()?);
        *copy.method_mut() = request.method().clone();
        *copy.uri_mut() = request.uri().clone();
        *copy.version_mut() = request.version();
        *copy.headers_mut() = request.headers().clone();
        *copy.extensions_mut() = request.extensions().clone();
        Some(copy)
    }
}

/// An upgrade (exec, attach, port-forward) starts something, so it is never sent twice.
fn is_read(request: &Request<Body>) -> bool {
    matches!(*request.method(), Method::GET | Method::HEAD)
        && !request.headers().contains_key(UPGRADE)
}

/// Made, then closed before it answered: never a refused connect, DNS, TLS or a deadline.
fn closed_under_request(error: &(dyn std::error::Error + 'static)) -> bool {
    std::iter::successors(Some(error), |cause| cause.source())
        .find_map(|cause| cause.downcast_ref::<hyper_util::client::legacy::Error>())
        .is_some_and(|failed| {
            failed.connect_info().is_some() && std::error::Error::source(failed).is_some()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[derive(Default)]
    struct Seen {
        connections: AtomicUsize,
        closed_under: AtomicUsize,
        requests: Mutex<Vec<String>>,
    }

    impl Seen {
        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    /// Answers `answers` requests per connection and closes it under the next,
    /// as a connection a front end already forgot fails on its next use.
    async fn closing_after(answers: usize) -> (kube::Client, Arc<Seen>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let seen = Arc::new(Seen::default());
        let counted = seen.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                counted.connections.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(serve(socket, answers, counted.clone()));
            }
        });
        let url = format!("http://127.0.0.1:{port}");
        let config = kube::Config::new(url.parse().expect("cluster url"));
        let client =
            super::super::client_with_deadline(config, Duration::from_secs(5)).expect("client");
        (client, seen)
    }

    async fn serve(mut socket: TcpStream, answers: usize, seen: Arc<Seen>) {
        let mut buf = Vec::new();
        let mut answered = 0;
        loop {
            let Some(head_end) = read_head(&mut socket, &mut buf).await else {
                return;
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
            let body_len = head
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|n| n.trim().parse::<usize>().unwrap_or(0))
                })
                .unwrap_or(0);
            while buf.len() < head_end + body_len {
                let mut chunk = [0u8; 4096];
                match socket.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            buf.drain(..head_end + body_len);
            let line = head.lines().next().unwrap_or("").to_string();
            seen.requests.lock().unwrap().push(line);
            if answered == answers {
                seen.closed_under.fetch_add(1, Ordering::SeqCst);
                return;
            }
            answered += 1;
            let body = r#"{"kind":"NamespaceList","apiVersion":"v1","metadata":{},"items":[]}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            if socket.write_all(reply.as_bytes()).await.is_err() {
                return;
            }
        }
    }

    async fn read_head(socket: &mut TcpStream, buf: &mut Vec<u8>) -> Option<usize> {
        loop {
            if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                return Some(at + 4);
            }
            let mut chunk = [0u8; 4096];
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => return None,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    }

    fn get(path: &str) -> Request<Vec<u8>> {
        Request::get(path).body(Vec::new()).expect("request")
    }

    async fn read_then_idle(client: &kube::Client) {
        client
            .request_text(get("/api/v1/namespaces"))
            .await
            .expect("the first read is answered");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    /// Without the retry the second read fails as `SendRequest`: what dana saw
    /// every couple of minutes behind Killercoda's front end, a failed query or
    /// a watch that did not start.
    #[tokio::test]
    async fn a_read_on_a_keep_alive_connection_closed_while_idle_is_answered() {
        let (client, seen) = closing_after(1).await;
        read_then_idle(&client).await;

        let second = client.request_text(get("/api/v1/namespaces")).await;

        assert!(second.is_ok(), "{second:?}");
        assert_eq!(
            seen.closed_under.load(Ordering::SeqCst),
            1,
            "the read went out on the dead connection"
        );
        assert_eq!(seen.connections.load(Ordering::SeqCst), 2);
    }

    /// The start of a watch is a GET like any read, and a watch that could not
    /// start was the other face of the same failure.
    #[tokio::test]
    async fn a_watch_on_a_keep_alive_connection_closed_while_idle_starts() {
        let (client, seen) = closing_after(1).await;
        read_then_idle(&client).await;

        let watch = client
            .request_text(get("/api/v1/namespaces?watch=true&resourceVersion=0"))
            .await;

        assert!(watch.is_ok(), "{watch:?}");
        assert_eq!(seen.closed_under.load(Ordering::SeqCst), 1);
    }

    /// A write may have reached the server before the connection closed, so
    /// sending it again could apply it twice.
    #[tokio::test]
    async fn a_write_on_a_closed_connection_is_not_sent_again() {
        let (client, seen) = closing_after(1).await;
        read_then_idle(&client).await;

        let request = Request::post("/api/v1/namespaces")
            .header("content-type", "application/json")
            .body(br#"{"metadata":{"name":"x"}}"#.to_vec())
            .expect("request");
        let write = client.request_text(request).await;

        assert!(write.is_err(), "{write:?}");
        let posts = seen
            .requests()
            .iter()
            .filter(|line| line.starts_with("POST"))
            .count();
        assert_eq!(posts, 1);
    }

    /// An exec or a port-forward starts a process or a stream on the far
    /// side, so the upgrade that opens it is not sent twice either.
    #[tokio::test]
    async fn an_upgrade_on_a_closed_connection_is_not_sent_again() {
        let (client, seen) = closing_after(1).await;
        read_then_idle(&client).await;

        let request = Request::get("/api/v1/namespaces/default/pods/p/exec?command=sh")
            .header("connection", "Upgrade")
            .header("upgrade", "websocket")
            .body(Vec::new())
            .expect("request");
        let upgrade = client.request_text(request).await;

        assert!(upgrade.is_err(), "{upgrade:?}");
        let execs = seen
            .requests()
            .iter()
            .filter(|line| line.contains("/exec"))
            .count();
        assert_eq!(execs, 1);
    }

    /// A server that closes every connection under the request is a real
    /// failure: the caller hears it once, after a bounded number of attempts,
    /// rather than an endless loop of new connections.
    #[tokio::test]
    async fn a_server_that_closes_every_connection_fails_once_after_bounded_attempts() {
        let (client, seen) = closing_after(0).await;

        let read = client.request_text(get("/api/v1/namespaces")).await;

        assert!(read.is_err(), "{read:?}");
        assert_eq!(seen.requests().len(), AT_MOST + 1);
    }

    /// A refused connection is the cluster being unreachable, and sending again
    /// would only delay saying so.
    #[tokio::test]
    async fn a_refused_connection_is_not_read_as_closed_under_the_request() {
        let port = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        let url = format!("http://127.0.0.1:{port}");
        let config = kube::Config::new(url.parse().expect("cluster url"));
        let client =
            super::super::client_with_deadline(config, Duration::from_secs(5)).expect("client");

        let refused = client.request_text(get("/api/v1/namespaces")).await;

        let Err(kube::Error::Service(error)) = refused else {
            panic!("a refused connect is a service error: {refused:?}");
        };
        assert!(!closed_under_request(error.as_ref()), "{error:?}");
    }

    /// A TLS handshake the server cannot finish is a connect failure, made
    /// once: sending again would open a new connection per attempt.
    #[tokio::test]
    async fn a_failed_tls_handshake_is_tried_once() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counted = accepted.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                counted.fetch_add(1, Ordering::SeqCst);
                let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
            }
        });
        let url = format!("https://127.0.0.1:{port}");
        let config = kube::Config::new(url.parse().expect("cluster url"));
        let client =
            super::super::client_with_deadline(config, Duration::from_secs(5)).expect("client");

        let read = client.request_text(get("/api/v1/namespaces")).await;

        assert!(read.is_err(), "{read:?}");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }
}
