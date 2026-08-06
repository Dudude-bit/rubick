//! Log streaming configuration: `LogConfig` builder + kube
//! `LogParams` conversion.

use chrono::{DateTime, Utc};
use kube::api::LogParams;
use serde::{Deserialize, Serialize};

use super::filter::{intake_since_time, QueryTerm};

/// Log streaming configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogConfig {
    /// Pod name
    pub pod: String,
    /// Container name (optional, defaults to first container)
    pub container: Option<String>,
    /// Namespace
    pub namespace: String,
    /// Follow logs (stream)
    #[serde(default = "default_follow")]
    pub follow: bool,
    /// Number of lines to tail
    pub tail_lines: Option<i64>,
    /// Include timestamps
    #[serde(default)]
    pub timestamps: bool,
    /// Since seconds
    pub since_seconds: Option<i64>,
    /// Since time
    pub since_time: Option<DateTime<Utc>>,
    /// Previous container logs
    #[serde(default)]
    pub previous: bool,
    /// Terms every arriving line must satisfy to be kept. Empty — the
    /// default — keeps everything, which is what every caller that
    /// predates intake asks for.
    #[serde(default)]
    pub intake: Vec<QueryTerm>,
}

fn default_follow() -> bool {
    true
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            pod: String::new(),
            container: None,
            namespace: "default".to_string(),
            follow: true,
            tail_lines: Some(100),
            timestamps: true,
            since_seconds: None,
            since_time: None,
            previous: false,
            intake: Vec::new(),
        }
    }
}

impl LogConfig {
    /// Create a new log config.
    #[must_use]
    pub fn new(pod: &str, namespace: &str) -> Self {
        Self {
            pod: pod.to_string(),
            namespace: namespace.to_string(),
            ..Default::default()
        }
    }

    #[must_use]
    pub fn with_container(mut self, container: &str) -> Self {
        self.container = Some(container.to_string());
        self
    }

    #[must_use]
    pub fn with_tail(mut self, lines: i64) -> Self {
        self.tail_lines = Some(lines);
        self
    }

    #[must_use]
    pub fn with_follow(mut self, follow: bool) -> Self {
        self.follow = follow;
        self
    }

    #[must_use]
    pub fn with_timestamps(mut self, timestamps: bool) -> Self {
        self.timestamps = timestamps;
        self
    }

    #[must_use]
    pub fn with_previous(mut self, previous: bool) -> Self {
        self.previous = previous;
        self
    }

    #[must_use]
    pub fn with_since_seconds(mut self, since_seconds: i64) -> Self {
        self.since_seconds = Some(since_seconds);
        self
    }

    #[must_use]
    pub fn with_since_time(mut self, since_time: DateTime<Utc>) -> Self {
        self.since_time = Some(since_time);
        self
    }

    #[must_use]
    pub fn with_intake(mut self, intake: Vec<QueryTerm>) -> Self {
        self.intake = intake;
        self
    }

    /// Convert to kube `LogParams` for the underlying API call.
    #[must_use]
    pub fn to_log_params(&self) -> LogParams {
        let mut params = LogParams {
            follow: self.follow,
            timestamps: self.timestamps,
            previous: self.previous,
            ..Default::default()
        };

        if let Some(container) = &self.container {
            params.container = Some(container.clone());
        }

        if let Some(tail) = self.tail_lines {
            params.tail_lines = Some(tail);
        }

        // `since_time` was accepted and then silently dropped here, so
        // the one narrowing the cluster can actually do for us never
        // left the process. It also wins over `since_seconds`: the API
        // takes only one of the two, kube resolves that tie towards
        // `sinceSeconds`, and an instant is the more specific ask.
        if let Some(since) = self.since_time.or_else(|| intake_since_time(&self.intake)) {
            params.since_time = Some(since);
        } else if let Some(since) = self.since_seconds {
            params.since_seconds = Some(since);
        }

        params
    }
}
