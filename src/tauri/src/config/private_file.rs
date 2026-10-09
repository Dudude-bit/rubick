//! Writing `config.toml` so that only its owner can read it.
//!
//! The file holds the Prometheus and Loki bearer tokens and the registry
//! password in plain text — a deliberate choice, see
//! [`crate::config::integrations`] — but `std::fs::write` would leave them
//! where the rest of the machine can read them: it creates with `0666` masked
//! by the umask, which on a stock macOS or Linux account leaves `0644`.
//!
//! So a save writes a fresh neighbouring file and renames it over the target,
//! which buys two things. The scratch file is created `0600` and only then
//! filled, so the token is never briefly readable — chmod-ing after the write
//! would not give that. And a rename is atomic, so an interrupted save cannot
//! leave half a config behind.
//!
//! Renaming also replaces the inode, so a config already sitting at `0644`
//! from an older version heals the next time anything is saved; [`harden`]
//! covers the reader who never changes a setting again.
//!
//! On Windows there are no mode bits and this falls back to a plain replace:
//! the file inherits the ACL of `%APPDATA%`, which is already scoped to the
//! account.

use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Distinguishes the scratch files of two saves racing each other. The
/// process id alone is not enough — both would be this process.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(unix)]
const OWNER_ONLY: u32 = 0o600;

/// Write `bytes` to `path`, atomically, readable only by this user.
///
/// # Errors
///
/// Returns the underlying I/O error. The scratch file is removed first, so a
/// failure leaves neither a half-written config nor litter beside it.
pub fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let scratch = scratch_beside(path)?;

    match fill(&scratch, bytes).and_then(|()| std::fs::rename(&scratch, path)) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_file(&scratch);
            Err(err)
        }
    }
}

/// Take an existing file's permissions down to owner-only.
///
/// Best-effort and silent on failure: this runs on every config read, and a
/// file whose mode cannot be changed — a read-only mount, a config owned by
/// someone else — is not a reason to refuse to start. It is already the
/// wrong mode; refusing would only take the app away too.
pub fn harden(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let Ok(metadata) = std::fs::metadata(path) else {
            return;
        };
        // Every save already writes 0600, so the common path is a stat and
        // nothing else.
        if metadata.permissions().mode() & 0o777 == OWNER_ONLY {
            return;
        }
        let outcome = std::fs::set_permissions(path, std::fs::Permissions::from_mode(OWNER_ONLY));
        match outcome {
            Ok(()) => tracing::info!(
                "Tightened {} to owner-only; it held credentials at mode {:o}",
                path.display(),
                metadata.permissions().mode() & 0o777
            ),
            Err(err) => tracing::warn!("Could not tighten {}: {err}", path.display()),
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// A scratch name in the same directory, because a rename is only atomic
/// within one filesystem and `/tmp` is regularly a different one.
fn scratch_beside(path: &Path) -> std::io::Result<std::path::PathBuf> {
    let dir = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "config path has no directory to write beside",
        )
    })?;
    let stem = path
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("config.toml");
    Ok(dir.join(format!(
        ".{stem}.{}.{}.partial",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )))
}

/// Create the scratch file owner-only and fill it.
///
/// `create_new` rather than `create`: the name is unique, so an existing one
/// means something unexpected is there and overwriting it blindly is how a
/// scratch file becomes a place to plant something.
fn fill(scratch: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(OWNER_ONLY);
    }

    let mut file = options.open(scratch)?;
    file.write_all(bytes)?;
    // The rename is atomic, but only orders against data that has reached the
    // disk; without this a crash can leave the new name pointing at nothing.
    file.sync_all()
}

#[cfg(all(test, unix))]
mod tests {
    use super::{harden, write, OWNER_ONLY};
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    static DIRS: AtomicU32 = AtomicU32::new(0);

    /// A directory of our own per test: these run in parallel and all want a
    /// file called `config.toml`.
    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rubick-private-file-{}-{}-{label}",
            std::process::id(),
            DIRS.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("scratch directory");
        dir
    }

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path)
            .expect("the file exists")
            .permissions()
            .mode()
            & 0o777
    }

    /// What the security report asked for, as a test that runs the real code
    /// against a real filesystem rather than reasoning about the umask.
    #[test]
    fn a_written_config_is_readable_only_by_its_owner() {
        let dir = scratch_dir("fresh");
        let path = dir.join("config.toml");

        write(&path, b"token = \"secret\"\n").expect("write");

        assert_eq!(mode_of(&path), OWNER_ONLY, "mode is {:o}", mode_of(&path));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "token = \"secret\"\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The install that already exists. Renaming replaces the inode, so the
    /// old permissions do not survive the next save.
    #[test]
    fn saving_over_a_world_readable_config_takes_it_private() {
        let dir = scratch_dir("existing");
        let path = dir.join("config.toml");
        std::fs::write(&path, b"old\n").expect("seed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("seed mode");
        assert_eq!(mode_of(&path), 0o644, "the seed has to start wrong");

        write(&path, b"new\n").expect("write");

        assert_eq!(mode_of(&path), OWNER_ONLY);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reader who set a token once and never opened settings again: their
    /// file is never rewritten, so the fix has to reach it on the way in.
    #[test]
    fn reading_an_old_config_tightens_it_in_place() {
        let dir = scratch_dir("harden");
        let path = dir.join("config.toml");
        std::fs::write(&path, b"token = \"secret\"\n").expect("seed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("seed mode");

        harden(&path);

        assert_eq!(mode_of(&path), OWNER_ONLY);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "token = \"secret\"\n",
            "hardening must not disturb the contents"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A missing file is the first-run case, not an error to shout about.
    #[test]
    fn hardening_something_that_is_not_there_is_quiet() {
        let dir = scratch_dir("absent");
        harden(&dir.join("config.toml"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The scratch file is an implementation detail and must not outlive the
    /// call — least of all beside a config, where it would be a second copy
    /// of the same credentials.
    #[test]
    fn a_save_leaves_nothing_beside_the_config() {
        let dir = scratch_dir("litter");
        let path = dir.join("config.toml");

        write(&path, b"a\n").expect("first");
        write(&path, b"b\n").expect("second");

        let left: Vec<_> = std::fs::read_dir(&dir)
            .expect("listing")
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        assert_eq!(
            left,
            vec!["config.toml".to_string()],
            "left behind: {left:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
