//! Publishing a report to a target the reader configured.
//!
//! Two rules the rest of this file exists to keep. The key never travels to
//! the frontend: what crosses the boundary says whether a target *has* one.
//! And nothing is ever sent without the frontend naming a target — there is
//! no default target and no implicit one, because the difference between
//! saving a file and putting a cluster's names on a server is the whole
//! decision.

use serde::{Deserialize, Serialize};

use crate::config::{AppConfig, ShareTarget, SharingConfig};
use crate::error::{Error, Result};

/// The server's own ceiling (`MAX_HTML_BYTES`, 512 KiB by default). Checked
/// here so an over-large report is refused with its own size named rather
/// than with a 422 from a stranger.
const MAX_HTML_BYTES: usize = 512 * 1024;

/// A target as the frontend is allowed to see it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTargetInfo {
    pub id: String,
    pub label: String,
    pub api_url: String,
    pub kind: String,
    pub public: bool,
    /// Whether a key is stored, never the key.
    pub has_key: bool,
    /// The host, for the colour a surface gives this target.
    pub host: String,
}

impl From<&ShareTarget> for ShareTargetInfo {
    fn from(target: &ShareTarget) -> Self {
        Self {
            id: target.id.clone(),
            label: target.label.clone(),
            api_url: target.api_url.clone(),
            kind: target.kind.clone(),
            public: target.public,
            has_key: target.api_key.is_some(),
            host: host_of(&target.api_url),
        }
    }
}

#[must_use]
pub fn host_of(api_url: &str) -> String {
    url::Url::parse(api_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| api_url.to_string())
}

/// What a target says about the key it was given.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareIdentity {
    pub account_name: Option<String>,
    pub api_key_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub url: String,
    pub raw_url: Option<String>,
    pub draft_id: Option<String>,
    /// 2 on the second share of the same object to the same target.
    pub version: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTargetInput {
    pub id: Option<String>,
    pub label: String,
    pub api_url: String,
    pub kind: String,
    pub public: bool,
    /// Absent leaves whatever key is stored; empty clears it.
    pub api_key: Option<String>,
}

fn read_sharing() -> Result<SharingConfig> {
    Ok(AppConfig::load()?.sharing)
}

fn write_sharing(sharing: SharingConfig) -> Result<()> {
    let mut config = AppConfig::load()?;
    config.sharing = sharing;
    crate::commands::settings::helpers::save_config(&config)
}

#[tauri::command]
pub async fn list_share_targets() -> Result<Vec<ShareTargetInfo>> {
    Ok(read_sharing()?
        .targets
        .iter()
        .map(ShareTargetInfo::from)
        .collect())
}

#[tauri::command]
pub async fn save_share_target(input: ShareTargetInput) -> Result<ShareTargetInfo> {
    let parsed = url::Url::parse(&input.api_url)
        .map_err(|e| Error::InvalidInput(format!("{} is not a URL: {e}", input.api_url)))?;
    if parsed.scheme() != "https" && parsed.host_str() != Some("localhost") {
        return Err(Error::InvalidInput(
            "a target must be https, or localhost while you are trying one out".to_string(),
        ));
    }
    let mut sharing = read_sharing()?;
    let id = input.id.clone().unwrap_or_else(|| {
        format!(
            "t{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        )
    });
    let existing = sharing.targets.iter().position(|t| t.id == id);
    // An edit that does not mention the key keeps it: a reader renaming a
    // target must not silently lose the credential and find out at the worst
    // moment, which is the one where they are sharing something.
    let kept_key = existing
        .and_then(|index| sharing.targets[index].api_key.clone())
        .filter(|_| input.api_key.is_none());
    let drafts = existing
        .map(|index| sharing.targets[index].drafts.clone())
        .unwrap_or_default();
    let target = ShareTarget {
        id: id.clone(),
        label: input.label,
        api_url: input.api_url,
        kind: input.kind,
        public: input.public,
        api_key: input
            .api_key
            .filter(|key| !key.trim().is_empty())
            .or(kept_key),
        drafts,
    };
    let info = ShareTargetInfo::from(&target);
    match existing {
        Some(index) => sharing.targets[index] = target,
        None => sharing.targets.push(target),
    }
    write_sharing(sharing)?;
    Ok(info)
}

#[tauri::command]
pub async fn remove_share_target(id: String) -> Result<()> {
    let mut sharing = read_sharing()?;
    sharing.targets.retain(|target| target.id != id);
    write_sharing(sharing)
}

/// Asks the target who this key belongs to. The one read that happens before
/// anything is published, so a wrong key is found out while nothing is at
/// stake.
#[tauri::command]
pub async fn verify_share_target(id: String) -> Result<ShareIdentity> {
    let sharing = read_sharing()?;
    let target = sharing
        .find(&id)
        .ok_or_else(|| Error::InvalidInput(format!("no target {id}")))?;
    let key = target
        .api_key
        .as_deref()
        .ok_or_else(|| Error::InvalidInput("this target has no key yet".to_string()))?;

    let response = crate::integrations::wire::client(false)?
        .get(format!("{}/api/me", target.api_url.trim_end_matches('/')))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| Error::InvalidInput(format!("{}: {e}", host_of(&target.api_url))))?;
    if !response.status().is_success() {
        return Err(Error::InvalidInput(format!(
            "{} answered {}",
            host_of(&target.api_url),
            response.status()
        )));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| Error::InvalidInput(format!("unreadable answer: {e}")))?;
    Ok(ShareIdentity {
        account_name: body
            .get("accountName")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        api_key_name: body
            .get("apiKeyName")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
    })
}

/// Publishes one report. `object` is what the report is about — the draft is
/// remembered against it, so sharing the same pod twice updates one link.
#[tauri::command]
pub async fn publish_report(
    target_id: String,
    object: String,
    filename: String,
    description: Option<String>,
    html: String,
) -> Result<Published> {
    if html.len() > MAX_HTML_BYTES {
        return Err(Error::InvalidInput(format!(
            "the report is {} KiB and the limit is {} KiB",
            html.len() / 1024,
            MAX_HTML_BYTES / 1024
        )));
    }
    let mut sharing = read_sharing()?;
    let target = sharing
        .find(&target_id)
        .ok_or_else(|| Error::InvalidInput(format!("no target {target_id}")))?
        .clone();
    let key = target
        .api_key
        .as_deref()
        .ok_or_else(|| Error::InvalidInput("this target has no key yet".to_string()))?;
    let base = target.api_url.trim_end_matches('/');
    let endpoint = if target.kind == "generic" {
        base.to_string()
    } else {
        format!("{base}/api/uploads")
    };

    let mut body = serde_json::json!({ "html": html, "filename": filename });
    if let Some(description) = description {
        body["description"] = serde_json::Value::String(description);
    }
    if let Some(draft) = target.drafts.get(&object) {
        body["draftId"] = serde_json::Value::String(draft.clone());
    }

    let response = crate::integrations::wire::client(false)?
        .post(&endpoint)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::InvalidInput(format!("{}: {e}", host_of(&target.api_url))))?;
    let status = response.status();
    let answer: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        // A draft the target no longer has is the one failure worth retrying
        // on its own: the reader's next share should open a new link rather
        // than fail forever against a draft that was deleted over there.
        if status == reqwest::StatusCode::NOT_FOUND {
            forget_draft(&mut sharing, &target_id, &object);
            write_sharing(sharing)?;
        }
        return Err(Error::InvalidInput(format!(
            "{} answered {}{}",
            host_of(&target.api_url),
            status,
            answer
                .get("errors")
                .map(|e| format!(": {e}"))
                .unwrap_or_default()
        )));
    }

    let published = Published {
        url: answer
            .get("publicUrl")
            .and_then(|v| v.as_str())
            .unwrap_or(base)
            .to_string(),
        raw_url: answer
            .get("rawUrl")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        draft_id: answer
            .get("draftId")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        version: answer
            .get("versionNumber")
            .and_then(serde_json::Value::as_i64),
    };
    if let Some(draft) = &published.draft_id {
        if let Some(entry) = sharing.targets.iter_mut().find(|t| t.id == target_id) {
            entry.drafts.insert(object, draft.clone());
        }
        write_sharing(sharing)?;
    }
    Ok(published)
}

fn forget_draft(sharing: &mut SharingConfig, target_id: &str, object: &str) {
    if let Some(entry) = sharing.targets.iter_mut().find(|t| t.id == target_id) {
        entry.drafts.remove(object);
    }
}

/// The key `postplan` already has on this machine, if it has one.
///
/// Read rather than assumed: a reader who has used the CLI should not have to
/// find their key again, and one who has not gets told there is nothing here.
#[tauri::command]
pub async fn import_postplan_key() -> Result<Option<String>> {
    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };
    let path = home.join(".postplan").join("credentials.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| Error::InvalidInput(format!("{}: {e}", path.display())))?;
    Ok(parsed
        .get("apiKey")
        .and_then(|v| v.as_str())
        .filter(|key| !key.is_empty())
        .map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(api_url: &str, key: Option<&str>) -> ShareTarget {
        ShareTarget {
            id: "t1".into(),
            label: "internal".into(),
            api_url: api_url.into(),
            kind: "postplan".into(),
            public: false,
            api_key: key.map(str::to_owned),
            drafts: std::collections::BTreeMap::default(),
        }
    }

    /// What crosses to the frontend says a key exists and never what it is.
    #[test]
    fn the_shape_the_frontend_sees_carries_no_key() {
        let info = ShareTargetInfo::from(&target("https://plans.example.com", Some("secret-key")));
        assert!(info.has_key);
        let json = serde_json::to_string(&info).expect("serialise");
        assert!(!json.contains("secret-key"), "{json}");
        assert!(json.contains("\"hasKey\":true"));
    }

    #[test]
    fn the_host_is_what_a_colour_is_taken_from() {
        assert_eq!(
            host_of("https://plans.example.com/api"),
            "plans.example.com"
        );
        assert_eq!(host_of("https://postplan.dev"), "postplan.dev");
        assert_eq!(host_of("not a url"), "not a url");
    }

    #[test]
    fn a_draft_is_remembered_per_object_and_forgotten_when_the_target_lost_it() {
        let mut sharing = SharingConfig {
            targets: vec![target("https://plans.example.com", Some("k"))],
        };
        sharing.targets[0]
            .drafts
            .insert("Pod/shop/payments".into(), "abc123".into());
        forget_draft(&mut sharing, "t1", "Pod/shop/payments");
        assert!(sharing.targets[0].drafts.is_empty());
        // Another object's draft is not touched by one target's 404.
        sharing.targets[0]
            .drafts
            .insert("Pod/shop/other".into(), "def456".into());
        forget_draft(&mut sharing, "t1", "Pod/shop/payments");
        assert_eq!(sharing.targets[0].drafts.len(), 1);
    }
}
