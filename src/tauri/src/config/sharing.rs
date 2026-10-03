//! Where a report may be published, and the key that lets it.
//!
//! The key lives here, in `config.toml`, which is written through
//! `private_file::write` and is owner-readable only — the same treatment the
//! registry passwords get. It never crosses the IPC boundary: the frontend is
//! told whether a target *has* a key, never what it is.

use serde::{Deserialize, Serialize};

/// Publishing targets, in the order the reader added them.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SharingConfig {
    #[serde(default)]
    pub targets: Vec<ShareTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTarget {
    pub id: String,
    pub label: String,
    /// The API root: `https://postplan.dev`, or a server of your own.
    pub api_url: String,
    /// `postplan` speaks the endpoints below; `generic` is a plain POST.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Anyone with the link can read what lands here, and so can the service.
    #[serde(default)]
    pub public: bool,
    /// Bearer key. Never serialised towards the frontend; see `ShareTargetInfo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Draft this app last updated at this target, per object, so a second
    /// share of the same object becomes version 2 at the same URL rather
    /// than a second link nobody can tell from the first.
    #[serde(default)]
    pub drafts: std::collections::BTreeMap<String, String>,
}

fn default_kind() -> String {
    "postplan".to_string()
}

impl SharingConfig {
    #[must_use]
    pub fn find(&self, id: &str) -> Option<&ShareTarget> {
        self.targets.iter().find(|target| target.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend asks for targets constantly; a key that rides along in
    /// one of those answers is a key in a renderer process, in a log, and in
    /// a bug report. It is dropped where the two shapes meet, not here.
    #[test]
    fn a_target_keeps_its_key_in_the_config_file() {
        let target = ShareTarget {
            id: "t1".into(),
            label: "internal".into(),
            api_url: "https://plans.example.com".into(),
            kind: "postplan".into(),
            public: false,
            api_key: Some("secret-key".into()),
            drafts: std::collections::BTreeMap::default(),
        };
        let toml = toml::to_string(&SharingConfig {
            targets: vec![target],
        })
        .expect("serialise");
        assert!(
            toml.contains("secret-key"),
            "the file is where the key lives"
        );
    }

    #[test]
    fn a_target_without_a_key_round_trips() {
        let config: SharingConfig = toml::from_str(
            r#"
            [[targets]]
            id = "t1"
            label = "internal"
            apiUrl = "https://plans.example.com"
            "#,
        )
        .expect("parse");
        assert_eq!(config.targets.len(), 1);
        assert_eq!(config.targets[0].kind, "postplan");
        assert!(config.targets[0].api_key.is_none());
        assert!(!config.targets[0].public);
    }
}
