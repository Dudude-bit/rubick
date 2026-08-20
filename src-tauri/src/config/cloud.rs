//! Cloud auth configuration: GCP / Azure profiles, kubeconfig
//! context bindings, and CLI tool paths.

use serde::{Deserialize, Serialize};

use super::app::default_true;

/// Cloud provider configuration
///
/// Settings for GCP, Azure, and other cloud provider authentication using profiles.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfig {
    /// GCP profiles (key = profile name)
    #[serde(default, alias = "gcp_profiles")]
    pub gcp_profiles: std::collections::HashMap<String, GcpProfile>,
    /// Azure profiles (key = profile name)
    #[serde(default, alias = "azure_profiles")]
    pub azure_profiles: std::collections::HashMap<String, AzureProfile>,
    /// Context to profile bindings (key = kubeconfig context name)
    #[serde(default, alias = "context_bindings")]
    pub context_bindings: std::collections::HashMap<String, ContextBinding>,
}

/// CLI tools paths configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliPathsConfig {
    /// Custom path to helm binary (if not in PATH)
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "helm_path")]
    pub helm_path: Option<String>,
    /// Custom path to kubectl binary (if not in PATH)
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "kubectl_path"
    )]
    pub kubectl_path: Option<String>,
}

/// Binding of a kubeconfig context to cloud profiles
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextBinding {
    /// GCP profile name for this context (None = use ADC)
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "gcp_profile"
    )]
    pub gcp_profile: Option<String>,
    /// Azure profile name for this context (None = use default az login)
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "azure_profile"
    )]
    pub azure_profile: Option<String>,
}

/// GCP authentication profile
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpProfile {
    /// Human-readable description
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Path to service account JSON key file (optional)
    /// If not set, uses Application Default Credentials
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "service_account_key_path"
    )]
    pub service_account_key_path: Option<String>,
    /// Custom path to gcloud CLI binary (for exec fallback)
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "gcloud_path"
    )]
    pub gcloud_path: Option<String>,
    /// Default GCP project ID
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "default_project"
    )]
    pub default_project: Option<String>,
    /// Prefer native SDK auth over exec plugin
    #[serde(default = "default_true", alias = "prefer_native_auth")]
    pub prefer_native_auth: bool,
}

impl Default for GcpProfile {
    fn default() -> Self {
        Self {
            description: None,
            service_account_key_path: None,
            gcloud_path: None,
            default_project: None,
            prefer_native_auth: true,
        }
    }
}

impl GcpProfile {
    /// Filter out empty strings from optional fields
    #[must_use]
    pub fn clean_empty_strings(self) -> Self {
        Self {
            description: self.description.filter(|s| !s.is_empty()),
            service_account_key_path: self.service_account_key_path.filter(|s| !s.is_empty()),
            gcloud_path: self.gcloud_path.filter(|s| !s.is_empty()),
            default_project: self.default_project.filter(|s| !s.is_empty()),
            prefer_native_auth: self.prefer_native_auth,
        }
    }
}

/// Azure authentication profile
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureProfile {
    /// Human-readable description
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Custom path to az CLI binary (for exec fallback)
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "az_path")]
    pub az_path: Option<String>,
    /// Custom path to kubelogin binary (for exec fallback)
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "kubelogin_path"
    )]
    pub kubelogin_path: Option<String>,
    /// Default Azure subscription ID
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "default_subscription"
    )]
    pub default_subscription: Option<String>,
    /// Azure tenant ID
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "tenant_id")]
    pub tenant_id: Option<String>,
    /// Use Azure CLI credentials as fallback when SDK auth fails
    #[serde(default, alias = "use_cli_fallback")]
    pub use_cli_fallback: bool,
    /// Prefer native SDK auth over exec plugin
    #[serde(default = "default_true", alias = "prefer_native_auth")]
    pub prefer_native_auth: bool,
}

impl Default for AzureProfile {
    fn default() -> Self {
        Self {
            description: None,
            az_path: None,
            kubelogin_path: None,
            default_subscription: None,
            tenant_id: None,
            use_cli_fallback: false,
            prefer_native_auth: true,
        }
    }
}

impl AzureProfile {
    /// Filter out empty strings from optional fields
    #[must_use]
    pub fn clean_empty_strings(self) -> Self {
        Self {
            description: self.description.filter(|s| !s.is_empty()),
            az_path: self.az_path.filter(|s| !s.is_empty()),
            kubelogin_path: self.kubelogin_path.filter(|s| !s.is_empty()),
            default_subscription: self.default_subscription.filter(|s| !s.is_empty()),
            tenant_id: self.tenant_id.filter(|s| !s.is_empty()),
            use_cli_fallback: self.use_cli_fallback,
            prefer_native_auth: self.prefer_native_auth,
        }
    }
}

impl CloudConfig {
    /// Get GCP profile for a context
    /// Returns the profile if bound, or None to use ADC
    #[must_use]
    pub fn get_gcp_profile_for_context(&self, context: &str) -> Option<&GcpProfile> {
        self.context_bindings
            .get(context)
            .and_then(|binding| binding.gcp_profile.as_ref())
            .and_then(|profile_name| self.gcp_profiles.get(profile_name))
    }

    /// Get Azure profile for a context
    /// Returns the profile if bound, or None to use default az login
    #[must_use]
    pub fn get_azure_profile_for_context(&self, context: &str) -> Option<&AzureProfile> {
        self.context_bindings
            .get(context)
            .and_then(|binding| binding.azure_profile.as_ref())
            .and_then(|profile_name| self.azure_profiles.get(profile_name))
    }
}
