//! Reading and changing `config.toml` for the commands, always on a blocking
//! thread. A sync command runs on the thread that draws the window, and a save
//! ends in an fsync, which took seconds on a busy disk: nothing was repainted
//! and no other answer arrived until it returned.

use std::path::Path;
use std::sync::{Mutex, PoisonError};

use crate::config::AppConfig;
use crate::error::{Error, Result};

/// One load, modify and save at a time. Two saves that meet off the main
/// thread would otherwise each load the file, and the second to write would
/// drop the first one's change.
static WRITES: Mutex<()> = Mutex::new(());

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

/// A change that fails leaves the file as it was.
fn update_at<T, F>(path: &Path, f: F) -> Result<T>
where
    F: FnOnce(&mut AppConfig) -> Result<T>,
{
    let _one_at_a_time = WRITES.lock().unwrap_or_else(PoisonError::into_inner);
    let mut config = AppConfig::load_from(path)?;
    let changed = f(&mut config)?;
    save_config_to(path, &config)?;
    Ok(changed)
}

/// Load, change and save the config, in turn with every other change.
pub async fn update_config<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut AppConfig) -> Result<T> + Send + 'static,
{
    let path = AppConfig::config_path()?;
    off_main(move || update_at(&path, f)).await
}

/// [`update_config`] for a change that cannot fail.
pub async fn with_config<F>(f: F) -> Result<()>
where
    F: FnOnce(&mut AppConfig) + Send + 'static,
{
    update_config(move |config| {
        f(config);
        Ok(())
    })
    .await
}

pub async fn read_config<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&AppConfig) -> T + Send + 'static,
{
    off_main(move || AppConfig::load().map(|config| f(&config))).await
}

pub async fn off_main<T, W>(work: W) -> Result<T>
where
    T: Send + 'static,
    W: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| Error::Internal(format!("The disk work did not finish: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::{off_main, update_at};
    use crate::config::AppConfig;
    use crate::error::Error;

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
                        update_at(&path, |config| {
                            config
                                .yaml_editor
                                .history
                                .insert(format!("{writer}-{save}"), Vec::new());
                            Ok(())
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

    /// A duplicate port-forward config is refused inside the change. Fails if
    /// a refused change still writes what it did before refusing.
    #[test]
    fn a_change_that_fails_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let refused = update_at(&path, |config| -> crate::error::Result<()> {
            config.yaml_editor.history.insert("kept".into(), Vec::new());
            Err(Error::InvalidInput("refused".into()))
        });
        assert!(refused.is_err());
        assert!(!path.exists());
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
