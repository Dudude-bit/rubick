//! Persisted state for integrations the reader configures rather than the
//! app detects.
//!
//! Keyed by kubeconfig context, because a Prometheus is: staging's is not
//! production's, and a single global address would answer the wrong cluster's
//! questions with a straight face.
//!
//! **The token is stored in plaintext**, in the same `config.toml` as
//! everything else, because that is where this app already puts a registry
//! password and inventing a second, better store for one field would leave
//! the reader with two rules about where their secrets live and only one of
//! them true. It is never handed back to the webview — see
//! `integrations::prometheus::get_prometheus_connection`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Every configured integration, per kubeconfig context.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsConfig {
    /// Key is the kubeconfig context name.
    #[serde(default)]
    pub prometheus: HashMap<String, PrometheusEntry>,
}

/// One cluster's Prometheus.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrometheusEntry {
    /// Base URL, without the `/api/v1` — `http://prometheus.monitoring:9090`.
    pub url: String,
    /// `none` or `bearer`. A string rather than an enum to match the registry
    /// entry beside it, and so an unknown value in a hand-edited file reads
    /// as "no auth" instead of failing the whole config parse.
    #[serde(default = "no_auth")]
    pub auth_type: String,
    /// Plaintext. Never returned to the webview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// For the self-signed certificate an in-cluster Prometheus usually has.
    #[serde(default)]
    pub insecure_tls: bool,
}

fn no_auth() -> String {
    "none".to_string()
}

impl PrometheusEntry {
    /// The bearer token, only where the reader asked for bearer auth.
    ///
    /// Reading `token` directly would send a stale credential from a config
    /// that was switched back to `none` — the field is kept on purpose so
    /// toggling auth off and on again does not make the reader retype it.
    pub fn bearer(&self) -> Option<&str> {
        if self.auth_type != "bearer" {
            return None;
        }
        self.token.as_deref().filter(|token| !token.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Would break if the stored token started leaking out of a connection
    /// the reader has switched back to anonymous.
    #[test]
    fn a_token_kept_for_convenience_is_not_a_token_that_gets_sent() {
        let mut entry = PrometheusEntry {
            url: "http://p:9090".into(),
            auth_type: "bearer".into(),
            token: Some("secret".into()),
            insecure_tls: false,
        };
        assert_eq!(entry.bearer(), Some("secret"));

        entry.auth_type = "none".into();
        assert_eq!(entry.bearer(), None);

        entry.auth_type = "bearer".into();
        entry.token = Some(String::new());
        assert_eq!(entry.bearer(), None, "an empty string is not a credential");
    }
}
