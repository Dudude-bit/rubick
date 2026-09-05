//! The credentialed HTTP one tier-3 integration is, shared by all of them.
//!
//! Every configured vendor does the same four things: build a client that
//! may have been told to accept a self-signed certificate, attach a bearer
//! token the webview has never seen, ask for a path, and turn whatever went
//! wrong into a sentence the Settings row can print. Per-vendor copies drift
//! at the error phrasing, which is the only part the reader ever sees.
//!
//! No knowledge of what a response *means* lives here: this module hands
//! back a status and a body, and Prometheus reading JSON out of it is not
//! expressed in terms of Loki reading JSON and YAML.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::ConnectionEntry;
use crate::error::{Error, Result};

/// Long enough for a wide range over a busy cluster, short enough that an
/// address pointing at nothing fails while the reader is still looking at it.
pub const TIMEOUT: Duration = Duration::from_secs(20);

pub fn client(insecure_tls: bool) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .danger_accept_invalid_certs(insecure_tls)
        .build()
        .map_err(|e| Error::Connection(format!("Could not build an HTTP client: {e}")))
}

/// Epoch ms, so a row can say "answered 2s ago".
#[must_use]
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// The shortest sentence that names what went wrong.
///
/// `reqwest`'s own `Display` is a nest of "error sending request for url
/// (...): error trying to connect: tcp connect error: ..." — four layers of
/// which only the last one is the answer. The innermost source is that
/// answer, and it is the one the row prints.
#[must_use]
pub fn why(error: &reqwest::Error) -> String {
    let mut source: &dyn std::error::Error = error;
    while let Some(inner) = source.source() {
        source = inner;
    }
    let innermost = source.to_string();
    if error.is_timeout() {
        return format!("timed out after {}s", TIMEOUT.as_secs());
    }
    if innermost.is_empty() {
        error.to_string()
    } else {
        innermost
    }
}

/// One GET, and the body as text.
///
/// Text rather than parsed JSON: the two vendors behind this do not agree on
/// a content type — Loki's `/config` is YAML — and a refusal's body is
/// frequently not JSON at all whatever the success case is.
///
/// The error string is the *server's own words* wherever it gave any —
/// `refusal` pulls them out in whatever shape this vendor states them — and
/// only a body that says nothing falls back to the status code's name. "429
/// too many outstanding requests" and "401 Unauthorized" send the reader to
/// two different places; a bare "could not connect" sends them nowhere.
pub async fn get_text(
    entry: &ConnectionEntry,
    path: &str,
    query: &[(&str, String)],
) -> std::result::Result<String, String> {
    let url = format!("{}{}", entry.url.trim_end_matches('/'), path);
    let mut request = client(entry.insecure_tls)
        .map_err(|e| e.to_string())?
        .get(&url)
        .query(query);
    if let Some(token) = entry.bearer() {
        request = request.bearer_auth(token);
    }

    let response = request.send().await.map_err(|e| why(&e))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| why(&e))?;
    if !status.is_success() {
        let detail = refusal(&body)
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("refused").to_string());
        return Err(format!("{} {}", status.as_u16(), detail));
    }
    Ok(body)
}

/// What a server said about why it refused, in either of the two shapes
/// these servers say it in: a JSON object with an `error` key, or a plain
/// line of text.
fn refusal(body: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value.get("error").and_then(|e| e.as_str()) {
            return Some(message.to_string());
        }
        // A JSON body with no `error` key says nothing a reader can use.
        if value.is_object() {
            return None;
        }
    }
    let line = body.trim().lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    // A refusal that arrives as a whole HTML page is a proxy's, not the
    // server's, and pasting its first tag into the row helps nobody.
    if line.starts_with('<') {
        return None;
    }
    Some(line.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Would break if a server's own explanation started being replaced by
    /// the status code's generic name — the difference between "the label
    /// set is wrong" and "something went wrong".
    #[test]
    fn a_refusal_keeps_the_words_the_server_used() {
        assert_eq!(
            refusal(r#"{"status":"error","error":"parse error at line 1"}"#).as_deref(),
            Some("parse error at line 1")
        );
        assert_eq!(
            refusal("max entries limit per query exceeded\n").as_deref(),
            Some("max entries limit per query exceeded")
        );
        assert_eq!(refusal("   ").as_deref(), None);
        assert_eq!(refusal("<html><body>502</body></html>").as_deref(), None);
        assert_eq!(refusal(r#"{"status":"error"}"#).as_deref(), None);
    }
}
