//! The two line formats the ladder produces, parsed into one row.

use serde::{Deserialize, Serialize};

/// `find -printf`: type, mode, size, mtime, owner, group, name, link target.
pub const GNU_FORMAT: &str = "%y\\t%m\\t%s\\t%T@\\t%u\\t%g\\t%f\\t%l\\n";

/// A `sh` loop over busybox `stat`, one tab-separated line per entry.
/// `%N` quotes the name and, for a link, appends ` -> 'target'`.
///
/// The two guards are the whole point of the first two lines. Without them a
/// directory this container may not open expands neither glob, every `[ -e ]`
/// fails, the loop `continue`s twice and exits **0 with no output** — which
/// the caller could only read as "the directory is empty". A refusal drawn as
/// an empty directory is exactly what this module says it must never do, and
/// on any busybox image (where this rung is the one that answers) it was what
/// every unreadable or absent path did. `exit 2` puts it in `Listing::Failed`
/// instead; 2 is neither 0 nor 127, so it is a failure and not a missing tool.
///
/// The `.`/`..` arm skips unconditionally. It used to run
/// `[ -e "$f" ] || [ -L "$f" ] || continue`, which short-circuits on the first
/// success — and `.` and `..` always exist — so the skip never fired and both
/// were listed as rows.
///
/// The `|| echo` and the closing `exit 0` are the same guarantee one entry
/// down. `stat` can fail for a single entry — a race with a delete, a mount
/// the container may not traverse — and it was the last command in the loop
/// body, so what happened depended on where in the glob the entry sat.
/// Reproduced in busybox 1.36: a **middle** entry failing printed nothing and
/// the script exited **0**, so the row was silently absent from a listing
/// reported as whole; the **last** entry failing exited **1**, so a directory
/// that had been read completely was reported as a failure. `echo` of
/// [`UNREADABLE`] makes the first case a counted hole — no real `stat` line
/// can be mistaken for it, since every one carries seven tabs — and `exit 0`
/// makes the status say what the two guards decided rather than what the last
/// entry happened to do.
pub const BUSYBOX_SCRIPT: &str = r#"d="$1"
[ -d "$d" ] || exit 2
ls -A "$d" >/dev/null 2>&1 || exit 2
for f in "$d"/.* "$d"/*; do
  case "${f##*/}" in
    .|..) continue;;
    '*'|'.*') [ -e "$f" ] || [ -L "$f" ] || continue;;
  esac
  [ -e "$f" ] || [ -L "$f" ] || continue
  stat -c '%F	%a	%s	%Y	%U	%G	%n	%N' "$f" 2>/dev/null || echo '?'
done
exit 0"#;

/// The line [`BUSYBOX_SCRIPT`] prints for an entry it could not `stat`. It
/// parses as nothing, which is what puts it in the unreadable count.
pub const UNREADABLE: &str = "?";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: FileKind,
    /// Octal, as the tool printed it: `644`, `755`.
    pub mode: String,
    pub size: u64,
    /// Seconds since the epoch; `None` when the tool gave none.
    pub modified: Option<i64>,
    pub owner: String,
    pub group: String,
    /// Where a symlink points, as written.
    pub target: Option<String>,
}

/// Both formats are eight tab-separated fields, so a line with any other
/// number of tabs is not one entry.
///
/// A filename may hold a tab or a newline — nothing but `/` and NUL is
/// forbidden — and both tools write the name raw. Reproduced with GNU find in
/// debian: `report\t2026.csv` came back as a ninth field, so `splitn(8)` put
/// the tail in the link-target slot and a plain file was drawn as a symlink to
/// `2026.csv`; `note\nb.txt` split one entry across two lines, each of which
/// parsed into a row for a file that does not exist. A row nobody can read
/// unambiguously is a hole in the listing, and `None` is what the caller
/// counts as one.
const FIELDS: usize = 8;

/// One `find -printf` line.
#[must_use]
pub fn gnu_find_line(line: &str) -> Option<FileEntry> {
    if line.matches('\t').count() != FIELDS - 1 {
        return None;
    }
    let mut parts = line.splitn(FIELDS, '\t');
    let kind = match parts.next()? {
        "f" => FileKind::File,
        "d" => FileKind::Dir,
        "l" => FileKind::Symlink,
        _ => FileKind::Other,
    };
    let mode = parts.next()?.to_string();
    let size = parts.next()?.parse::<u64>().unwrap_or(0);
    let modified = parts
        .next()?
        .split('.')
        .next()
        .and_then(|s| s.parse::<i64>().ok());
    let owner = parts.next()?.to_string();
    let group = parts.next()?.to_string();
    let name = parts.next()?.to_string();
    let target = parts.next().filter(|t| !t.is_empty()).map(str::to_string);
    if name.is_empty() {
        return None;
    }
    Some(FileEntry {
        name,
        kind,
        mode,
        size,
        modified,
        owner,
        group,
        target,
    })
}

/// One busybox `stat -c` line.
#[must_use]
pub fn busybox_stat_line(line: &str) -> Option<FileEntry> {
    if line.matches('\t').count() != FIELDS - 1 {
        return None;
    }
    let mut parts = line.splitn(FIELDS, '\t');
    let kind = match parts.next()? {
        "directory" => FileKind::Dir,
        "regular file" | "regular empty file" => FileKind::File,
        "symbolic link" => FileKind::Symlink,
        _ => FileKind::Other,
    };
    let mode = parts.next()?.to_string();
    let size = parts.next()?.parse::<u64>().unwrap_or(0);
    let modified = parts.next()?.parse::<i64>().ok();
    let owner = parts.next()?.to_string();
    let group = parts.next()?.to_string();
    let full = parts.next()?;
    let quoted = parts.next().unwrap_or("");
    let name = full.rsplit('/').next().unwrap_or(full).to_string();
    if name.is_empty() {
        return None;
    }
    // `'a' -> 'b'`: the target is whatever follows the arrow, unquoted.
    let target = quoted
        .split_once(" -> ")
        .map(|(_, t)| t.trim().trim_matches('\'').to_string())
        .filter(|t| !t.is_empty());
    Some(FileEntry {
        name,
        kind,
        mode,
        size,
        modified,
        owner,
        group,
        target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gnu_find_line_becomes_a_row_with_its_link_target() {
        let row = gnu_find_line(
            "l\t777\t22\t1725000000.1234\troot\troot\tcurrent\t../releases/2026-09-01",
        )
        .expect("parses");
        assert_eq!(row.kind, FileKind::Symlink);
        assert_eq!(row.name, "current");
        assert_eq!(row.modified, Some(1_725_000_000));
        assert_eq!(row.target.as_deref(), Some("../releases/2026-09-01"));

        let file =
            gnu_find_line("f\t644\t1234\t1725000000.0\tapp\tapp\tapp.conf\t").expect("parses");
        assert_eq!(file.kind, FileKind::File);
        assert_eq!(file.size, 1234);
        assert_eq!(file.target, None);
    }

    #[test]
    fn a_busybox_stat_line_keeps_the_basename_and_the_arrow_target() {
        let row = busybox_stat_line(
            "symbolic link\t777\t22\t1725000000\troot\troot\t/etc/app/current\t'/etc/app/current' -> '../releases/2026-09-01'",
        )
        .expect("parses");
        assert_eq!(row.name, "current");
        assert_eq!(row.kind, FileKind::Symlink);
        assert_eq!(row.target.as_deref(), Some("../releases/2026-09-01"));

        let dir = busybox_stat_line(
            "directory\t755\t4096\t1725000000\troot\troot\t/etc/app/conf.d\t'/etc/app/conf.d'",
        )
        .expect("parses");
        assert_eq!(dir.kind, FileKind::Dir);
        assert_eq!(dir.name, "conf.d");
        assert_eq!(dir.target, None);
    }

    /// A stray line on stdout (a warning, a prompt) must not become a file.
    #[test]
    fn garbage_is_dropped_rather_than_listed() {
        assert!(gnu_find_line("find: warning: something").is_none());
        assert!(busybox_stat_line("").is_none());
    }

    /// The rung that answers on every busybox image used to exit 0 with no
    /// output for a directory it could not open, which the caller can only
    /// read as "empty". Reproduced live in alpine: `/root` as non-root gave
    /// rc=0 and no lines. The guards make it `exit 2`, which is neither 0 nor
    /// 127, so it lands in `Listing::Failed`. Fails if a guard is removed.
    #[test]
    fn the_busybox_rung_refuses_rather_than_reporting_an_empty_directory() {
        assert!(
            BUSYBOX_SCRIPT.contains(r#"[ -d "$d" ] || exit 2"#),
            "lost the not-a-directory guard"
        );
        assert!(
            BUSYBOX_SCRIPT.contains(r#"ls -A "$d" >/dev/null 2>&1 || exit 2"#),
            "lost the unreadable-directory guard"
        );
    }

    /// `.` and `..` always exist, so the old
    /// `[ -e "$f" ] || [ -L "$f" ] || continue` short-circuited on the first
    /// success and never skipped them: both were listed as rows, and the same
    /// directory had two different counts depending on which rung answered.
    #[test]
    fn the_busybox_rung_skips_dot_and_dotdot_unconditionally() {
        assert!(
            BUSYBOX_SCRIPT.contains(".|..) continue;;"),
            "the dot skip must not depend on the entry existing"
        );
    }

    /// `stat` can fail for one entry while the directory is perfectly
    /// readable. It was the last command in the loop body, so busybox 1.36
    /// gave two different answers for the same failure depending on where in
    /// the glob the entry sat: a middle entry exited 0 with the row simply
    /// gone (a listing that says it is whole, with a file missing), and the
    /// last entry exited 1 (a directory that was read reported as a failure).
    /// Fails if either half of the fix is removed.
    #[test]
    fn a_single_unstattable_entry_is_a_counted_hole_and_not_a_failed_listing() {
        assert!(
            BUSYBOX_SCRIPT.contains(&format!("2>/dev/null || echo '{UNREADABLE}'")),
            "an entry stat could not read must leave something behind to count"
        );
        assert!(
            BUSYBOX_SCRIPT.trim_end().ends_with("exit 0"),
            "the status must not be whatever the last entry's stat returned"
        );
        assert!(
            busybox_stat_line(UNREADABLE).is_none(),
            "the marker must not parse into a row; refusing it is what counts it"
        );
        // Every real line carries seven tabs, so nothing stat prints can be
        // taken for the marker — including a file actually named "?".
        let named_question_mark =
            busybox_stat_line("regular file\t644\t0\t1725000000\troot\troot\t/d/?\t'/d/?'")
                .expect("parses");
        assert_eq!(named_question_mark.name, "?");
    }

    /// A filename may hold a tab or a newline, and both tools write the name
    /// raw. Reproduced with GNU find in debian: the tab added a ninth field,
    /// so `splitn(8)` put the tail in the link-target slot and a plain file
    /// was drawn as a symlink; the newline split one entry across two lines,
    /// each of which parsed into a row for a file that is not there. Fails if
    /// the field count stops being checked.
    #[test]
    fn a_tab_or_a_newline_in_a_name_is_a_hole_and_not_an_invented_row() {
        // `report<TAB>2026.csv`: nine fields.
        assert!(
            gnu_find_line("f\t644\t9\t1725000000.0\tapp\tapp\treport\t2026.csv\t").is_none(),
            "a plain file must not come back as a symlink to part of its own name"
        );
        // `note<NEWLINE>b.txt`, as the two lines the reader actually sees.
        assert!(gnu_find_line("f\t644\t9\t1725000000.0\tapp\tapp\tnote").is_none());
        assert!(gnu_find_line("b.txt\t").is_none());
        assert!(busybox_stat_line(
            "regular file\t644\t9\t1725000000\tapp\tapp\t/d/a\tb\t'/d/a\tb'"
        )
        .is_none());

        // The ordinary lines still parse; the check is on the count, not on
        // the presence of a tab.
        assert!(gnu_find_line("f\t644\t9\t1725000000.0\tapp\tapp\tapp.conf\t").is_some());
    }
}
