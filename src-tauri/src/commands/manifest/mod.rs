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
