//! Log streaming module — parser, streamer, filter, types.
//!
//! Re-exports each submodule's public surface so `crate::logs::Foo`
//! continues to work for every existing caller. Tests live here so
//! they can exercise the integration across modules through a
//! single `super::*` import.

pub mod config;
pub mod filter;
pub mod parser;
pub mod streamer;
pub mod types;

pub use config::LogConfig;
pub use filter::{FieldOp, IntakeFilter, LevelOp, QueryTerm};
pub use streamer::LogStreamer;
pub use types::{LogFormat, LogLevel, LogLine};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_config_default() {
        let config = LogConfig::default();
        assert!(config.follow);
        assert_eq!(config.tail_lines, Some(100));
    }

    #[test]
    fn test_log_level_parse() {
        assert_eq!(LogLevel::parse("ERROR: something failed"), LogLevel::Error);
        assert_eq!(LogLevel::parse("INFO: started"), LogLevel::Info);
        assert_eq!(LogLevel::parse("random message"), LogLevel::Unknown);
    }

    /// The grammar the viewer types and the grammar the streamer
    /// evaluates are one grammar, so the wire spelling of a term is part
    /// of the contract: `≥` and `≠` are what the chips read and what
    /// `parseQueryTerm` produces, and renaming a variant here would
    /// leave the generated type looking right and every term failing to
    /// deserialize.
    #[test]
    fn terms_are_spelled_on_the_wire_the_way_the_chips_read() {
        let term: QueryTerm =
            serde_json::from_str(r#"{"kind":"level","op":"≥","value":"warn"}"#).unwrap();
        assert_eq!(
            term,
            QueryTerm::Level {
                op: LevelOp::AtLeast,
                value: LogLevel::Warn
            }
        );
        assert_eq!(
            serde_json::to_string(&term).unwrap(),
            r#"{"kind":"level","op":"≥","value":"warn"}"#
        );

        let field: QueryTerm =
            serde_json::from_str(r#"{"kind":"field","key":"component","op":"≠","value":"ingest"}"#)
                .unwrap();
        assert_eq!(
            field,
            QueryTerm::Field {
                key: "component".to_string(),
                op: FieldOp::IsNot,
                value: "ingest".to_string()
            }
        );

        let text: QueryTerm = serde_json::from_str(r#"{"kind":"text","value":"queue"}"#).unwrap();
        assert_eq!(
            text,
            QueryTerm::Text {
                value: "queue".to_string()
            }
        );

        let time: QueryTerm = serde_json::from_str(r#"{"kind":"time","from":1,"to":2}"#).unwrap();
        assert_eq!(time, QueryTerm::Time { from: 1, to: 2 });
    }

    #[test]
    fn intake_narrows_a_stream_before_anything_is_kept() {
        let logs = [
            parser::parse_log_line(
                r#"{"level":"error","msg":"dropping batch","component":"ingest"}"#,
                "flood",
                "main",
                "default",
            ),
            parser::parse_log_line(
                r#"{"level":"info","msg":"batch accepted","component":"ingest"}"#,
                "flood",
                "main",
                "default",
            ),
        ];

        let filter = IntakeFilter::new(&[QueryTerm::Level {
            op: LevelOp::AtLeast,
            value: LogLevel::Warn,
        }]);

        let kept: Vec<_> = logs
            .iter()
            .filter(|log| filter.matches(log, 0))
            .map(|log| log.message.as_str())
            .collect();
        assert_eq!(kept, ["dropping batch"]);
    }

    #[test]
    fn intake_reaches_the_request_as_since_time() {
        let config = LogConfig::new("flood-demo", "default")
            .with_since_seconds(600)
            .with_intake(vec![QueryTerm::Time {
                from: 1_700_000_000_000,
                to: 1_700_000_060_000,
            }]);

        let params = config.to_log_params();
        assert_eq!(
            params.since_time.map(|t| t.timestamp_millis()),
            Some(1_700_000_000_000)
        );
        // The API takes one of the two and kube resolves the tie the
        // other way, so the coarser one has to be cleared or the
        // narrowing silently does not happen.
        assert_eq!(params.since_seconds, None);
    }

    #[test]
    fn test_json_detection_requires_log_fields() {
        // Valid structured log — should detect as JSON
        let valid = r#"{"msg":"hello","level":"info"}"#;
        let (format, _, _, _) = parser::parse_structured_message(valid);
        assert_eq!(format, LogFormat::Json);

        // Arbitrary JSON without log fields — should NOT detect as JSON
        let arbitrary = r#"{"foo":"bar","count":42}"#;
        let (format, _, _, _) = parser::parse_structured_message(arbitrary);
        assert_eq!(format, LogFormat::Plain);
    }

    #[test]
    fn test_logfmt_detection_requires_multiple_pairs() {
        let valid = "level=info msg=\"user logged in\" user=john";
        let (format, _, _, _) = parser::parse_structured_message(valid);
        assert_eq!(format, LogFormat::Logfmt);

        let single = "port=8080";
        let (format, _, _, _) = parser::parse_structured_message(single);
        assert_eq!(format, LogFormat::Plain);

        let sentence = "Starting server port=8080";
        let (format, _, _, _) = parser::parse_structured_message(sentence);
        assert_eq!(format, LogFormat::Plain);

        let plain = "Error: x=5 is invalid";
        let (format, _, _, _) = parser::parse_structured_message(plain);
        assert_eq!(format, LogFormat::Plain);

        // Invalid keys (non-identifier characters) — should NOT detect
        let invalid_key = "foo:bar=value baz=123";
        let (format, _, _, _) = parser::parse_structured_message(invalid_key);
        assert_eq!(format, LogFormat::Plain);
    }

    #[test]
    fn test_plain_text_level_is_unknown() {
        // Plain text mentioning "error" should NOT be marked as Error level
        let line = "Processing error handler registration";
        let log = parser::parse_log_line(line, "pod", "container", "ns");
        assert_eq!(log.format, LogFormat::Plain);
        assert_eq!(log.level, Some(LogLevel::Unknown));

        let line2 = "This is a warning about disk space";
        let log2 = parser::parse_log_line(line2, "pod", "container", "ns");
        assert_eq!(log2.level, Some(LogLevel::Unknown));
    }
}
