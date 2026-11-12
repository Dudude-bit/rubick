//! Persisted port-forward configurations — list / create / update /
//! delete the saved configs that live in `AppConfig.port_forward`.

use crate::commands::settings::{read_config, update_config};
use crate::error::{Error, Result};

use super::types::{
    config_key, map_config, normalize_port_forward_config, PortForwardConfigInfo,
    PortForwardConfigPayload,
};

/// List saved port-forward configs
#[tauri::command]
pub async fn list_port_forward_configs() -> Result<Vec<PortForwardConfigInfo>> {
    read_config(|config| config.port_forward.configs.iter().map(map_config).collect()).await
}

/// Create a saved port-forward config
#[tauri::command]
pub async fn create_port_forward_config(
    payload: PortForwardConfigPayload,
) -> Result<PortForwardConfigInfo> {
    let created_at = chrono::Utc::now().to_rfc3339();
    let id = crate::utils::generate_id("pf-config");
    let config = normalize_port_forward_config(&payload, id, created_at)?;

    update_config(move |app_config| {
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
        let info = map_config(&config);
        app_config.port_forward.configs.push(config);
        Ok(info)
    })
    .await
}

/// Update an existing port-forward config
#[tauri::command]
pub async fn update_port_forward_config(
    id: String,
    payload: PortForwardConfigPayload,
) -> Result<PortForwardConfigInfo> {
    update_config(move |app_config| {
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

        let info = map_config(&updated);
        app_config.port_forward.configs[index] = updated;
        Ok(info)
    })
    .await
}

/// Delete a saved port-forward config
#[tauri::command]
pub async fn delete_port_forward_config(id: String) -> Result<()> {
    update_config(move |app_config| {
        let before = app_config.port_forward.configs.len();
        app_config.port_forward.configs.retain(|item| item.id != id);
        if before == app_config.port_forward.configs.len() {
            return Err(Error::InvalidInput(
                "Port-forward config not found".to_string(),
            ));
        }
        Ok(())
    })
    .await
}
