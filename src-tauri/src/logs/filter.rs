//! The log query grammar, and the intake filter built out of it.
//!
//! A term is one clause of a query — `level≥warn`, `component=ingest`, a
//! stretch of wall clock, a piece of text. The viewer already evaluated
//! these over its buffer; intake evaluates the same terms here, before
//! the line is kept, so a pod emitting faster than the buffer can hold
//! stops costing anything for lines nobody will read.
//!
//! That is why the grammar lives in Rust and the TypeScript is
//! generated from it: a chip flipped from query to intake must select
//! the same lines on either side, or it silently changes meaning as it
//! moves. Types alone do not guarantee that — `shared/log-query-conformance.json`
//! is the corpus both evaluators are held to.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::types::{LogLevel, LogLine};

/// How a `level` term compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LevelOp {
    /// This level and no other.
    #[serde(rename = "=")]
    Is,
    /// This level or anything more severe — see `LogLevel::RANKED`.
    #[serde(rename = "≥")]
    AtLeast,
}

/// How a `key=value` term compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FieldOp {
    #[serde(rename = "=")]
    Is,
    #[serde(rename = "≠")]
    IsNot,
}

/// One clause of a query, and the whole of what a chip stands for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QueryTerm {
    /// Free text, matched case-insensitively against the message and the
    /// raw line.
    Text { value: String },
    /// The parsed level, exactly or as a threshold.
    Level { op: LevelOp, value: LogLevel },
    /// A parsed field. `container` is not one, but it is the thing every
    /// reader asks for by name, so it answers here too.
    Field {
        key: String,
        op: FieldOp,
        value: String,
    },
    /// A stretch of wall clock, in ms since epoch, both ends inclusive.
    Time { from: i64, to: i64 },
}

impl QueryTerm {
    /// Does this line satisfy the term?
    ///
    /// `epoch_ms` is where the line sits on the clock: its own timestamp
    /// when it has one, otherwise the last timestamp seen on the same
    /// stream. The viewer resolves it the same way, because a range that
    /// skipped untimestamped lines would filter out exactly the
    /// unlabelled burst someone dragged over.
    #[must_use]
    pub fn matches(&self, line: &LogLine, epoch_ms: i64) -> bool {
        match self {
            QueryTerm::Text { value } => matches_text(line, &value.to_lowercase()),
            QueryTerm::Level { op, value } => {
                let level = line.level.unwrap_or(LogLevel::Unknown);
                match op {
                    LevelOp::Is => level == *value,
                    LevelOp::AtLeast => level.rank() >= value.rank(),
                }
            }
            QueryTerm::Field { key, op, value } => {
                let actual = if key == "container" {
                    Some(&line.container)
                } else {
                    line.fields.as_ref().and_then(|fields| fields.get(key))
                };
                match op {
                    FieldOp::Is => actual == Some(value),
                    // A line without the key is not evidence that it
                    // holds some other value, so `≠` does not keep it.
                    FieldOp::IsNot => actual.is_some() && actual != Some(value),
                }
            }
            QueryTerm::Time { from, to } => epoch_ms >= *from && epoch_ms <= *to,
        }
    }
}

/// The tightest lower bound the time terms imply.
///
/// `sinceTime` is the only content-independent narrowing the Kubernetes
/// API offers, so a dragged range becomes a smaller request rather than
/// a bigger discard. It is a pushdown, not a replacement: the term stays
/// in the predicate, and since the API can only withhold lines the
/// predicate would have rejected anyway, applying it cannot change which
/// lines match.
#[must_use]
pub fn intake_since_time(terms: &[QueryTerm]) -> Option<DateTime<Utc>> {
    terms
        .iter()
        .filter_map(|term| match term {
            QueryTerm::Time { from, .. } => Some(*from),
            _ => None,
        })
        .max()
        .and_then(DateTime::from_timestamp_millis)
}

/// The intake terms of one stream, arranged for the hot path.
///
/// Every arriving line is tested, and the ones that fail are the whole
/// point — they must cost as little as possible. So: text needles are
/// folded once at construction instead of once per line, and they sort
/// to the back, because a level or field test is a comparison where a
/// text test is a scan of the line. Terms are `ANDed`, so the first
/// failure ends the line.
#[derive(Debug, Clone, Default)]
pub struct IntakeFilter {
    terms: Vec<PreparedTerm>,
}

#[derive(Debug, Clone)]
enum PreparedTerm {
    /// Needle already lower-cased.
    Text(String),
    Other(QueryTerm),
}

impl IntakeFilter {
    #[must_use]
    pub fn new(terms: &[QueryTerm]) -> Self {
        let mut prepared: Vec<PreparedTerm> = terms
            .iter()
            .map(|term| match term {
                QueryTerm::Text { value } => PreparedTerm::Text(value.to_lowercase()),
                other => PreparedTerm::Other(other.clone()),
            })
            .collect();
        prepared.sort_by_key(|term| usize::from(matches!(term, PreparedTerm::Text(_))));
        Self { terms: prepared }
    }

    /// Every term has to hold: intake narrows, it does not widen. No
    /// terms is the common case and costs an empty iteration.
    #[must_use]
    pub fn matches(&self, line: &LogLine, epoch_ms: i64) -> bool {
        self.terms.iter().all(|term| match term {
            PreparedTerm::Text(needle) => matches_text(line, needle),
            PreparedTerm::Other(term) => term.matches(line, epoch_ms),
        })
    }
}

/// Text hits the message or the raw bytes — the raw line because a JSON
/// log's fields are not in its message, the message because a JSON log's
/// message is not what its raw line looks like.
fn matches_text(line: &LogLine, needle_lower: &str) -> bool {
    contains_lowered(&line.message, needle_lower) || contains_lowered(&line.raw, needle_lower)
}

/// Case-insensitive `contains`, agreeing with `haystack.toLowerCase().includes(needle)`.
///
/// An all-ASCII haystack — every line of every log this has been pointed
/// at — is folded byte-wise while scanning rather than copied into a
/// lower-cased `String` first. That allocation, twice per discarded
/// line, is precisely the cost intake exists to avoid. Anything with a
/// non-ASCII byte falls back to the full Unicode fold, where JS and Rust
/// agree and a byte-wise fold would not.
fn contains_lowered(haystack: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    if haystack.is_ascii() && needle_lower.is_ascii() {
        let (haystack, needle) = (haystack.as_bytes(), needle_lower.as_bytes());
        return haystack.len() >= needle.len()
            && haystack
                .windows(needle.len())
                .any(|window| window.eq_ignore_ascii_case(needle));
    }
    haystack.to_lowercase().contains(needle_lower)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::types::LogFormat;
    use std::collections::BTreeMap;

    /// The contract both evaluators are held to. See the file's own note
    /// for why a shared type is not enough on its own.
    const CORPUS: &str = include_str!("../../../shared/log-query-conformance.json");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Corpus {
        level_order: Vec<LogLevel>,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        term: QueryTerm,
        line: CaseLine,
        #[serde(default)]
        epoch: i64,
        expect: bool,
    }

    #[derive(Deserialize)]
    struct CaseLine {
        #[serde(default)]
        message: String,
        #[serde(default)]
        raw: String,
        #[serde(default)]
        level: Option<LogLevel>,
        #[serde(default)]
        fields: Option<BTreeMap<String, String>>,
        #[serde(default = "default_container")]
        container: String,
    }

    fn default_container() -> String {
        "app".to_string()
    }

    impl CaseLine {
        fn build(&self) -> LogLine {
            LogLine {
                timestamp: None,
                message: self.message.clone(),
                level: self.level,
                format: LogFormat::Plain,
                fields: self.fields.clone(),
                raw: self.raw.clone(),
                segments: None,
                pod: "pod".to_string(),
                container: self.container.clone(),
                namespace: "default".to_string(),
            }
        }
    }

    fn corpus() -> Corpus {
        serde_json::from_str(CORPUS).expect("conformance corpus parses")
    }

    fn line(message: &str) -> LogLine {
        CaseLine {
            message: message.to_string(),
            raw: message.to_string(),
            level: None,
            fields: None,
            container: default_container(),
        }
        .build()
    }

    #[test]
    fn severity_order_is_the_one_the_viewer_uses() {
        assert_eq!(corpus().level_order.as_slice(), LogLevel::RANKED.as_slice());
    }

    #[test]
    fn every_term_shape_selects_what_the_viewer_selects() {
        for case in corpus().cases {
            let log = case.line.build();
            assert_eq!(
                case.term.matches(&log, case.epoch),
                case.expect,
                "{}",
                case.name
            );
            assert_eq!(
                IntakeFilter::new(std::slice::from_ref(&case.term)).matches(&log, case.epoch),
                case.expect,
                "{} — through IntakeFilter, which is the path the streamer takes",
                case.name
            );
        }
    }

    #[test]
    fn terms_are_anded() {
        let filter = IntakeFilter::new(&[
            QueryTerm::Text {
                value: "queue".to_string(),
            },
            QueryTerm::Level {
                op: LevelOp::AtLeast,
                value: LogLevel::Warn,
            },
        ]);

        let mut hit = line("queue full");
        hit.level = Some(LogLevel::Error);
        assert!(filter.matches(&hit, 0));

        let mut wrong_level = line("queue full");
        wrong_level.level = Some(LogLevel::Info);
        assert!(!filter.matches(&wrong_level, 0));

        let mut wrong_text = line("batch accepted");
        wrong_text.level = Some(LogLevel::Error);
        assert!(!filter.matches(&wrong_text, 0));
    }

    #[test]
    fn no_terms_keeps_everything() {
        assert!(IntakeFilter::default().matches(&line("anything"), 0));
    }

    #[test]
    fn a_text_term_is_tested_last() {
        // Reordering is only sound because terms are ANDed. It matters
        // because a text term scans the line and a level term compares
        // two numbers, and the discarded line is the one being paid for.
        let filter = IntakeFilter::new(&[
            QueryTerm::Text {
                value: "x".to_string(),
            },
            QueryTerm::Level {
                op: LevelOp::Is,
                value: LogLevel::Error,
            },
        ]);
        assert!(matches!(filter.terms[0], PreparedTerm::Other(_)));
        assert!(matches!(filter.terms[1], PreparedTerm::Text(_)));
    }

    #[test]
    fn a_time_term_becomes_a_smaller_request() {
        let terms = vec![
            QueryTerm::Time {
                from: 1_700_000_000_000,
                to: 1_700_000_060_000,
            },
            QueryTerm::Time {
                from: 1_700_000_030_000,
                to: 1_700_000_090_000,
            },
        ];
        // Two ranges ANDed start at the later of the two starts.
        assert_eq!(
            intake_since_time(&terms).map(|t| t.timestamp_millis()),
            Some(1_700_000_030_000)
        );
        assert_eq!(intake_since_time(&[]), None);
    }

    #[test]
    fn pushing_since_to_the_cluster_cannot_change_what_matches() {
        // The pushdown only withholds lines older than the bound, and
        // the term rejects those anyway — so the predicate stays whole
        // and the two can never disagree about a line either one sees.
        let term = QueryTerm::Time {
            from: 1_700_000_000_000,
            to: 1_700_000_060_000,
        };
        let bound = intake_since_time(std::slice::from_ref(&term))
            .expect("a time term implies a bound")
            .timestamp_millis();
        let log = line("anything");
        for epoch in [bound - 1, bound, bound + 1, 1_700_000_060_001] {
            let withheld_by_cluster = epoch < bound;
            assert!(!(withheld_by_cluster && term.matches(&log, epoch)));
        }
    }
}
