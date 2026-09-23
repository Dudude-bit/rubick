//! A log as a text file: what the Download button saves.

use std::path::{Path, PathBuf};

use super::types::LogLine;

/// One line as the file carries it. The frontend's `logsToText` writes the
/// clipboard the same way; `shared/log-text-conformance.json` holds both to
/// it.
#[must_use]
pub fn line_text(line: &LogLine) -> String {
    if !line.raw.is_empty() {
        return line.raw.clone();
    }
    // The timestamp spelled the way it crosses IPC, so the file and the
    // clipboard agree on a line with nothing else to show.
    let stamp = line
        .timestamp
        .and_then(|at| serde_json::to_value(at).ok())
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    format!("{stamp} {}", line.message)
}

#[must_use]
pub fn log_text(lines: &[LogLine]) -> String {
    lines.iter().map(line_text).collect::<Vec<_>>().join("\n")
}

/// `name.log`, or `name (1).log` and so on when that is taken — what a
/// browser does with a second download of the same name.
#[must_use]
pub fn unused_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }
    (1..10_000)
        .map(|n| dir.join(format!("{stem} ({n}).{extension}")))
        .find(|path| !path.exists())
        .unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::types::LogFormat;

    fn line(raw: &str, timestamp: Option<&str>, message: &str) -> LogLine {
        LogLine {
            timestamp: timestamp.map(|at| at.parse().expect("an RFC 3339 time")),
            message: message.to_string(),
            level: None,
            format: LogFormat::Plain,
            fields: None,
            raw: raw.to_string(),
            segments: None,
            pod: "p".to_string(),
            container: "c".to_string(),
            namespace: "n".to_string(),
        }
    }

    /// Would break if the file and the clipboard wrote a line differently:
    /// a downloaded log and a copied one would disagree about the same line.
    #[test]
    fn a_line_reads_as_the_shared_corpus_says() {
        const CORPUS: &str = include_str!("../../../shared/log-text-conformance.json");
        let corpus: serde_json::Value = serde_json::from_str(CORPUS).expect("corpus parses");
        for case in corpus["cases"].as_array().expect("cases") {
            let given = &case["line"];
            let built = line(
                given["raw"].as_str().unwrap(),
                given["timestamp"].as_str(),
                given["message"].as_str().unwrap(),
            );
            assert_eq!(line_text(&built), case["text"].as_str().unwrap(), "{given}");
        }
    }

    #[test]
    fn lines_are_joined_with_no_newline_after_the_last() {
        let lines = [line("a", None, "a"), line("b", None, "b")];
        assert_eq!(log_text(&lines), "a\nb");
    }

    /// A second download of the same pod must not overwrite the first.
    #[test]
    fn a_taken_name_gets_a_number() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = unused_path(dir.path(), "web-app", "log");
        assert_eq!(first, dir.path().join("web-app.log"));
        std::fs::write(&first, "x").unwrap();
        assert_eq!(
            unused_path(dir.path(), "web-app", "log"),
            dir.path().join("web-app (1).log")
        );
    }
}
