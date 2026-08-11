//! DateTime utilities
//!
//! This module provides common date and time utilities used across
//! all Rubick projects. It includes formatting functions for displaying
//! human-readable time durations and ages.

use chrono::{DateTime, Utc};

/// Format age from a DateTime as a human-readable string.
///
/// Converts a timestamp to a human-readable age string like "5d", "2h", "30m", "10s".
/// This is commonly used in Kubernetes UIs to show resource age.
///
/// # Arguments
///
/// * `created_at` - Optional DateTime to calculate age from
///
/// # Returns
///
/// A string representing the age in the most appropriate unit:
/// - Days (e.g., "5d") if >= 1 day
/// - Hours (e.g., "2h") if >= 1 hour
/// - Minutes (e.g., "30m") if >= 1 minute
/// - Seconds (e.g., "10s") otherwise
/// - "Unknown" if the timestamp is None
///
/// # Examples
///
/// ```
/// use chrono::Utc;
/// use k8s_gui_common::datetime::format_age;
///
/// // With a timestamp
/// let created = Some(Utc::now() - chrono::Duration::hours(2));
/// assert_eq!(format_age(created.as_ref()), "2h");
///
/// // Without a timestamp
/// assert_eq!(format_age(None), "Unknown");
/// ```
#[must_use]
pub fn format_age(created_at: Option<&DateTime<Utc>>) -> String {
    match created_at {
        Some(created_time) => {
            let now = Utc::now();
            let duration = now.signed_duration_since(*created_time);
            let seconds = duration.num_seconds();

            if seconds < 0 {
                // Future timestamp
                return "0s".to_string();
            }

            if seconds < 60 {
                format!("{seconds}s")
            } else if seconds < 3600 {
                format!("{}m", seconds / 60)
            } else if seconds < 86400 {
                format!("{}h", seconds / 3600)
            } else {
                format!("{}d", seconds / 86400)
            }
        }
        None => "Unknown".to_string(),
    }
}

/// Format a DateTime as RFC 3339 string.
///
/// # Arguments
///
/// * `datetime` - Optional DateTime to format
///
/// # Returns
///
/// RFC 3339 formatted string or "Unknown" if None
///
/// # Examples
///
/// ```
/// use chrono::Utc;
/// use k8s_gui_common::datetime::format_rfc3339;
///
/// let now = Some(Utc::now());
/// let formatted = format_rfc3339(now.as_ref());
/// assert!(formatted.contains("T")); // RFC 3339 format
///
/// assert_eq!(format_rfc3339(None), "Unknown");
/// ```
#[must_use]
pub fn format_rfc3339(datetime: Option<&DateTime<Utc>>) -> String {
    match datetime {
        Some(dt) => dt.to_rfc3339(),
        None => "Unknown".to_string(),
    }
}

/// Format a duration in seconds as a human-readable string.
///
/// # Arguments
///
/// * `seconds` - Duration in seconds
///
/// # Returns
///
/// Human-readable duration string (e.g., "2d 5h 30m 10s")
///
/// # Examples
///
/// ```
/// use k8s_gui_common::datetime::format_duration;
///
/// assert_eq!(format_duration(3661), "1h 1m 1s");
/// assert_eq!(format_duration(86400), "1d");
/// assert_eq!(format_duration(45), "45s");
/// ```
#[must_use]
pub fn format_duration(seconds: i64) -> String {
    if seconds < 0 {
        return "0s".to_string();
    }

    let days = seconds / 86400;
    let hours = (seconds % 86400) / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;

    let mut parts = Vec::new();

    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if secs > 0 || parts.is_empty() {
        parts.push(format!("{secs}s"));
    }

    parts.join(" ")
}

/// Parse an RFC 3339 string to DateTime<Utc>.
///
/// # Arguments
///
/// * `s` - RFC 3339 formatted string
///
/// # Returns
///
/// Parsed DateTime or None if parsing fails
///
/// # Examples
///
/// ```
/// use k8s_gui_common::datetime::parse_rfc3339;
///
/// let dt = parse_rfc3339("2024-01-15T10:30:00Z");
/// assert!(dt.is_some());
///
/// let invalid = parse_rfc3339("not a date");
/// assert!(invalid.is_none());
/// ```
#[must_use]
pub fn parse_rfc3339(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn test_format_age_seconds() {
        let now = Utc::now();
        let created = now - Duration::seconds(30);
        assert_eq!(format_age(Some(&created)), "30s");
    }

    #[test]
    fn test_format_age_minutes() {
        let now = Utc::now();
        let created = now - Duration::minutes(45);
        assert_eq!(format_age(Some(&created)), "45m");
    }

    #[test]
    fn test_format_age_hours() {
        let now = Utc::now();
        let created = now - Duration::hours(5);
        assert_eq!(format_age(Some(&created)), "5h");
    }

    #[test]
    fn test_format_age_days() {
        let now = Utc::now();
        let created = now - Duration::days(3);
        assert_eq!(format_age(Some(&created)), "3d");
    }

    #[test]
    fn test_format_age_none() {
        assert_eq!(format_age(None), "Unknown");
    }

    #[test]
    fn test_format_duration() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(45), "45s");
        assert_eq!(format_duration(60), "1m");
        assert_eq!(format_duration(3600), "1h");
        assert_eq!(format_duration(86400), "1d");
        assert_eq!(format_duration(90061), "1d 1h 1m 1s");
    }

    #[test]
    fn test_parse_rfc3339() {
        let parsed = parse_rfc3339("2024-01-15T10:30:00Z");
        assert!(parsed.is_some());

        let invalid = parse_rfc3339("invalid");
        assert!(invalid.is_none());
    }
}


