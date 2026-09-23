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
/// browser does with a second download of the same name — created empty.
///
/// Taken by creating it, not by looking first: two downloads at once saw
/// the same free name and the second overwrote the first.
///
/// # Errors
///
/// When the file cannot be created, or every name is taken.
pub async fn create_unused(
    dir: &Path,
    stem: &str,
    extension: &str,
) -> std::io::Result<(PathBuf, tokio::fs::File)> {
    create_within(dir, stem, extension, 10_000).await
}

async fn create_within(
    dir: &Path,
    stem: &str,
    extension: &str,
    names: u32,
) -> std::io::Result<(PathBuf, tokio::fs::File)> {
    for n in 0..names {
        let name = match n {
            0 => format!("{stem}.{extension}"),
            n => format!("{stem} ({n}).{extension}"),
        };
        let path = dir.join(name);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!("every name for {stem}.{extension} is taken"),
    ))
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
    #[tokio::test]
    async fn a_taken_name_gets_a_number() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (first, _) = create_unused(dir.path(), "web-app", "log").await.unwrap();
        assert_eq!(first, dir.path().join("web-app.log"));
        let (second, _) = create_unused(dir.path(), "web-app", "log").await.unwrap();
        assert_eq!(second, dir.path().join("web-app (1).log"));
    }

    /// Would let two downloads started together write to one file: the name
    /// was only looked at, so both saw it free.
    #[tokio::test]
    async fn two_downloads_at_once_get_two_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, b) = tokio::join!(
            create_unused(dir.path(), "web-app", "log"),
            create_unused(dir.path(), "web-app", "log"),
        );
        assert_ne!(a.unwrap().0, b.unwrap().0);
    }

    /// Would overwrite the first file once every numbered name was taken.
    #[tokio::test]
    async fn with_every_name_taken_nothing_is_overwritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = dir.path().join("web-app.log");
        std::fs::write(&first, "kept").unwrap();
        std::fs::write(dir.path().join("web-app (1).log"), "kept").unwrap();

        assert!(create_within(dir.path(), "web-app", "log", 2)
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "kept");
    }
}
