//! The Audit page, and one object's findings for its page and peek.

use tauri::State;

use crate::audit::{AuditPage, AuditQuery, ObjectAudit};
use crate::error::Result;
use crate::state::AppState;

/// One page of what is deployed in a way that will hurt later, across
/// `scope` (`None` is the whole cluster), with the scope's summary. Starts
/// Audit's watches on the first call and keeps them while it is asked.
#[tauri::command]
pub async fn get_audit(
    scope: Option<Vec<String>>,
    query: AuditQuery,
    state: State<'_, AppState>,
) -> Result<AuditPage> {
    crate::client::clock::timed(
        &state.perf,
        "getAudit",
        Box::pin(crate::audit::audit_page(&state, scope, &query)),
    )
    .await
}

/// One object's findings: a workload's or pod's for its page and peek, any
/// object's while the Audit page is open. Never starts Audit's watches.
#[tauri::command]
pub async fn get_audit_of(
    kind: String,
    namespace: Option<String>,
    name: String,
    state: State<'_, AppState>,
) -> Result<ObjectAudit> {
    crate::client::clock::timed(
        &state.perf,
        "getAuditOf",
        Box::pin(crate::audit::object_audit(
            &state,
            &kind,
            namespace.as_deref(),
            &name,
        )),
    )
    .await
}
