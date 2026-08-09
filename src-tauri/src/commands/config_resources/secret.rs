//! Secret commands — list / get / get-data (decoded) / get-yaml
//! (with redaction option) / delete.

use crate::commands::filters::SecretFilters;
use crate::commands::helpers::{get_resource_info, list_resource_infos, ResourceContext};
use crate::error::{Error, Result};
use crate::resources::SecretInfo;
use crate::state::AppState;
use k8s_openapi::api::core::v1::Secret;
use std::collections::BTreeMap;
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

/// A Secret's values, and the ones the app refuses to hand over.
///
/// Two maps rather than one with holes in it: a key that is absent because
/// the reader lacks access and a key that is absent because it is a private
/// key are different facts, and the page says which.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretData {
    pub values: BTreeMap<String, String>,
    /// Key to the reason it is withheld. Never overlaps `values`.
    pub withheld: BTreeMap<String, String>,
}

/// Get decoded Secret data (base64 decoded to UTF-8 strings).
///
/// A PEM private key is perfectly valid UTF-8, so decoding every value and
/// offering it for reveal and copy put `tls.key` one click from the
/// clipboard. Withholding happens here, at the one door the values come
/// through, rather than in the component that draws them.
#[tauri::command]
pub async fn get_secret_data(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<SecretData> {
    crate::validation::validate_dns_subdomain(&name)?;
    let secret: Secret = crate::commands::helpers::get_resource(name, namespace, state).await?;
    let secret_type = secret.type_.clone().unwrap_or_default();

    let mut out = SecretData::default();

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

impl SecretData {
    fn take(&mut self, secret_type: &str, key: String, value: &[u8]) {
        match crate::resources::withhold_reason(secret_type, &key, value) {
            Some(reason) => {
                self.withheld.insert(key, reason);
            }
            None => {
                // Lossy for non-UTF8 binary data, which is what the reveal
                // control has always shown for it.
                self.values
                    .insert(key, String::from_utf8_lossy(value).to_string());
            }
        }
    }
}

/// Get Secret YAML (with data redacted)
#[tauri::command]
pub async fn get_secret_yaml(
    name: String,
    namespace: Option<String>,
    redact: bool,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;
    let api: kube::Api<Secret> = ctx.namespaced_api();
    let mut secret = api.get(&name).await?;

    if redact {
        if let Some(data) = &mut secret.data {
            for value in data.values_mut() {
                *value = k8s_openapi::ByteString(b"[REDACTED]".to_vec());
            }
        }
    }

    // The private key goes whether or not the caller asked for redaction:
    // `redact: false` means "show me the values", never "show me the key".
    let mut object =
        serde_json::to_value(&secret).map_err(|e| Error::Serialization(e.to_string()))?;
    crate::resources::redact_private_keys(&mut object);

    let yaml = serde_yaml::to_string(&object).map_err(|e| Error::Serialization(e.to_string()))?;
    crate::commands::helpers::clean_yaml_for_editor(&yaml)
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
