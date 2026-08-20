//! Prometheus — the first integration that is configured rather than detected.
//!
//! The network half lives here and not in the webview, for two reasons that
//! are not stylistic. A bearer token in a renderer process is a token in
//! every devtools session, every crash dump and every extension that ever
//! gets to run there; and a browser context talking to somebody's Prometheus
//! would need that Prometheus to have been configured with CORS headers for
//! an app it has never heard of, which no cluster operator has done.
//!
//! So the webview sends `PromQL` and gets numbers back. It never sends, sees,
//! or stores the credential — {@link `PrometheusConnection`} is deliberately
//! missing the token field, and `get_prometheus_connection` answers with
//! `has_token` rather than with the token.
//!
//! What is *not* here is any knowledge of what the queries mean. The `PromQL`
//! is built in `src/integrations/prometheus/queries.ts`, where it is pure and
//! unit-tested against the label shapes cAdvisor actually emits. This module
//! is a credentialed HTTP client with a Prometheus-shaped response parser.

use std::collections::HashMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::{AppConfig, PrometheusEntry};
use crate::error::{Error, Result};
use crate::integrations::wire::{get_text, now_ms};
use crate::state::AppState;

pub const ID: &str = "prometheus";

// ---------------------------------------------------------------------------
// What the webview is allowed to know
// ---------------------------------------------------------------------------

/// A saved connection, with the credential removed rather than masked.
///
/// `has_token` is the only thing the form needs: it draws a filled password
/// field it will not read back, and an empty submission means "leave it
/// alone" — the same round trip the registry editor already does.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrometheusConnection {
    pub url: String,
    pub auth_type: String,
    pub has_token: bool,
    pub insecure_tls: bool,
}

impl From<&PrometheusEntry> for PrometheusConnection {
    fn from(entry: &PrometheusEntry) -> Self {
        Self {
            url: entry.url.clone(),
            auth_type: entry.auth_type.clone(),
            has_token: entry.token.as_deref().is_some_and(|t| !t.is_empty()),
            insecure_tls: entry.insecure_tls,
        }
    }
}

/// The Test button's answer, and the gate on every power behind this vendor.
///
/// `reason` is the server's or the transport's own words, never a
/// paraphrase: "no route to host" and "401 Unauthorized" send the reader to
/// two different places, and a single "could not connect" sends them nowhere.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrometheusProbe {
    pub ok: bool,
    /// Epoch ms the answer came back, so the row can say "answered 2s ago".
    pub at: f64,
    pub latency_ms: u64,
    /// Present only on failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The build version, where `/api/v1/status/buildinfo` answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// One point of a series. `v` is `None` for the `NaN` Prometheus writes when
/// a rate has nothing to divide — a gap, which the chart draws as a gap.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromPoint {
    /// Epoch **ms**, converted here so nothing downstream has to remember
    /// that Prometheus counts in seconds and JavaScript does not.
    pub t: f64,
    pub v: Option<f64>,
}

/// One labelled series.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromSeries {
    pub labels: HashMap<String, String>,
    pub points: Vec<PromPoint>,
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

fn context_of(state: &State<'_, AppState>) -> Result<String> {
    state
        .get_current_context()
        .ok_or_else(|| Error::Config("No cluster is connected".to_string()))
}

fn entry_for(context: &str) -> Result<Option<PrometheusEntry>> {
    Ok(AppConfig::load()?
        .integrations
        .prometheus
        .get(context)
        .cloned())
}

/// This cluster's Prometheus, or `None` where nobody configured one.
#[tauri::command]
pub fn get_prometheus_connection(
    state: State<'_, AppState>,
) -> Result<Option<PrometheusConnection>> {
    let context = context_of(&state)?;
    Ok(entry_for(&context)?.map(|entry| PrometheusConnection::from(&entry)))
}

/// Save this cluster's Prometheus.
///
/// An empty `token` keeps whatever is already stored — the form never
/// receives the credential, so it cannot send it back, and treating empty as
/// "clear it" would silently unauthenticate the connection every time the
/// reader edited the URL.
#[tauri::command]
pub fn save_prometheus_connection(
    url: String,
    auth_type: String,
    token: Option<String>,
    insecure_tls: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let context = context_of(&state)?;
    let url = url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err(Error::InvalidInput("A Prometheus needs an address".into()));
    }

    let mut config = AppConfig::load()?;
    let existing = config.integrations.prometheus.get(&context);
    let token = match auth_type.as_str() {
        "bearer" => token
            .filter(|t| !t.is_empty())
            .or_else(|| existing.and_then(|entry| entry.token.clone())),
        _ => existing.and_then(|entry| entry.token.clone()),
    };

    config.integrations.prometheus.insert(
        context,
        PrometheusEntry {
            url,
            auth_type,
            token,
            insecure_tls,
        },
    );
    crate::commands::settings::helpers::save_config(&config)
}

/// Forget this cluster's Prometheus, credential included.
#[tauri::command]
pub fn forget_prometheus_connection(state: State<'_, AppState>) -> Result<()> {
    let context = context_of(&state)?;
    crate::commands::settings::helpers::with_config(|config| {
        config.integrations.prometheus.remove(&context);
    })
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

async fn get_json(
    entry: &PrometheusEntry,
    path: &str,
    query: &[(&str, String)],
) -> std::result::Result<serde_json::Value, String> {
    let body = get_text(entry, path, query).await?;
    serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|e| format!("Prometheus answered with something that is not JSON: {e}"))
}

/// Is it there, and does it answer?
///
/// `/api/v1/query` with a constant rather than `/-/ready`: readiness is
/// unauthenticated on a stock Prometheus, so a probe against it would come
/// back green for a connection whose token is wrong and every power behind
/// it would then fail one at a time. A trivial query exercises the whole
/// path the ranges use.
#[tauri::command]
pub async fn probe_prometheus(
    url: Option<String>,
    auth_type: Option<String>,
    token: Option<String>,
    insecure_tls: Option<bool>,
    state: State<'_, AppState>,
) -> Result<PrometheusProbe> {
    let context = context_of(&state)?;
    let stored = entry_for(&context)?;

    // Typed-but-unsaved values win, so Test answers the form on screen
    // rather than the last thing that was saved.
    let entry = match url {
        Some(url) if !url.trim().is_empty() => PrometheusEntry {
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
                return Ok(PrometheusProbe {
                    ok: false,
                    at: now_ms(),
                    latency_ms: 0,
                    reason: Some("no address configured".into()),
                    version: None,
                })
            }
        },
    };

    let started = Instant::now();
    let answer = get_json(&entry, "/api/v1/query", &[("query", "1".to_string())]).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    match answer {
        Ok(_) => {
            let version = get_json(&entry, "/api/v1/status/buildinfo", &[])
                .await
                .ok()
                .and_then(|value| {
                    value
                        .get("data")?
                        .get("version")?
                        .as_str()
                        .map(str::to_string)
                });
            Ok(PrometheusProbe {
                ok: true,
                at: now_ms(),
                latency_ms,
                reason: None,
                version,
            })
        }
        Err(reason) => Ok(PrometheusProbe {
            ok: false,
            at: now_ms(),
            latency_ms,
            reason: Some(reason),
            version: None,
        }),
    }
}

/// The error a power reports when the address is there and the server is not.
///
/// Deliberately a failed `Result` rather than an empty answer: the consuming
/// surface owes three different screens, and "connected but nothing matched"
/// has to stay distinguishable from "did not answer".
fn unreachable(reason: String) -> Error {
    Error::Connection(reason)
}

async fn configured(state: &State<'_, AppState>) -> Result<PrometheusEntry> {
    let context = context_of(state)?;
    entry_for(&context)?
        .ok_or_else(|| Error::Config("No Prometheus is configured for this cluster".into()))
}

/// One instant query — the fullness of a volume, and nothing that needs a past.
#[tauri::command]
pub async fn prometheus_query(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<PromSeries>> {
    let entry = configured(&state).await?;
    let value = get_json(&entry, "/api/v1/query", &[("query", query)])
        .await
        .map_err(unreachable)?;
    parse_result(&value)
}

/// One range query — the whole point of having a Prometheus.
///
/// `start` and `end` are epoch **ms** and `step` is seconds, matching the
/// units either side of this boundary rather than picking one and making
/// half the callers convert.
#[tauri::command]
pub async fn prometheus_query_range(
    query: String,
    start: f64,
    end: f64,
    step: u32,
    state: State<'_, AppState>,
) -> Result<Vec<PromSeries>> {
    let entry = configured(&state).await?;
    let value = get_json(
        &entry,
        "/api/v1/query_range",
        &[
            ("query", query),
            ("start", format!("{:.3}", start / 1000.0)),
            ("end", format!("{:.3}", end / 1000.0)),
            ("step", format!("{}s", step.max(1))),
        ],
    )
    .await
    .map_err(unreachable)?;
    parse_result(&value)
}

/// Both response shapes, flattened to one.
///
/// A `vector` is a `matrix` with one point per series as far as every caller
/// here is concerned, and keeping the distinction would put a `match` on
/// result type in three places that do not care.
fn parse_result(body: &serde_json::Value) -> Result<Vec<PromSeries>> {
    if body.get("status").and_then(|s| s.as_str()) != Some("success") {
        let message = body
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("Prometheus refused the query");
        return Err(unreachable(message.to_string()));
    }
    let data = body
        .get("data")
        .ok_or_else(|| unreachable("Prometheus answered without any data".into()))?;
    let empty = Vec::new();
    let results = data
        .get("result")
        .and_then(|r| r.as_array())
        .unwrap_or(&empty);

    Ok(results
        .iter()
        .map(|series| {
            let labels = series
                .get("metric")
                .and_then(|m| m.as_object())
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default();

            let mut points: Vec<PromPoint> = series
                .get("values")
                .and_then(|v| v.as_array())
                .map(|values| values.iter().filter_map(parse_point).collect())
                .unwrap_or_default();
            if let Some(single) = series.get("value").and_then(parse_point) {
                points.push(single);
            }

            PromSeries { labels, points }
        })
        .collect())
}

/// `[1699999999.5, "12.5"]` — the timestamp is a number and the value is a
/// string, which is Prometheus keeping float precision the JSON number type
/// would round off. `NaN` is a real answer meaning "nothing to compute here".
fn parse_point(raw: &serde_json::Value) -> Option<PromPoint> {
    let pair = raw.as_array()?;
    let t = pair.first()?.as_f64()?;
    let v = pair.get(1)?.as_str()?.parse::<f64>().ok();
    Some(PromPoint {
        t: t * 1000.0,
        v: v.filter(|value| value.is_finite()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Would break if the credential started travelling to the webview —
    /// the one property this whole module's shape exists to hold.
    #[test]
    fn a_saved_connection_reports_that_it_has_a_token_and_never_which_one() {
        let entry = PrometheusEntry {
            url: "http://p:9090".into(),
            auth_type: "bearer".into(),
            token: Some("s3cr3t".into()),
            insecure_tls: true,
        };
        let connection = PrometheusConnection::from(&entry);
        assert!(connection.has_token);
        assert!(connection.insecure_tls);

        let wire = serde_json::to_string(&connection).unwrap();
        assert!(
            !wire.contains("s3cr3t"),
            "the token reached the webview: {wire}"
        );
        assert!(!wire.contains("token\":\""), "a token field exists: {wire}");
    }

    /// Would break if a rate with nothing to divide started drawing as zero.
    /// A gap is not a quiet period, and a chart that fills one is lying about
    /// a window nobody measured.
    #[test]
    fn nan_is_a_gap_and_not_a_zero() {
        let body = json!({
            "status": "success",
            "data": {
                "resultType": "matrix",
                "result": [{
                    "metric": { "pod": "busy-demo-abc-def" },
                    "values": [[1700000000.0, "12.5"], [1700000015.0, "NaN"]]
                }]
            }
        });
        let series = parse_result(&body).unwrap();
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].labels.get("pod").unwrap(), "busy-demo-abc-def");
        assert_eq!(series[0].points[0].v, Some(12.5));
        assert_eq!(series[0].points[1].v, None);
        assert_eq!(
            series[0].points[0].t, 1_700_000_000_000.0,
            "seconds were not converted to milliseconds"
        );
    }

    /// Would break if a vector answer stopped being readable through the same
    /// path as a matrix — the volume-fullness power reads instant queries.
    #[test]
    fn an_instant_answer_reads_through_the_same_door_as_a_range() {
        let body = json!({
            "status": "success",
            "data": {
                "resultType": "vector",
                "result": [{
                    "metric": { "persistentvolumeclaim": "data-stateful-demo-0" },
                    "value": [1700000000.0, "0.84"]
                }]
            }
        });
        let series = parse_result(&body).unwrap();
        assert_eq!(series[0].points.len(), 1);
        assert_eq!(series[0].points[0].v, Some(0.84));
    }

    /// Would break if a refusal started arriving as an empty chart — which is
    /// indistinguishable from a workload that used nothing.
    #[test]
    fn a_refusal_is_an_error_and_never_an_empty_series() {
        let body = json!({ "status": "error", "error": "parse error: unexpected \"}\"" });
        let error = parse_result(&body).unwrap_err();
        assert!(
            error.to_string().contains("parse error"),
            "Prometheus's own words were dropped: {error}"
        );
    }
}
