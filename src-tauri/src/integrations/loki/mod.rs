//! Loki — the second integration that is configured rather than detected,
//! and the one that closes the bigger hole.

// A `#[tauri::command]` receives its arguments already deserialised from the
// IPC message, so the macro requires them owned. Taking a borrow here is not
// something a caller could satisfy — the caller is the frontend.
#![allow(clippy::needless_pass_by_value)]
//!
//! A crashed pod takes its logs with it. `kubectl logs --previous` reaches
//! exactly one run back and only while the pod object still exists; once the
//! `ReplicaSet` has replaced it there is nothing left to ask, and no amount of
//! client-side buffering brings it back. Loki is where those lines went, if
//! anybody was shipping them.
//!
//! The network half lives here for the same two reasons Prometheus's does: a
//! bearer token in a renderer process is a token in every devtools session
//! and every crash dump, and a webview talking to somebody's Loki would need
//! CORS headers no cluster operator has set. [`LokiConnection`] has no token
//! field at all, which is a shape rather than a promise.
//!
//! What is **not** here is the app's own log query. The viewer's chips, its
//! intake filter and its level thresholds stay what they are — evaluated in
//! `logs::filter` over lines this app holds. `LogQL` is only the selector this
//! module sends to fetch a range, and rebuilding the reader's query on top
//! of it would mean two filter languages that must agree and one that
//! silently would not.

use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::State;

use crate::config::{AppConfig, LokiEntry};
use crate::error::{Error, Result};
use crate::integrations::wire::{get_text, now_ms};
use crate::logs::parser::parse_log_line;
use crate::logs::types::LogLine;
use crate::state::AppState;

pub const ID: &str = "loki";

/// The most lines one query may bring back, whatever the caller asked for.
///
/// A 24h range over a chatty workload is millions of lines, and a viewer
/// that asked for all of them would hang on the answer rather than on the
/// query. One page, capped here so the ceiling holds even if a caller
/// forgets it, and `truncated` says out loud that the range holds more.
///
/// Under Loki's own `max_entries_limit_per_query` (5 000 by default) on
/// purpose: hitting our limit is a sentence this app can phrase, and hitting
/// theirs is a 400 with their wording.
pub const MAX_LINES: u32 = 1000;

// ---------------------------------------------------------------------------
// What the webview is allowed to know
// ---------------------------------------------------------------------------

/// A saved connection, with the credential removed rather than masked.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LokiConnection {
    pub url: String,
    pub auth_type: String,
    pub has_token: bool,
    pub insecure_tls: bool,
}

impl From<&LokiEntry> for LokiConnection {
    fn from(entry: &LokiEntry) -> Self {
        Self {
            url: entry.url.clone(),
            auth_type: entry.auth_type.clone(),
            has_token: entry.token.as_deref().is_some_and(|t| !t.is_empty()),
            insecure_tls: entry.insecure_tls,
        }
    }
}

/// The Test button's answer, and the gate on the history power.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LokiProbe {
    pub ok: bool,
    /// Epoch ms the answer came back, so the row can say "answered 2s ago".
    pub at: f64,
    pub latency_ms: u64,
    /// Present only on failure, in the server's own words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// How far back this Loki says it keeps lines — **only where it said
    /// so**. A retention the row guessed at would be the worst fact on that
    /// screen: a reader told "3 days" who then finds nothing from yesterday
    /// concludes the app is broken, and a reader told nothing goes and looks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention: Option<String>,
    /// The label names this Loki knows about, so a query that matched
    /// nothing can be answered with what it *does* carry rather than with a
    /// shrug. Capped, because a cluster with per-pod labels has thousands.
    pub labels: Vec<String>,
}

/// One line Loki kept, and the cursor that pages past it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LokiLine {
    /// Loki's own nanosecond timestamp, verbatim.
    ///
    /// A string and not a number, and the paging cursor rather than the
    /// millisecond the viewer draws: a container writing a thousand lines a
    /// second puts several inside one millisecond, and paging on a rounded
    /// cursor would either re-fetch them or step over them. Neither is
    /// visible in the output, which is what makes it worth carrying.
    pub ts: String,
    /// Parsed by the same parser the live stream uses, so a history line and
    /// a live line get the same level colour and the same JSON fields.
    pub line: LogLine,
}

/// One page of a range, and everything the reader must be told about it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LokiPage {
    /// Oldest first, ready to sit in front of the live buffer.
    pub lines: Vec<LokiLine>,
    /// How many distinct streams answered.
    ///
    /// Zero is the label-mismatch signal and the reason this is on the wire.
    /// "No streams" and "no lines" look identical in an empty array, and the
    /// first one usually means this app's label names are not the ones that
    /// install writes — which is a fixable thing the reader is owed rather
    /// than a pane that reads as "this pod never logged".
    pub streams: u32,
    /// The limit was reached, so these are the *newest* `limit` of the range
    /// and there is more inside it.
    pub truncated: bool,
    /// What the limit actually was after capping, so the sentence saying so
    /// prints the number that was used and not the one that was asked for.
    pub limit: u32,
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

fn context_of(state: &State<'_, AppState>) -> Result<String> {
    state
        .get_current_context()
        .ok_or_else(|| Error::Config("No cluster is connected".to_string()))
}

fn entry_for(context: &str) -> Result<Option<LokiEntry>> {
    Ok(AppConfig::load()?.integrations.loki.get(context).cloned())
}

/// This cluster's Loki, or `None` where nobody configured one.
#[tauri::command]
pub fn get_loki_connection(state: State<'_, AppState>) -> Result<Option<LokiConnection>> {
    let context = context_of(&state)?;
    Ok(entry_for(&context)?.map(|entry| LokiConnection::from(&entry)))
}

/// Save this cluster's Loki. An empty `token` keeps whatever is stored — the
/// form never receives the credential, so it cannot send it back.
#[tauri::command]
pub fn save_loki_connection(
    url: String,
    auth_type: String,
    token: Option<String>,
    insecure_tls: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let context = context_of(&state)?;
    let url = url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err(Error::InvalidInput("A Loki needs an address".into()));
    }

    let mut config = AppConfig::load()?;
    let existing = config.integrations.loki.get(&context);
    let token = match auth_type.as_str() {
        "bearer" => token
            .filter(|t| !t.is_empty())
            .or_else(|| existing.and_then(|entry| entry.token.clone())),
        _ => existing.and_then(|entry| entry.token.clone()),
    };

    config.integrations.loki.insert(
        context,
        LokiEntry {
            url,
            auth_type,
            token,
            insecure_tls,
        },
    );
    crate::commands::settings::helpers::save_config(&config)
}

/// Forget this cluster's Loki, credential included.
#[tauri::command]
pub fn forget_loki_connection(state: State<'_, AppState>) -> Result<()> {
    let context = context_of(&state)?;
    crate::commands::settings::helpers::with_config(|config| {
        config.integrations.loki.remove(&context);
    })
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

async fn get_json(
    entry: &LokiEntry,
    path: &str,
    query: &[(&str, String)],
) -> std::result::Result<serde_json::Value, String> {
    let body = get_text(entry, path, query).await?;
    serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|e| format!("Loki answered with something that is not JSON: {e}"))
}

/// Is it there, does it answer, and what does it say about itself?
///
/// `/loki/api/v1/labels` rather than `/ready`: readiness is unauthenticated
/// on a stock Loki, so a probe against it would come back green for a
/// connection whose token is wrong and the history power would then fail
/// one pod at a time. Asking for the label names exercises the whole
/// authenticated path *and* answers the one question this integration is
/// most likely to be wrong about — see [`LokiProbe::labels`].
#[tauri::command]
pub async fn probe_loki(
    url: Option<String>,
    auth_type: Option<String>,
    token: Option<String>,
    insecure_tls: Option<bool>,
    state: State<'_, AppState>,
) -> Result<LokiProbe> {
    let context = context_of(&state)?;
    let stored = entry_for(&context)?;

    // Typed-but-unsaved values win, so Test answers the form on screen
    // rather than the last thing that was saved.
    let entry = match url {
        Some(url) if !url.trim().is_empty() => LokiEntry {
            url: url.trim().trim_end_matches('/').to_string(),
            auth_type: auth_type.unwrap_or_else(|| "none".into()),
            token: token
                .filter(|t| !t.is_empty())
                .or_else(|| stored.as_ref().and_then(|e| e.token.clone())),
            insecure_tls: insecure_tls.unwrap_or(false),
        },
        _ => match stored {
            Some(entry) => entry,
            None => {
                return Ok(LokiProbe {
                    ok: false,
                    at: now_ms(),
                    latency_ms: 0,
                    reason: Some("no address configured".into()),
                    version: None,
                    retention: None,
                    labels: Vec::new(),
                })
            }
        },
    };

    let started = Instant::now();
    let answer = get_json(&entry, "/loki/api/v1/labels", &[]).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    match answer {
        Ok(value) => {
            let labels = value
                .get("data")
                .and_then(|d| d.as_array())
                .map(|names| {
                    names
                        .iter()
                        .filter_map(|n| n.as_str().map(str::to_string))
                        .take(64)
                        .collect()
                })
                .unwrap_or_default();
            let version = get_json(&entry, "/loki/api/v1/status/buildinfo", &[])
                .await
                .ok()
                .and_then(|value| value.get("version")?.as_str().map(str::to_string));
            let retention = get_text(&entry, "/config", &[])
                .await
                .ok()
                .and_then(|body| retention_from_config(&body));
            Ok(LokiProbe {
                ok: true,
                at: now_ms(),
                latency_ms,
                reason: None,
                version,
                retention,
                labels,
            })
        }
        Err(reason) => Ok(LokiProbe {
            ok: false,
            at: now_ms(),
            latency_ms,
            reason: Some(reason),
            version: None,
            retention: None,
            labels: Vec::new(),
        }),
    }
}

/// How long this Loki keeps lines, **only if it said so**.
///
/// `/config` is the whole running configuration as YAML, and it contains the
/// word `retention_period` more than once: `limits_config` holds the one
/// that governs a query, and the legacy `table_manager` block holds another
/// that is usually `0s` and means nothing here. Reading it structurally
/// rather than by grepping the word is the difference between a fact and a
/// coin flip — and a `0s`, a missing key, a disabled `/config` endpoint or
/// anything unparseable all come back `None`, because omitting the fact is
/// honest and inventing one is not.
fn retention_from_config(body: &str) -> Option<String> {
    let root: serde_yaml::Value = serde_yaml::from_str(body).ok()?;
    let value = root
        .get("limits_config")?
        .get("retention_period")?
        .as_str()?
        .trim();
    if value.is_empty() || value.starts_with('0') {
        return None;
    }
    Some(value.to_string())
}

async fn configured(state: &State<'_, AppState>) -> Result<LokiEntry> {
    let context = context_of(state)?;
    entry_for(&context)?
        .ok_or_else(|| Error::Config("No Loki is configured for this cluster".into()))
}

/// One page of a range, newest-first on the wire and oldest-first on the way
/// out.
///
/// `selector` is the `LogQL` stream selector built in
/// `src/integrations/loki/queries.ts`, where it is pure and unit-tested.
/// This module does not know what a pod is.
///
/// `before` is the paging cursor: a nanosecond timestamp from an earlier
/// page, which replaces `end` so the next page starts where the last one
/// stopped. Loki's `end` is exclusive, so handing back the oldest line's own
/// timestamp neither repeats it nor skips its neighbour.
#[tauri::command]
pub async fn loki_query_range(
    selector: String,
    start_ms: f64,
    end_ms: f64,
    limit: u32,
    before: Option<String>,
    state: State<'_, AppState>,
) -> Result<LokiPage> {
    let entry = configured(&state).await?;
    let limit = limit.clamp(1, MAX_LINES);
    let end = match before.as_deref().map(str::trim) {
        Some(cursor) if !cursor.is_empty() => cursor.to_string(),
        _ => ms_to_ns(end_ms),
    };

    let value = get_json(
        &entry,
        "/loki/api/v1/query_range",
        &[
            ("query", selector),
            ("start", ms_to_ns(start_ms)),
            ("end", end),
            ("limit", limit.to_string()),
            // Newest first, always. A truncated answer must lose the oldest
            // lines and not the newest ones: "the newest N of this range" is
            // a sentence a reader can act on, and "some N of this range" is
            // not.
            ("direction", "backward".to_string()),
        ],
    )
    .await
    .map_err(Error::Connection)?;

    parse_streams(&value, limit)
}

fn ms_to_ns(ms: f64) -> String {
    format!("{}", (ms.max(0.0) * 1_000_000.0) as u128)
}

/// The `streams` result shape, flattened and put back in time order.
///
/// Loki answers per stream, each stream's own entries in the requested
/// direction — so five containers come back as five descending lists that
/// have to be merged before anything can be said about which lines are the
/// newest N.
fn parse_streams(body: &serde_json::Value, limit: u32) -> Result<LokiPage> {
    if body.get("status").and_then(|s| s.as_str()) != Some("success") {
        let message = body
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("Loki refused the query");
        return Err(Error::Connection(message.to_string()));
    }
    let empty = Vec::new();
    let results = body
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.as_array())
        .unwrap_or(&empty);

    let mut lines: Vec<LokiLine> = Vec::new();
    for stream in results {
        let labels = stream.get("stream").and_then(|s| s.as_object());
        let label = |name: &str| {
            labels
                .and_then(|map| map.get(name))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };
        let pod = label("pod");
        let container = label("container");
        let namespace = label("namespace");

        for value in stream
            .get("values")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty)
        {
            let Some(pair) = value.as_array() else {
                continue;
            };
            let (Some(ts), Some(text)) = (
                pair.first().and_then(|t| t.as_str()),
                pair.get(1).and_then(|l| l.as_str()),
            ) else {
                continue;
            };
            let mut line = parse_log_line(text, &pod, &container, &namespace);
            // Loki's timestamp wins over anything the line said about
            // itself and over the order it arrived in. It is the only clock
            // that ordered these lines across five containers and three
            // pods, and the viewer's timestamp column shows it.
            line.timestamp = ns_to_utc(ts);
            lines.push(LokiLine {
                ts: ts.to_string(),
                line,
            });
        }
    }

    // Descending on the wire; the viewer wants them the way a log reads.
    lines.sort_by_key(|entry| entry.ts.parse::<u128>().unwrap_or(0));

    Ok(LokiPage {
        // Equal and not greater: Loki applies the limit itself, so this is
        // "it gave us everything it was allowed to" — which is exactly when
        // there may be more inside the range.
        truncated: lines.len() as u32 >= limit,
        streams: results.len() as u32,
        limit,
        lines,
    })
}

fn ns_to_utc(ts: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let nanos = ts.parse::<i64>().ok()?;
    chrono::DateTime::from_timestamp(nanos / 1_000_000_000, (nanos % 1_000_000_000) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Would break if the credential started travelling to the webview —
    /// the one property this module's shape exists to hold, and the same
    /// test the Prometheus half carries for the same reason.
    #[test]
    fn a_saved_connection_reports_that_it_has_a_token_and_never_which_one() {
        let entry = LokiEntry {
            url: "http://loki:3100".into(),
            auth_type: "bearer".into(),
            token: Some("s3cr3t".into()),
            insecure_tls: true,
        };
        let connection = LokiConnection::from(&entry);
        assert!(connection.has_token);

        let wire = serde_json::to_string(&connection).unwrap();
        assert!(
            !wire.contains("s3cr3t"),
            "the token reached the webview: {wire}"
        );
        assert!(!wire.contains("token\":\""), "a token field exists: {wire}");
    }

    fn stream(pod: &str, container: &str, values: Vec<(&str, &str)>) -> serde_json::Value {
        json!({
            "stream": { "namespace": "demo", "pod": pod, "container": container },
            "values": values.into_iter().map(|(t, l)| json!([t, l])).collect::<Vec<_>>(),
        })
    }

    fn body(streams: &[serde_json::Value]) -> serde_json::Value {
        json!({ "status": "success", "data": { "resultType": "streams", "result": streams } })
    }

    /// Would break if two containers' lines stopped being merged into one
    /// clock — Loki answers per stream and a viewer that concatenated them
    /// would show all of the sidecar's log after all of the app's.
    #[test]
    fn streams_are_merged_onto_one_clock_oldest_first() {
        let page = parse_streams(
            &body(&[
                stream("p-1", "app", vec![("30", "third"), ("10", "first")]),
                stream("p-1", "side", vec![("20", "second")]),
            ]),
            100,
        )
        .unwrap();

        let messages: Vec<&str> = page.lines.iter().map(|e| e.line.message.as_str()).collect();
        assert_eq!(messages, vec!["first", "second", "third"]);
        assert_eq!(page.streams, 2);
        assert!(!page.truncated);
    }

    /// Would break if a partial answer stopped saying it was partial.
    ///
    /// This is the one that matters most: a truncated page that reads as a
    /// whole range tells the reader their workload was silent for five of
    /// the six hours they asked about, which is worse than showing nothing.
    #[test]
    fn a_page_that_filled_the_limit_says_it_is_the_newest_of_the_range() {
        let values: Vec<(String, String)> = (0..3)
            .map(|i| (format!("{}", 100 + i), format!("line {i}")))
            .collect();
        let page = parse_streams(
            &body(&[stream(
                "p-1",
                "app",
                values
                    .iter()
                    .map(|(t, l)| (t.as_str(), l.as_str()))
                    .collect(),
            )]),
            3,
        )
        .unwrap();
        assert!(
            page.truncated,
            "a page that filled its limit did not report itself partial"
        );
        assert_eq!(page.limit, 3);
        // And one line short of the limit is a whole answer, not a partial.
        let page = parse_streams(&body(&[stream("p-1", "app", vec![("100", "only")])]), 3).unwrap();
        assert!(!page.truncated);
    }

    /// Would break if a query that matched no stream became
    /// indistinguishable from a pod that wrote nothing. Those are different
    /// facts and only one of them is the reader's to fix.
    #[test]
    fn no_stream_at_all_is_reported_as_no_stream_and_not_as_no_lines() {
        let page = parse_streams(&body(&[]), 100).unwrap();
        assert_eq!(page.streams, 0);
        assert!(page.lines.is_empty());

        // A stream that answered with nothing in it is *not* the same thing.
        let page = parse_streams(&body(&[stream("p-1", "app", vec![])]), 100).unwrap();
        assert_eq!(page.streams, 1);
    }

    /// Would break if Loki's clock stopped being the one on the line, which
    /// is the whole basis for interleaving history with a live stream.
    #[test]
    fn the_timestamp_on_a_line_is_lokis_and_not_the_lines_own() {
        let page = parse_streams(
            &body(&[stream("p-1", "app", vec![("1700000000123456789", "hello")])]),
            100,
        )
        .unwrap();
        let line = &page.lines[0];
        assert_eq!(line.ts, "1700000000123456789", "the ns cursor was rounded");
        assert_eq!(
            line.line.timestamp.unwrap().timestamp_millis(),
            1_700_000_000_123
        );
        assert_eq!(line.line.pod, "p-1");
        assert_eq!(line.line.container, "app");
    }

    /// Would break if a refusal started arriving as an empty page — which
    /// reads exactly like a pod that never logged.
    #[test]
    fn a_refusal_is_an_error_and_never_an_empty_page() {
        let error = parse_streams(
            &json!({ "status": "error", "error": "parse error at line 1, col 3" }),
            100,
        )
        .unwrap_err();
        assert!(error.to_string().contains("parse error"));
    }

    /// Would break if the row started printing the table manager's `0s`, or
    /// started guessing when Loki said nothing.
    #[test]
    fn retention_is_read_from_the_block_that_governs_queries_or_not_at_all() {
        let config = "\
limits_config:
  retention_period: 3d
  max_query_length: 30d1h
table_manager:
  retention_period: 0s
";
        assert_eq!(retention_from_config(config).as_deref(), Some("3d"));

        assert_eq!(
            retention_from_config("table_manager:\n  retention_period: 744h\n"),
            None,
            "a retention outside limits_config was read as this Loki's"
        );
        assert_eq!(
            retention_from_config("limits_config:\n  retention_period: 0s\n"),
            None,
            "'no retention configured' was reported as a retention"
        );
        assert_eq!(retention_from_config("not: yaml: at: all: ["), None);
    }
}
