//! Log data types: `LogLine`, `LogFormat`, `LogLevel`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::ansi::StyledSegment;

/// Single parsed log line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Timestamp (if available)
    pub timestamp: Option<DateTime<Utc>>,
    /// Log message
    pub message: String,
    /// Log level (if parseable)
    pub level: Option<LogLevel>,
    /// Log format (json/logfmt/plain)
    pub format: LogFormat,
    /// Parsed fields for structured formats
    pub fields: Option<BTreeMap<String, String>>,
    /// The line as the terminal would show it: escapes taken out, colour
    /// kept in `segments`.
    pub raw: String,
    /// Style runs over `raw`, when the program coloured the line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<StyledSegment>>,
    /// Source pod
    pub pod: String,
    /// Source container
    pub container: String,
    /// Namespace
    pub namespace: String,
}

/// Log format detected by the parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    Plain,
    Json,
    Logfmt,
    Klog,
    Logback,
}

/// Log level detected by the parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
    Unknown,
}

impl LogLevel {
    /// Severity as an order, least severe first — the one definition of
    /// what `level≥warn` means.
    ///
    /// `Unknown` sits at the bottom on purpose: a line the parser could
    /// not read a level out of is not evidence of a problem, and a
    /// threshold asking for trouble should not return every unparsed
    /// line in the buffer. The viewer's `LEVEL_RANK` is this list, and
    /// `shared/log-query-conformance.json` is what stops the two drifting.
    pub const RANKED: [LogLevel; 6] = [
        LogLevel::Unknown,
        LogLevel::Debug,
        LogLevel::Info,
        LogLevel::Warn,
        LogLevel::Error,
        LogLevel::Fatal,
    ];

    /// This level's place in `RANKED`. Derived rather than written out a
    /// second time, so the order has exactly one home.
    #[must_use]
    pub fn rank(self) -> usize {
        Self::RANKED
            .iter()
            .position(|level| *level == self)
            .unwrap_or(0)
    }

    /// Best-effort heuristic from a free-text message — used when no
    /// structured `level` field is available.
    #[must_use]
    pub fn parse(message: &str) -> Self {
        let lower = message.to_lowercase();
        if lower.contains("error") || lower.contains(" err ") {
            LogLevel::Error
        } else if lower.contains("warn") {
            LogLevel::Warn
        } else if lower.contains("info") {
            LogLevel::Info
        } else if lower.contains("debug") {
            LogLevel::Debug
        } else if lower.contains("fatal") {
            LogLevel::Fatal
        } else {
            LogLevel::Unknown
        }
    }

    /// Parse a level from a structured field value (e.g. `"info"` or
    /// `"WARN"`). Returns `None` for empty input so callers can
    /// distinguish "absent" from "Unknown".
    #[must_use]
    pub fn parse_value(value: &str) -> Option<Self> {
        let lower = value.trim().to_lowercase();
        if lower.is_empty() {
            return None;
        }
        let level = if lower.starts_with("fatal") || lower.starts_with("critical") {
            LogLevel::Fatal
        } else if lower.starts_with("error") || lower == "err" {
            LogLevel::Error
        } else if lower.starts_with("warn") || lower.starts_with("warning") {
            LogLevel::Warn
        } else if lower.starts_with("info") {
            LogLevel::Info
        } else if lower.starts_with("debug") || lower.starts_with("trace") {
            LogLevel::Debug
        } else {
            LogLevel::Unknown
        };
        Some(level)
    }
}
