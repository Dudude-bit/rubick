//! Log line parsers — JSON, logfmt, klog, logback, plain.
//!
//! Used to be a flat block of static methods on `LogStreamer`; now
//! a flat block of free functions in its own module. Tests in
//! `mod.rs` exercise them via the `parser::` path.

use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::BTreeMap;

use super::types::{LogFormat, LogLevel, LogLine};

/// Parse a multi-line blob into one `LogLine` per line.
#[must_use]
pub fn parse_logs(logs: &str, pod: &str, container: &str, namespace: &str) -> Vec<LogLine> {
    logs.lines()
        .map(|line| parse_log_line(line, pod, container, namespace))
        .collect()
}

/// Parse a single log line into a typed `LogLine`. Detects RFC3339
/// timestamp prefix (the kube API prepends one when `timestamps:
/// true`), then delegates to the structured-message parsers.
#[must_use]
pub fn parse_log_line(line: &str, pod: &str, container: &str, namespace: &str) -> LogLine {
    let raw = line.to_string();
    // Try to parse timestamp from the beginning of the line —
    // Kubernetes log timestamps are RFC3339 when `timestamps: true`.
    let (timestamp, message) = if line.len() > 30 {
        if let Some(space_idx) = line.find(' ') {
            let potential_ts = &line[..space_idx];
            if let Ok(ts) = DateTime::parse_from_rfc3339(potential_ts) {
                (
                    Some(ts.with_timezone(&Utc)),
                    line[space_idx + 1..].to_string(),
                )
            } else {
                (None, line.to_string())
            }
        } else {
            (None, line.to_string())
        }
    } else {
        (None, line.to_string())
    };

    let (format, fields, message, level) = parse_structured_message(&message);

    LogLine {
        timestamp,
        message,
        level,
        format,
        fields,
        raw,
        pod: pod.to_string(),
        container: container.to_string(),
        namespace: namespace.to_string(),
    }
}

/// Try every structured-format parser in turn. Falls back to
/// `LogFormat::Plain` with `LogLevel::Unknown` if nothing matches.
#[must_use]
pub fn parse_structured_message(
    message: &str,
) -> (
    LogFormat,
    Option<BTreeMap<String, String>>,
    String,
    Option<LogLevel>,
) {
    if let Some((fields, level, msg)) = parse_json_message(message) {
        return (
            LogFormat::Json,
            Some(fields),
            msg.unwrap_or_else(|| message.to_string()),
            level,
        );
    }

    if let Some((fields, level, msg)) = parse_logfmt_message(message) {
        return (
            LogFormat::Logfmt,
            Some(fields),
            msg.unwrap_or_else(|| message.to_string()),
            level,
        );
    }

    if let Some((msg, level)) = parse_klog_message(message) {
        return (
            LogFormat::Klog,
            None,
            msg.unwrap_or_else(|| message.to_string()),
            Some(level),
        );
    }

    if let Some((msg, level)) = parse_logback_message(message) {
        return (
            LogFormat::Logback,
            None,
            msg.unwrap_or_else(|| message.to_string()),
            Some(level),
        );
    }

    (
        LogFormat::Plain,
        None,
        message.to_string(),
        Some(LogLevel::Unknown),
    )
}

fn parse_json_message(
    message: &str,
) -> Option<(BTreeMap<String, String>, Option<LogLevel>, Option<String>)> {
    let trimmed = message.trim_start();
    if !trimmed.starts_with('{') {
        return None;
    }

    let value: Value = serde_json::from_str(trimmed).ok()?;
    let object = value.as_object()?;

    // Require at least one common log field to consider this structured JSON
    let has_log_fields = object.contains_key("msg")
        || object.contains_key("message")
        || object.contains_key("level")
        || object.contains_key("lvl")
        || object.contains_key("severity")
        || object.contains_key("time")
        || object.contains_key("ts")
        || object.contains_key("timestamp")
        || object.contains_key("@timestamp")
        || object.contains_key("log");

    if !has_log_fields {
        return None;
    }

    let mut fields = BTreeMap::new();
    for (key, value) in object {
        let entry = match value {
            Value::String(inner) => inner.clone(),
            _ => value.to_string(),
        };
        fields.insert(key.clone(), entry);
    }

    let level_value = extract_json_value(object, &["level", "lvl", "severity", "log.level"]);
    let message_value = extract_json_value(object, &["msg", "message", "log", "event", "error"]);

    let level = level_value.as_deref().and_then(LogLevel::parse_value);

    Some((fields, level, message_value))
}

fn extract_json_value(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = object.get(*key) {
            return Some(match value {
                Value::String(inner) => inner.clone(),
                _ => value.to_string(),
            });
        }
    }
    None
}

fn parse_logfmt_message(
    message: &str,
) -> Option<(BTreeMap<String, String>, Option<LogLevel>, Option<String>)> {
    let fields = parse_logfmt_fields(message)?;

    // Require at least 2 valid key=value pairs
    if fields.len() < 2 {
        return None;
    }

    // All keys must be valid identifiers (alphanumeric + underscore)
    let all_valid_keys = fields
        .keys()
        .all(|k| !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_'));
    if !all_valid_keys {
        return None;
    }

    let level_value = extract_logfmt_value(&fields, &["level", "lvl", "severity"]);
    let message_value = extract_logfmt_value(&fields, &["msg", "message", "log", "event", "error"]);
    let level = level_value.as_deref().and_then(LogLevel::parse_value);
    Some((fields, level, message_value))
}

fn parse_klog_message(message: &str) -> Option<(Option<String>, LogLevel)> {
    let mut chars = message.chars();
    let level_char = chars.next()?;
    let level = match level_char {
        'I' => LogLevel::Info,
        'W' => LogLevel::Warn,
        'E' => LogLevel::Error,
        'F' => LogLevel::Fatal,
        _ => return None,
    };

    let rest = chars.as_str();
    let bytes = rest.as_bytes();
    if bytes.len() < 8 {
        return None;
    }
    if !bytes[0..4].iter().all(u8::is_ascii_digit) {
        return None;
    }
    if !bytes[4].is_ascii_whitespace() {
        return None;
    }
    if !bytes[5..].contains(&b':') {
        return None;
    }

    let msg = rest.find("] ").map(|idx| rest[idx + 2..].to_string());

    Some((msg, level))
}

fn parse_logback_message(message: &str) -> Option<(Option<String>, LogLevel)> {
    let mut parts = message.split_whitespace();
    let date_token = parts.next()?;
    let time_token = parts.next()?;
    let level_token = parts.next()?;

    if !is_date_token(date_token) || !is_time_token(time_token) {
        return None;
    }

    let level = LogLevel::parse_value(level_token)?;

    let msg = message
        .find(" - ")
        .map(|idx| message[idx + 3..].to_string());

    Some((msg, level))
}

fn is_date_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn is_time_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    if bytes.len() < 8 {
        return false;
    }
    bytes[0..2].iter().all(u8::is_ascii_digit)
        && bytes[2] == b':'
        && bytes[3..5].iter().all(u8::is_ascii_digit)
        && bytes[5] == b':'
        && bytes[6..8].iter().all(u8::is_ascii_digit)
}

fn extract_logfmt_value(fields: &BTreeMap<String, String>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = fields.get(*key) {
            return Some(value.clone());
        }
    }
    None
}

fn parse_logfmt_fields(message: &str) -> Option<BTreeMap<String, String>> {
    let mut fields = BTreeMap::new();
    let mut chars = message.chars().peekable();

    loop {
        while let Some(ch) = chars.peek() {
            if ch.is_whitespace() {
                chars.next();
            } else {
                break;
            }
        }

        if chars.peek().is_none() {
            break;
        }

        let mut key = String::new();
        let mut saw_equal = false;
        while let Some(ch) = chars.peek() {
            if *ch == '=' {
                chars.next();
                saw_equal = true;
                break;
            }
            if ch.is_whitespace() {
                break;
            }
            key.push(*ch);
            chars.next();
        }

        if key.is_empty() || !saw_equal {
            break;
        }

        let mut value = String::new();
        if matches!(chars.peek(), Some(&'"')) {
            chars.next();
            while let Some(ch) = chars.next() {
                if ch == '\\' {
                    if let Some(escaped) = chars.next() {
                        value.push(escaped);
                    }
                    continue;
                }
                if ch == '"' {
                    break;
                }
                value.push(ch);
            }
        } else {
            while let Some(ch) = chars.peek() {
                if ch.is_whitespace() {
                    break;
                }
                value.push(*ch);
                chars.next();
            }
        }

        if !key.is_empty() {
            fields.insert(key, value);
        }
    }

    if fields.is_empty() {
        None
    } else {
        Some(fields)
    }
}
