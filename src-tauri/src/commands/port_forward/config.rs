//! Persisted port-forward configurations — list / create / update /
//! delete the saved configs that live in `AppConfig.port_forward`.

use crate::commands::settings::save_config;
use crate::config::AppConfig;
use crate::error::{Error, Result};

use super::types::{
    config_key, map_config, normalize_port_forward_config, PortForwardConfigInfo,
    PortForwardConfigPayload,
};

/// List saved port-forward configs
#[tauri::command]
pub fn list_port_forward_configs() -> Result<Vec<PortForwardConfigInfo>> {
    let config = AppConfig::load()?;
    Ok(config.port_forward.configs.iter().map(map_config).collect())
}

/// Create a saved port-forward config
#[tauri::command]
pub fn create_port_forward_config(
    payload: PortForwardConfigPayload,
) -> Result<PortForwardConfigInfo> {
    let mut app_config = AppConfig::load()?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let id = crate::utils::generate_id("pf-config");
    let config = normalize_port_forward_config(&payload, id, created_at)?;

    let key = config_key(&config);
    if app_config
        .port_forward
        .configs
        .iter()
        .any(|existing| config_key(existing) == key)
    {
        return Err(Error::InvalidInput(
            "Port-forward config already exists".to_string(),
        ));
    }

    app_config.port_forward.configs.push(config.clone());
    save_config(&app_config)?;
    Ok(map_config(&config))
}

/// Update an existing port-forward config
#[tauri::command]
pub fn update_port_forward_config(
    id: String,
    payload: PortForwardConfigPayload,
) -> Result<PortForwardConfigInfo> {
    let mut app_config = AppConfig::load()?;
    let index = app_config
        .port_forward
        .configs
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| Error::InvalidInput("Port-forward config not found".to_string()))?;

    let created_at = app_config.port_forward.configs[index].created_at.clone();
    let updated = normalize_port_forward_config(&payload, id.clone(), created_at)?;
    let key = config_key(&updated);
    if app_config
        .port_forward
        .configs
        .iter()
        .any(|existing| existing.id != id && config_key(existing) == key)
    {
        return Err(Error::InvalidInput(
            "Port-forward config already exists".to_string(),
        ));
    }

    app_config.port_forward.configs[index] = updated.clone();
    save_config(&app_config)?;
    Ok(map_config(&updated))
}

/// Delete a saved port-forward config
#[tauri::command]
pub fn delete_port_forward_config(id: String) -> Result<()> {
    let mut app_config = AppConfig::load()?;
    let before = app_config.port_forward.configs.len();
    app_config.port_forward.configs.retain(|item| item.id != id);
    if before == app_config.port_forward.configs.len() {
        return Err(Error::InvalidInput(
            "Port-forward config not found".to_string(),
        ));
    }
    save_config(&app_config)?;
    Ok(())
}
