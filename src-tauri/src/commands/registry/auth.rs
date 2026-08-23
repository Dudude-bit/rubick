//! Registry credential storage + Docker `config.json` import.
//!
//! Credentials are persisted on `AppConfig.registries.registries[id]`
//! alongside the connection settings. `import_docker_config` reads
//! `~/.docker/config.json` to bootstrap registry entries from the
//! user's existing docker-login state.

use crate::config::AppConfig;
use crate::error::{Error, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use dirs::home_dir;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use super::types::{DockerConfigFile, RegistryAuth, RegistryImportEntry};

pub(super) fn build_auth_header(auth: &RegistryAuth) -> Option<String> {
    match auth.auth_type.as_str() {
        "basic" => {
            let username = auth.username.as_ref()?.trim();
            let password = auth.password.as_ref()?.trim();
            if username.is_empty() || password.is_empty() {
                return None;
            }
            let encoded = STANDARD.encode(format!("{username}:{password}"));
            Some(format!("Basic {encoded}"))
        }
        "bearer" => {
            let token = auth.token.as_ref()?.trim();
            if token.is_empty() {
                return None;
            }
            Some(format!("Bearer {token}"))
        }
        _ => None,
    }
}

fn host_from_server(server: &str) -> String {
    server
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

fn is_docker_hub_host(host: &str) -> bool {
    matches!(
        host,
        "docker.io" | "index.docker.io" | "registry-1.docker.io"
    )
}

fn docker_config_path() -> Result<PathBuf> {
    let home =
        home_dir().ok_or_else(|| Error::Config("Unable to resolve home directory".to_string()))?;
    Ok(home.join(".docker").join("config.json"))
}

fn decode_basic_auth(encoded: &str) -> Option<(String, String)> {
    let decoded = STANDARD.decode(encoded.trim()).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let mut parts = decoded.splitn(2, ':');
    let username = parts.next()?.to_string();
    let password = parts.next().unwrap_or("").to_string();
    if username.is_empty() && password.is_empty() {
        None
    } else {
        Some((username, password))
    }
}

pub(super) fn load_saved_auth(registry_id: &str) -> Result<Option<RegistryAuth>> {
    let config = AppConfig::load()?;
    if let Some(entry) = config.registries.registries.get(registry_id) {
        if entry.auth_type == "none" {
            Ok(None)
        } else {
            Ok(Some(RegistryAuth {
                auth_type: entry.auth_type.clone(),
                username: entry.username.clone(),
                password: entry.password.clone(),
                token: entry.token.clone(),
            }))
        }
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn import_docker_config() -> Result<Vec<RegistryImportEntry>> {
    let path = docker_config_path()?;
    let raw = fs::read_to_string(&path).map_err(|e| {
        Error::Config(format!(
            "Failed to read Docker config at {}: {e}",
            path.display()
        ))
    })?;
    let config: DockerConfigFile =
        serde_json::from_str(&raw).map_err(|e| Error::Serialization(e.to_string()))?;
    let auths = config.auths.unwrap_or_default();
    let mut entries = Vec::new();
    let mut seen_hosts = HashMap::new();

    for (server, auth_entry) in auths {
        let host = host_from_server(&server);
        if host.is_empty() {
            continue;
        }
        let host_key = host.to_lowercase();
        if seen_hosts.contains_key(&host_key) {
            continue;
        }
        seen_hosts.insert(host_key, true);

        let is_docker_hub = is_docker_hub_host(&host);
        let base_url = super::search::normalize_base_url(&host);
        let mut auth: Option<RegistryAuth> = None;

        if let Some(token) = auth_entry.identity_token.as_ref() {
            let trimmed = token.trim();
            if !trimmed.is_empty() {
                auth = Some(RegistryAuth {
                    auth_type: "bearer".to_string(),
                    username: None,
                    password: None,
                    token: Some(trimmed.to_string()),
                });
            }
        } else if let Some(auth_value) = auth_entry.auth.as_ref() {
            if let Some((username, password)) = decode_basic_auth(auth_value) {
                auth = Some(RegistryAuth {
                    auth_type: "basic".to_string(),
                    username: Some(username),
                    password: Some(password),
                    token: None,
                });
            }
        }

        entries.push(RegistryImportEntry {
            server,
            host,
            base_url,
            is_docker_hub,
            auth,
        });
    }

    Ok(entries)
}
