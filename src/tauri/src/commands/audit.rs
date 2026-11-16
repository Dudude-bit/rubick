//! The Audit page, and one object's findings for its page and peek.

use tauri::State;

use crate::audit::{AuditPage, AuditQuery, ObjectAudit, UsageRead};
use crate::error::Result;
use crate::state::AppState;

/// One page of what is deployed in a way that will hurt later, across
/// `scope` (`None` is the whole cluster), with the scope's summary. Starts
/// Audit's watches on the first call and keeps them while it is asked.
/// `usage` is what the webview read of the scope's usage, judged there.
#[tauri::command]
pub async fn get_audit(
    scope: Option<Vec<String>>,
    query: AuditQuery,
    usage: Option<UsageRead>,
    state: State<'_, AppState>,
) -> Result<AuditPage> {
    crate::client::clock::timed(
        &state.perf,
        "getAudit",
        Box::pin(crate::audit::audit_page(
            &state,
            scope,
            &query,
            usage.as_ref(),
        )),
    )
    .await
}

/// Reads Audit's sources again now, the Prometheus the API server's count
/// comes from among them, rather than at the next pass a few minutes on.
#[tauri::command]
pub async fn read_audit_again(state: State<'_, AppState>) -> Result<()> {
    let here = state.here()?;
    state.audit.read_again(&here.context);
    Ok(())
}

/// One object's findings: a workload's or pod's for its page and peek, any
/// object's while the Audit page is open. Never starts Audit's watches.
#[tauri::command]
pub async fn get_audit_of(
    kind: String,
    namespace: Option<String>,
    name: String,
    usage: Option<UsageRead>,
    state: State<'_, AppState>,
) -> Result<ObjectAudit> {
    crate::client::clock::timed(
        &state.perf,
        "getAuditOf",
        Box::pin(crate::audit::object_audit_with(
            &state,
            &kind,
            namespace.as_deref(),
            &name,
            usage.as_ref(),
        )),
    )
    .await
}
