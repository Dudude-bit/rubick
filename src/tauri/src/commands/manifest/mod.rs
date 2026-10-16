//! Manifest validation and application commands.
//!
//! Provides Kubernetes API-based manifest operations for applying and
//! validating YAML manifests.
//!
//! - `parse`:    multi-document YAML → `DynamicObject` + `ApiResource`
//! - `commands`: validate / apply / delete / get manifest

mod commands;
mod parse;

use serde::{Deserialize, Serialize};

// Glob re-export — see commands/crds/mod.rs for why
// `pub use commands::*` is needed instead of named.
pub use commands::*;

/// Result of manifest operation (validate or apply)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestResult {
    /// Whether the operation succeeded
    pub success: bool,
    /// Standard output / success message
    pub stdout: String,
    /// Error message if any
    pub stderr: String,
    /// Exit code (0 for success, 1 for error)
    pub exit_code: i32,
}

impl ManifestResult {
    pub(super) fn success(message: String) -> Self {
        Self {
            success: true,
            stdout: message,
            stderr: String::new(),
            exit_code: 0,
        }
    }

    pub(super) fn error(message: String) -> Self {
        Self {
            success: false,
            stdout: String::new(),
            stderr: message,
            exit_code: 1,
        }
    }
}

/// What a server-side dry run said about one document.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRun {
    pub documents: Vec<DryRunDocument>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunDocument {
    /// `deployment/shop api`, the way apply names it.
    pub id: String,
    pub outcome: DryRunOutcome,
    /// The object as it stands, cleaned the way the editor shows it. `None`
    /// when there is none, and also when it could not be read: `outcome`
    /// tells those two apart, and nothing else may.
    pub live: Option<String>,
    /// The object as the server would store it, defaults and admission
    /// included. `None` when the server refused.
    pub would: Option<String>,
}

/// Five answers, because "would be created" and "could not read what is
/// there" both arrive with no current object and mean opposite things.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum DryRunOutcome {
    Created,
    Configured,
    Unchanged,
    /// The server accepts the manifest, but the current object could not be
    /// read, so whether anything changes is unknown.
    LiveUnread {
        said: String,
    },
    /// The server refused it; a real apply would be refused the same way.
    Refused {
        said: String,
    },
    /// Nobody answered: a 5xx, a transport failure, a proxy in the way. Not
    /// a refusal, and not a reason to block the apply, only to say that the
    /// question went unanswered and the editor's own diff is what is left.
    Unanswered {
        said: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_result_serialization() {
        let result = ManifestResult::success("deployment.apps/nginx created".to_string());

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("success"));
        assert!(json.contains("nginx"));
    }
}
