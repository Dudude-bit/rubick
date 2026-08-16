//! Secret commands — list / get / get-data (decoded) / delete.
//! YAML goes through the generic `get_manifest`, which redacts
//! private keys for every kind.

use super::data::ConfigData;
use crate::commands::filters::SecretFilters;
use crate::commands::helpers::{get_resource_info, list_resource_infos};
use crate::error::Result;
use crate::resources::SecretInfo;
use crate::state::AppState;
use k8s_openapi::api::core::v1::Secret;
use tauri::State;

/// List Secrets
#[tauri::command]
pub async fn list_secrets(
    filters: Option<SecretFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<SecretInfo>> {
    let filters = filters.unwrap_or_default();
    let mut secrets: Vec<SecretInfo> =
        list_resource_infos::<Secret, SecretInfo>(Some(filters.base.clone()), state).await?;

    // Filter by type if specified
    if let Some(secret_type) = &filters.secret_type {
        secrets.retain(|s| s.type_.eq_ignore_ascii_case(secret_type));
    }

    Ok(secrets)
}

/// Get a Secret by name
#[tauri::command]
pub async fn get_secret(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<SecretInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    get_resource_info::<Secret, SecretInfo>(name, namespace, state).await
}

/// Get decoded Secret data.
///
/// A PEM private key is perfectly valid UTF-8, so decoding every value and
/// offering it for reveal and copy put `tls.key` one click from the
/// clipboard. Withholding happens in `ConfigData::take`, at the one door the
/// values come through, rather than in the component that draws them.
#[tauri::command]
pub async fn get_secret_data(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ConfigData> {
    crate::validation::validate_dns_subdomain(&name)?;
    let secret: Secret = crate::commands::helpers::get_resource(name, namespace, state).await?;
    let secret_type = secret.type_.clone().unwrap_or_default();

    let mut out = ConfigData::default();

    if let Some(data) = secret.data {
        for (key, value) in data {
            out.take(&secret_type, key, &value.0);
        }
    }

    // Also include stringData if present (already strings)
    if let Some(string_data) = secret.string_data {
        for (key, value) in string_data {
            out.take(&secret_type, key, value.as_bytes());
        }
    }

    Ok(out)
}

/// Delete Secret
#[tauri::command]
pub async fn delete_secret(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    crate::commands::helpers::delete_resource::<Secret>(name, namespace, state, None).await
}
