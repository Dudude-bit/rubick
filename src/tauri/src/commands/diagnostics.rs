//! The panel's single read.
//!
//! One command rather than one per block: the blocks are one snapshot of one
//! machine, and six round trips could disagree with each other about it.

use crate::diagnostics::{collect, redacted, Diagnostics};
use crate::error::Result;
use crate::state::AppState;

/// Split from the command so a test can call it without a Tauri app.
async fn gather(client: &crate::client::K8sClientManager, redact: bool) -> Diagnostics {
    let d = collect(client).await;
    if redact {
        redacted(d)
    } else {
        d
    }
}

/// Read the environment, optionally scrubbed for pasting.
#[tauri::command]
pub async fn collect_diagnostics(
    redact: bool,
    state: tauri::State<'_, AppState>,
) -> Result<Diagnostics> {
    Ok(gather(&state.client_manager, redact).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_redacted_read_carries_no_home_directory() {
        // A manager that has loaded nothing still answers: the search path
        // and the installation do not depend on a cluster, and those are
        // exactly what somebody debugging a failed connection needs.
        let client = crate::client::K8sClientManager::new();

        let plain = gather(&client, false).await;
        let scrubbed = gather(&client, true).await;

        assert!(!plain.app.version.is_empty(), "both reads answer");
        assert_eq!(
            plain.app.version, scrubbed.app.version,
            "redaction hides identities, not facts"
        );

        if let Some(home) = dirs::home_dir() {
            let home = home.to_string_lossy().into_owned();
            let text = serde_json::to_string(&scrubbed).expect("serialises");
            assert!(!text.contains(&home), "a home path survived redaction");
        }
    }
}
