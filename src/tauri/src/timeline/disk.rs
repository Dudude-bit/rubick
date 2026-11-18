//! A cluster's timeline on disk: `state.json`, rewritten whole, with the
//! cluster's identity, its spans and what was let go; and each class of row
//! appended to segments of its own, so a flood of normal events is pruned
//! without taking a warning or a change with it. Every file is the owner's
//! alone, written as `config.toml` is.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::store::Class;
use super::{LetGo, LetGoes, SpanSets, TimelineRow, KEEP_FOR_MS};
use crate::config::private_file;

/// A segment past this size is closed and the next one opened.
pub(super) const SEGMENT_BYTES: u64 = 4 * 1024 * 1024;

const STATE: &str = "state.json";

/// Segments each class keeps; past them the oldest goes.
const fn segments_of(class: Class) -> usize {
    match class {
        Class::Changes => 8,
        Class::Warnings | Class::Normal => 4,
    }
}

const fn stem(class: Class) -> &'static str {
    match class {
        Class::Changes => "changes",
        Class::Warnings => "warnings",
        Class::Normal => "normal",
    }
}

const CLASSES: [Class; 3] = [Class::Changes, Class::Warnings, Class::Normal];

/// The rows recorded since the last write, and whether to start over first.
#[derive(Default)]
pub(super) struct Pending {
    pub rows: Vec<TimelineRow>,
    pub wipe: bool,
    /// Rows by `seq` to take out of what is kept, another cluster's: done
    /// again after a failure, and nothing in them is appended.
    pub drop: Vec<(u64, u64)>,
}

fn dropped(drop: &[(u64, u64)], seq: u64) -> bool {
    drop.iter()
        .any(|(first, last)| (*first..=*last).contains(&seq))
}

/// The rows numbered inside `drop` taken out of every segment: what was
/// kept and is not another cluster's stays, and nothing held only in
/// memory is written by it.
fn drop_rows(dir: &Path, drop: &[(u64, u64)]) -> std::io::Result<()> {
    #[derive(Deserialize)]
    struct Numbered {
        seq: u64,
    }
    for (_, path) in segments(dir).into_values().flatten() {
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let kept: String = text
            .lines()
            .filter(|line| {
                serde_json::from_str::<Numbered>(line).map_or(true, |row| !dropped(drop, row.seq))
            })
            .map(|line| format!("{line}\n"))
            .collect();
        if kept != text {
            private_file::write(&path, kept.as_bytes())?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct State {
    pub context: String,
    pub identity: Option<String>,
    pub spans: SpanSets,
    pub let_go: LetGoes,
    /// Read leniently: a list that does not parse vouches for nothing.
    #[serde(default, deserialize_with = "lenient")]
    pub lineages: Vec<Lineage>,
}

/// One stretch of recording through one connection, from a start or a
/// reconnect to the next. The cluster read through it vouches for its rows
/// and its watching; one never read vouches for nothing, in any later run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Lineage {
    /// The `kube-system` uid read through this connection.
    #[serde(default)]
    pub uid: Option<String>,
    /// Its first and last row, by `seq`.
    pub first: u64,
    pub last: u64,
    pub from: i64,
    pub to: i64,
}

fn lenient<'de, D: serde::Deserializer<'de>>(read: D) -> Result<Vec<Lineage>, D::Error> {
    let value = serde_json::Value::deserialize(read)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// What was read back from one cluster's folder.
#[derive(Default)]
pub(super) struct Loaded {
    pub rows: Vec<TimelineRow>,
    pub spans: SpanSets,
    pub let_go: LetGoes,
    pub identity: Option<String>,
    pub lineages: Vec<Lineage>,
    pub unreadable: usize,
}

/// One cluster's folder. Named by a digest of the context name, which may
/// hold anything a file name may not.
pub(super) fn dir_of(root: &Path, context: &str) -> PathBuf {
    let digest = Sha256::digest(context.as_bytes());
    let name = digest[..16].iter().fold(String::new(), |mut name, byte| {
        use std::fmt::Write;
        let _ = write!(name, "{byte:02x}");
        name
    });
    root.join(name)
}

/// Each class's segments, oldest first.
fn segments(dir: &Path) -> BTreeMap<&'static str, Vec<(u64, PathBuf)>> {
    let mut out: BTreeMap<&'static str, Vec<(u64, PathBuf)>> = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some((class, number)) = name
            .strip_suffix(".jsonl")
            .and_then(|rest| rest.rsplit_once('-'))
        else {
            continue;
        };
        let (Some(class), Ok(number)) = (
            CLASSES.iter().map(|c| stem(*c)).find(|s| *s == class),
            number.parse::<u64>(),
        ) else {
            continue;
        };
        out.entry(class).or_default().push((number, path));
    }
    for list in out.values_mut() {
        list.sort();
    }
    out
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

pub(super) fn load(dir: &Path, now: i64) -> Loaded {
    let mut loaded = Loaded::default();
    if let Ok(text) = std::fs::read(dir.join(STATE)) {
        match serde_json::from_slice::<State>(&text) {
            Ok(state) => {
                loaded.spans = state.spans;
                loaded.let_go = state.let_go;
                loaded.identity = state.identity;
                loaded.lineages = state.lineages;
            }
            Err(_) => loaded.unreadable += 1,
        }
    }
    for list in segments(dir).into_values() {
        for (_, path) in list {
            if modified_ms(&path).is_some_and(|at| now - at > KEEP_FOR_MS) {
                continue;
            }
            let Ok(file) = std::fs::File::open(&path) else {
                loaded.unreadable += 1;
                continue;
            };
            for line in BufReader::new(file).lines() {
                match line.map(|line| serde_json::from_str::<TimelineRow>(&line)) {
                    Ok(Ok(row)) => loaded.rows.push(row),
                    _ => loaded.unreadable += 1,
                }
            }
        }
    }
    loaded.rows.sort_by_key(|row| row.seq);
    loaded
}

/// Writes what was recorded and the state beside it. `state` is `None` when
/// keeping is off: then only a wipe is done. Returns what a size bound let go.
pub(super) fn write(
    dir: &Path,
    pending: &Pending,
    state: Option<&State>,
    now: i64,
) -> std::io::Result<LetGoes> {
    if pending.wipe {
        match std::fs::remove_dir_all(dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    if !pending.drop.is_empty() {
        drop_rows(dir, &pending.drop)?;
    }
    let Some(state) = state else {
        return Ok(LetGoes::default());
    };
    private_file::dir(dir)?;
    // Before choosing where to append: a segment past its age is not one.
    let aged = prune(&segments(dir), now);
    let mut held = segments(dir);
    for class in CLASSES {
        let mut lines = Vec::new();
        for row in pending
            .rows
            .iter()
            .filter(|row| Class::of(&row.what) == class && !dropped(&pending.drop, row.seq))
        {
            serde_json::to_writer(&mut lines, row).map_err(std::io::Error::other)?;
            lines.push(b'\n');
        }
        if lines.is_empty() {
            continue;
        }
        let list = held.entry(stem(class)).or_default();
        let open = list
            .last()
            .filter(|(_, path)| std::fs::metadata(path).map_or(0, |m| m.len()) < SEGMENT_BYTES)
            .map(|(_, path)| path.clone());
        let path = open.unwrap_or_else(|| {
            let next = list.last().map_or(1, |(number, _)| number + 1);
            let path = dir.join(format!("{}-{next:06}.jsonl", stem(class)));
            list.push((next, path.clone()));
            path
        });
        private_file::append(&path, &lines)?;
    }
    let let_go = merged(aged, prune(&held, now));
    let state = State {
        let_go: merged(state.let_go, let_go),
        ..state.clone()
    };
    let text = serde_json::to_vec(&state).map_err(std::io::Error::other)?;
    private_file::write(&dir.join(STATE), &text)?;
    Ok(let_go)
}

/// Drops segments past their age, which no window reaches, and past their
/// class's count, which is said: a row that went with one was let go.
fn prune(held: &BTreeMap<&'static str, Vec<(u64, PathBuf)>>, now: i64) -> LetGoes {
    let mut let_go = LetGoes::default();
    for class in CLASSES {
        let Some(list) = held.get(stem(class)) else {
            continue;
        };
        let over = list.len().saturating_sub(segments_of(class));
        for (index, (_, path)) in list.iter().enumerate() {
            let at = modified_ms(path);
            let old = at.is_some_and(|at| now - at > KEEP_FOR_MS);
            if index >= over && !old {
                continue;
            }
            if std::fs::remove_file(path).is_ok() && !old {
                let said = LetGo {
                    before: at.unwrap_or(now),
                    cleared: false,
                };
                let slot = match class {
                    Class::Changes => &mut let_go.changes,
                    Class::Warnings => &mut let_go.warnings,
                    Class::Normal => &mut let_go.normal,
                };
                *slot = Some(slot.map_or(said, |was| LetGo {
                    before: was.before.max(said.before),
                    cleared: false,
                }));
            }
        }
    }
    let_go
}

/// The later of two accounts of what each class let go.
pub(super) fn merged(a: LetGoes, b: LetGoes) -> LetGoes {
    let later = |a: Option<LetGo>, b: Option<LetGo>| match (a, b) {
        (Some(a), Some(b)) => Some(if b.before > a.before { b } else { a }),
        (a, b) => a.or(b),
    };
    LetGoes {
        changes: later(a.changes, b.changes),
        warnings: later(a.warnings, b.warnings),
        normal: later(a.normal, b.normal),
    }
}

/// How many bytes are kept, in how many clusters' folders.
pub(super) fn measure(root: &Path) -> (u64, usize) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return (0, 0);
    };
    let mut bytes = 0;
    let mut clusters = 0;
    for entry in entries.flatten() {
        let Ok(files) = std::fs::read_dir(entry.path()) else {
            continue;
        };
        clusters += 1;
        bytes += files
            .flatten()
            .filter_map(|file| file.metadata().ok())
            .map(|meta| meta.len())
            .sum::<u64>();
    }
    (bytes, clusters)
}

/// Removes every cluster's folder.
pub(super) fn clear(root: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(root) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}
