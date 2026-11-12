//! `config.toml` as 4.21.2 reads it, frozen from that tag: every field's
//! name and type, and which ones that build cannot do without.
//!
//! That build and this one share the file, after a rollback or with a copy
//! still installed, and it moves the whole file aside when one item will not
//! parse. Its default values are not kept: they do not decide that.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AppConfig {
    pub theme: ThemeConfig,
    pub kubernetes: KubernetesConfig,
    #[serde(default)]
    pub cloud: CloudConfig,
    #[serde(default)]
    pub port_forward: PortForwardConfigStore,
    #[serde(default)]
    pub cli_paths: CliPathsConfig,
    #[serde(default)]
    pub integrations: IntegrationsConfig,
    #[serde(default)]
    pub yaml_editor: YamlEditorConfig,
    #[serde(default)]
    pub recent_items: RecentItemsConfig,
    #[serde(default)]
    pub updater: UpdaterConfig,
    #[serde(default)]
    pub cluster_preferences: ClusterPreferences,
    #[serde(default)]
    pub sharing: SharingConfig,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ThemeConfig {
    #[serde(default)]
    pub theme: String,
    #[serde(default)]
    pub accent_color: String,
    #[serde(default)]
    pub font_size: u8,
    #[serde(default)]
    pub compact: bool,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct KubernetesConfig {
    pub kubeconfig_path: Option<PathBuf>,
    #[serde(default)]
    pub kubeconfig_paths: Vec<PathBuf>,
    #[serde(default)]
    pub default_namespace: String,
    #[serde(default)]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub enable_watch: bool,
    #[serde(default)]
    pub refresh_interval: u64,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfig {
    #[serde(default, alias = "gcp_profiles")]
    pub gcp_profiles: BTreeMap<String, GcpProfile>,
    #[serde(default, alias = "azure_profiles")]
    pub azure_profiles: BTreeMap<String, AzureProfile>,
    #[serde(default, alias = "context_bindings")]
    pub context_bindings: BTreeMap<String, ContextBinding>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliPathsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "helm_path")]
    pub helm_path: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "kubectl_path"
    )]
    pub kubectl_path: Option<String>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBinding {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "gcp_profile"
    )]
    pub gcp_profile: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "azure_profile"
    )]
    pub azure_profile: Option<String>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "service_account_key_path"
    )]
    pub service_account_key_path: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "gcloud_path"
    )]
    pub gcloud_path: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "default_project"
    )]
    pub default_project: Option<String>,
    #[serde(default, alias = "prefer_native_auth")]
    pub prefer_native_auth: bool,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "az_path")]
    pub az_path: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "kubelogin_path"
    )]
    pub kubelogin_path: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "default_subscription"
    )]
    pub default_subscription: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "tenant_id")]
    pub tenant_id: Option<String>,
    #[serde(default, alias = "use_cli_fallback")]
    pub use_cli_fallback: bool,
    #[serde(default, alias = "prefer_native_auth")]
    pub prefer_native_auth: bool,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PortForwardConfigStore {
    #[serde(default)]
    pub configs: Vec<PortForwardConfig>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PortForwardConfig {
    pub id: String,
    pub context: String,
    pub name: String,
    pub pod: String,
    pub namespace: String,
    pub local_port: u16,
    pub remote_port: u16,
    #[serde(default)]
    pub auto_reconnect: bool,
    #[serde(default)]
    pub auto_start: bool,
    pub created_at: String,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsConfig {
    #[serde(default)]
    pub prometheus: BTreeMap<String, ConnectionEntry>,
    #[serde(default)]
    pub loki: BTreeMap<String, ConnectionEntry>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEntry {
    pub url: String,
    #[serde(default)]
    pub auth_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default)]
    pub insecure_tls: bool,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YamlEditorConfig {
    #[serde(default)]
    pub history: BTreeMap<String, Vec<YamlHistoryEntry>>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YamlHistoryEntry {
    pub timestamp: i64,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentItemsConfig {
    #[serde(default)]
    pub items: Vec<RecentItem>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub kind: String,
    pub path: String,
    pub timestamp: i64,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterConfig {
    #[serde(default)]
    pub auto_check_enabled: bool,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterPreferences {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "last_context"
    )]
    pub last_context: Option<String>,
    #[serde(default)]
    pub namespaces: BTreeMap<String, String>,
    #[serde(default)]
    pub scopes: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingConfig {
    #[serde(default)]
    pub targets: Vec<ShareTarget>,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTarget {
    pub id: String,
    pub label: String,
    pub api_url: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub public: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default)]
    pub drafts: BTreeMap<String, String>,
}

/// A file with something in every section and every list, as that build
/// would have written it.
pub fn written() -> AppConfig {
    let named = |name: &str| name.to_string();
    AppConfig {
        theme: ThemeConfig {
            theme: named("dark"),
            accent_color: named("#3b82f6"),
            font_size: 14,
            compact: true,
        },
        kubernetes: KubernetesConfig {
            kubeconfig_path: Some(PathBuf::from("/home/sam/.kube/work")),
            kubeconfig_paths: vec![PathBuf::from("/home/sam/.kube/work")],
            default_namespace: named("default"),
            timeout_seconds: 30,
            enable_watch: true,
            refresh_interval: 30,
        },
        cloud: CloudConfig {
            gcp_profiles: BTreeMap::from([(
                named("work"),
                GcpProfile {
                    default_project: Some(named("acme")),
                    prefer_native_auth: true,
                    ..GcpProfile::default()
                },
            )]),
            azure_profiles: BTreeMap::from([(
                named("corp"),
                AzureProfile {
                    tenant_id: Some(named("t-1")),
                    use_cli_fallback: true,
                    ..AzureProfile::default()
                },
            )]),
            context_bindings: BTreeMap::from([(
                named("prod"),
                ContextBinding {
                    gcp_profile: Some(named("work")),
                    azure_profile: None,
                },
            )]),
        },
        port_forward: PortForwardConfigStore {
            configs: vec![PortForwardConfig {
                id: named("pf-1"),
                context: named("prod"),
                name: named("db"),
                pod: named("db-0"),
                namespace: named("shop"),
                local_port: 5432,
                remote_port: 5432,
                auto_reconnect: true,
                auto_start: false,
                created_at: named("2026-09-30T10:00:00Z"),
            }],
        },
        cli_paths: CliPathsConfig {
            helm_path: Some(named("/opt/homebrew/bin/helm")),
            kubectl_path: None,
        },
        integrations: IntegrationsConfig {
            prometheus: BTreeMap::from([(
                named("prod"),
                ConnectionEntry {
                    url: named("https://prometheus.acme.test"),
                    auth_type: named("bearer"),
                    token: Some(named("secret")),
                    insecure_tls: false,
                },
            )]),
            loki: BTreeMap::new(),
        },
        yaml_editor: YamlEditorConfig {
            history: BTreeMap::from([(
                named("Deployment:shop:api"),
                vec![YamlHistoryEntry {
                    timestamp: 1,
                    content: named("kind: Deployment\n"),
                    label: None,
                }],
            )]),
        },
        recent_items: RecentItemsConfig {
            items: vec![
                RecentItem {
                    name: named("api"),
                    namespace: Some(named("shop")),
                    kind: named("Pod"),
                    path: named("/pods/shop/api"),
                    timestamp: 2,
                },
                RecentItem {
                    name: named("node-1"),
                    namespace: None,
                    kind: named("Node"),
                    path: named("/nodes/node-1"),
                    timestamp: 1,
                },
            ],
        },
        updater: UpdaterConfig {
            auto_check_enabled: false,
        },
        cluster_preferences: ClusterPreferences {
            last_context: Some(named("prod")),
            namespaces: BTreeMap::from([(named("prod"), named("shop"))]),
            scopes: BTreeMap::from([(named("prod"), vec![named("shop"), named("web")])]),
        },
        sharing: SharingConfig {
            targets: vec![ShareTarget {
                id: named("t-1"),
                label: named("Team"),
                api_url: named("https://share.acme.test"),
                kind: named("postplan"),
                public: false,
                api_key: Some(named("key")),
                drafts: BTreeMap::from([(named("prod"), named("draft-1"))]),
            }],
        },
    }
}
