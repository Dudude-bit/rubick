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
    /// The link the target gave back, when it gave one.
    ///
    /// It used to fall back to the target's own base URL, so a server that
    /// answered without a link had the app hand the reader the service root
    /// and call it the report — a link that opens somebody else's index.
    pub url: Option<String>,
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
    /// Take the key from this machine's `postplan` CLI instead of sending it.
    ///
    /// The import used to hand the bearer key to the renderer, which then
    /// sent it straight back: two crossings of a boundary the key has no
    /// business on, for a value the window only ever showed as dots.
    #[serde(default)]
    pub import_key: bool,
}

fn read_sharing() -> Result<SharingConfig> {
    // `toml` renders the line it failed on, and in this file that line is as
    // likely as any to be the bearer key these targets hold. The reader is
    // told the file did not parse; the text of it stays out of the IPC answer
    // the way it already stays out of the log.
    match AppConfig::load() {
        Ok(config) => Ok(config.sharing),
        Err(why) => Err(Error::Config(format!(
            "config.toml did not parse: {}",
            crate::auth::for_the_log(&why.to_string())
        ))),
    }
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
    let imported = if input.import_key {
        Some(postplan_key()?.ok_or_else(|| {
            Error::InvalidInput("this machine's postplan CLI has no key".to_string())
        })?)
    } else {
        None
    };
    let target = ShareTarget {
        id: id.clone(),
        label: input.label,
        api_url: input.api_url,
        kind: input.kind,
        public: input.public,
        api_key: imported.or_else(|| {
            input
                .api_key
                .filter(|key| !key.trim().is_empty())
                .or(kept_key)
        }),
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
    let body = response.json::<serde_json::Value>().await;
    // Only where the answer is the failure's own words: a success that did
    // not parse is handled below, because "published" with no link is a
    // claim about somebody's report that nothing answered for.
    let answer = body.as_ref().cloned().unwrap_or(serde_json::Value::Null);
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

    // The publish this app offers is a link somebody can open. A 2xx with a
    // body that is not JSON, or one that names no `publicUrl`, left the
    // dialog saying "Published, version 1" over nothing to click.
    let link = answer
        .get("publicUrl")
        .and_then(|v| v.as_str())
        .filter(|url| !url.trim().is_empty());
    if body.is_err() || link.is_none() {
        return Err(Error::InvalidInput(format!(
            "{} accepted the report but returned no link to it",
            host_of(&target.api_url)
        )));
    }

    let published = Published {
        url: link.map(str::to_owned),
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
    // The last few characters, which is enough for a reader to recognise the
    // key they already know and useless to anybody who does not have it.
    Ok(postplan_key()?.map(|key| tail_of(&key)))
}

/// What a reader is shown of a key they already have.
fn tail_of(key: &str) -> String {
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
}

/// The bearer key this machine's `postplan` CLI stores, read in the backend.
fn postplan_key() -> Result<Option<String>> {
    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };
    let path = home.join(".postplan").join("credentials.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        // Only "there is no such file" is an answer of no key. A file this
        // user may not read is a refusal, and saying "nothing here" about it
        // sends them to look for a key they already have.
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        // The reason, not the absolute path: `~/.postplan/credentials.json`
        // is what the reader was told to put there, and their home directory
        // has no business crossing the IPC boundary to say "denied".
        Err(why) => {
            return Err(Error::InvalidInput(format!(
                "~/.postplan/credentials.json: {why}"
            )));
        }
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| Error::InvalidInput(format!("~/.postplan/credentials.json: {e}")))?;
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

    /// The import used to hand the bearer key to the window, which sent it
    /// straight back on save: two crossings for a value the window only
    /// ever drew as dots. What crosses now is the last four characters.
    #[test]
    fn the_imported_key_is_named_by_its_tail_and_not_by_itself() {
        let answer = super::tail_of("pp_live_7f3a19bc4d2e");
        assert_eq!(answer, "…4d2e");
        assert!(!answer.contains("pp_live"), "{answer}");
    }

    /// A target that answers 200 with an empty `publicUrl` has published
    /// nothing a reader can open, and the dialog said "Published, version 1"
    /// over a link that goes nowhere.
    #[test]
    fn a_link_that_is_an_empty_string_is_not_a_link() {
        let answer = serde_json::json!({ "publicUrl": "   " });
        let link = answer
            .get("publicUrl")
            .and_then(|v| v.as_str())
            .filter(|url| !url.trim().is_empty());
        assert!(link.is_none());

        let real = serde_json::json!({ "publicUrl": "https://plans.example.com/r/1" });
        assert!(real
            .get("publicUrl")
            .and_then(|v| v.as_str())
            .is_some_and(|url| !url.trim().is_empty()));
    }

    /// And the save has a way to ask for that key without carrying it.
    #[test]
    fn a_target_may_be_saved_against_the_cli_key_it_never_saw() {
        let json = serde_json::json!({
            "label": "internal",
            "apiUrl": "https://plans.example.com",
            "kind": "postplan",
            "public": false,
            "apiKey": null,
            "importKey": true
        });
        let input: ShareTargetInput = serde_json::from_value(json).expect("parse");
        assert!(input.import_key);
        assert!(input.api_key.is_none());
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
