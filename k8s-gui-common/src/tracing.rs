//! Tracing initialization utilities
//!
//! Provides a unified way to initialize tracing across all Rubick projects.

use std::path::{Path, PathBuf};

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

/// The file the current run is written to, inside {@link log_dir}.
pub const LOG_FILE: &str = "rubick.log";

/// How many previous runs are kept beside it.
const KEPT: usize = 4;

/// Initialize tracing subscriber with default configuration
///
/// This function sets up the tracing subscriber with:
/// - Environment variable filter (RUST_LOG) or default "info" level
/// - Standard formatting layer on stderr
/// - A plain-text file in `dir`, when one is given
///
/// The file is the point. A packaged Windows build has no console attached,
/// so stderr reaches nobody and a reader who hits something once has nothing
/// to hand over. It is written at the same level as stderr, so `RUST_LOG`
/// deepens both.
///
/// # Panics
///
/// This function will panic if tracing is already initialized.
pub fn init_tracing(dir: Option<&Path>) {
    let filter = || EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let registry =
        tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_filter(filter()));

    let Some(dir) = dir else {
        registry.init();
        return;
    };
    match open_log(dir) {
        Ok(file) => registry
            .with(
                tracing_subscriber::fmt::layer()
                    // A file nobody is looking at through a terminal: the
                    // escape codes would only make it harder to read.
                    .with_ansi(false)
                    .with_writer(file)
                    .with_filter(filter()),
            )
            .init(),
        Err(error) => {
            registry.init();
            // After `init`, so it goes through the subscriber that exists.
            tracing::warn!(%error, path = %dir.display(), "no log file this run");
        }
    }
}

/// The previous run's file rolled aside, and a fresh one opened. Rolled on
/// start rather than by size: what a reader is asked for is "the log from
/// when it happened", and one file per run is the shape that answers it.
fn open_log(dir: &Path) -> std::io::Result<std::fs::File> {
    std::fs::create_dir_all(dir)?;
    let current = dir.join(LOG_FILE);
    if current.exists() {
        for index in (1..KEPT).rev() {
            let _ = std::fs::rename(rolled(dir, index), rolled(dir, index + 1));
        }
        let _ = std::fs::rename(&current, rolled(dir, 1));
    }
    std::fs::File::create(&current)
}

fn rolled(dir: &Path, index: usize) -> PathBuf {
    dir.join(format!("{LOG_FILE}.{index}"))
}

/// Where the logs go, by the convention of each platform.
///
/// Computed here rather than asked of Tauri because tracing is initialised
/// before the app is built — a hang in the login-shell import happens before
/// there is an `AppHandle` to ask, and that is exactly the hang somebody
/// will want the file for.
#[must_use]
pub fn log_dir(bundle: &str) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|home| home.join("Library/Logs").join(bundle))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_local_dir().map(|base| base.join(bundle).join("logs"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reader hitting something once is asked for "the log from when it
    /// happened". One file per run, with the few before it still there, is
    /// what answers that; a single file overwritten in place loses the run
    /// they actually want the moment they restart to reproduce it.
    #[test]
    fn each_run_gets_its_own_file_and_the_ones_before_it_survive() {
        let dir = std::env::temp_dir().join(format!("rubick-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        for run in 1..=3 {
            let mut file = open_log(&dir).expect("a log file");
            use std::io::Write;
            writeln!(file, "run {run}").expect("written");
        }

        assert_eq!(
            std::fs::read_to_string(dir.join(LOG_FILE)).unwrap().trim(),
            "run 3"
        );
        assert_eq!(
            std::fs::read_to_string(rolled(&dir, 1)).unwrap().trim(),
            "run 2"
        );
        assert_eq!(
            std::fs::read_to_string(rolled(&dir, 2)).unwrap().trim(),
            "run 1"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
