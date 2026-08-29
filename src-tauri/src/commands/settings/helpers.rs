//! Internal helpers shared by every settings command — load /
//! modify-and-save / read patterns over `AppConfig`.

use crate::config::AppConfig;
use crate::error::{Error, Result};

pub fn save_config(config: &AppConfig) -> Result<()> {
    let config_path = AppConfig::config_path()?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::Config(format!("Failed to create config directory: {e}")))?;
    }

    let toml_str = toml::to_string_pretty(config)
        .map_err(|e| Error::Config(format!("Failed to serialize config: {e}")))?;

    // Not `std::fs::write`: this file holds bearer tokens and the registry
    // password, and that call would leave them at the umask's mercy.
    crate::config::private_file::write(&config_path, toml_str.as_bytes())
        .map_err(|e| Error::Config(format!("Failed to write config file: {e}")))?;

    Ok(())
}

/// Execute a modification on the config and save it automatically.
/// Reduces boilerplate for load -> modify -> save pattern.
pub fn with_config<F>(f: F) -> Result<()>
where
    F: FnOnce(&mut AppConfig),
{
    let mut config = AppConfig::load()?;
    f(&mut config);
    save_config(&config)
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
