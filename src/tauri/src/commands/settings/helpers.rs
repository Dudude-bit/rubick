//! Internal helpers shared by every settings command — load /
//! modify-and-save / read patterns over `AppConfig`.

use std::path::Path;
use std::sync::{Mutex, PoisonError};

use crate::config::AppConfig;
use crate::error::{Error, Result};

/// One load, modify and save at a time. A save that left the main thread can
/// meet another, and the second to write would drop the first one's change.
static WRITES: Mutex<()> = Mutex::new(());

pub fn save_config(config: &AppConfig) -> Result<()> {
    save_config_to(&AppConfig::config_path()?, config)
}

fn save_config_to(config_path: &Path, config: &AppConfig) -> Result<()> {
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::Config(format!("Failed to create config directory: {e}")))?;
    }

    let toml_str = toml::to_string_pretty(config)
        .map_err(|e| Error::Config(format!("Failed to serialize config: {e}")))?;

    // Not `std::fs::write`: this file holds bearer tokens, and that call
    // would leave them at the umask's mercy.
    crate::config::private_file::write(config_path, toml_str.as_bytes())
        .map_err(|e| Error::Config(format!("Failed to write config file: {e}")))?;

    Ok(())
}

/// Execute a modification on the config and save it automatically.
/// Reduces boilerplate for load -> modify -> save pattern.
pub fn with_config<F>(f: F) -> Result<()>
where
    F: FnOnce(&mut AppConfig),
{
    with_config_at(&AppConfig::config_path()?, f)
}

fn with_config_at<F>(path: &Path, f: F) -> Result<()>
where
    F: FnOnce(&mut AppConfig),
{
    let _one_at_a_time = WRITES.lock().unwrap_or_else(PoisonError::into_inner);
    let mut config = AppConfig::load_from(path)?;
    f(&mut config);
    save_config_to(path, &config)
}

/// [`with_config`] on a blocking thread, for a command that must not hold the
/// window. A save ends in an fsync, which takes seconds on a busy disk, and a
/// sync command runs on the thread that draws the window: nothing was
/// repainted until it returned.
pub async fn with_config_in_background<F>(f: F) -> Result<()>
where
    F: FnOnce(&mut AppConfig) + Send + 'static,
{
    let path = AppConfig::config_path()?;
    off_main(move || with_config_at(&path, f)).await
}

async fn off_main<T, W>(work: W) -> Result<T>
where
    T: Send + 'static,
    W: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| Error::Internal(format!("The config write did not finish: {e}")))?
}

/// Execute a read operation on the config.
/// Reduces boilerplate for load -> read pattern.
pub fn read_config<F, T>(f: F) -> Result<T>
where
    F: FnOnce(&AppConfig) -> T,
{
    let config = AppConfig::load()?;
    Ok(f(&config))
}

#[cfg(test)]
mod tests {
    use super::{off_main, with_config_at};
    use crate::config::AppConfig;

    /// The theme's save left the main thread, where every save used to wait
    /// its turn. Fails if two saves that meet can each load the file before
    /// the other writes it, so one change is lost.
    #[test]
    fn saves_that_meet_keep_every_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let writers: Vec<_> = (0..8)
            .map(|writer| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for save in 0..5 {
                        with_config_at(&path, |config| {
                            config
                                .yaml_editor
                                .history
                                .insert(format!("{writer}-{save}"), Vec::new());
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let config = AppConfig::load_from(&path).unwrap();
        assert_eq!(config.yaml_editor.history.len(), 40);
    }

    /// Dana's theme switch landed when its save returned, 1.7 to 3.2 s after
    /// the click. Fails if a background save runs on the thread that asked.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_background_save_runs_off_the_thread_that_asked() {
        let asked = std::thread::current().id();
        let ran = off_main(|| Ok(std::thread::current().id())).await.unwrap();
        assert_ne!(ran, asked);
    }
}
