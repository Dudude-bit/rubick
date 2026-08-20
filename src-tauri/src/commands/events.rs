//! Events commands

use crate::commands::helpers::ResourceContext;
use crate::error::Result;
use crate::resources::EventInfo;
use crate::state::AppState;
use k8s_openapi::api::core::v1::Event;
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Server-side page size for the event walk. Big enough that the common
/// "latest 500" is one round trip when the namespace is quiet.
const EVENT_PAGE_SIZE: u32 = 500;

/// How many pages a request with a limit may walk.
///
/// The apiserver returns events in etcd key order, not newest first, and
/// has no sort — so the newest N can only be found by reading more than N
/// and sorting. Four pages covers the largest limit the UI offers and
/// bounds what a pathological cluster can cost a query the events page
/// re-reads every second.
const MAX_EVENT_PAGES: usize = 4;

/// Event filters
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EventFilters {
    pub namespace: Option<String>,
    pub involved_object_name: Option<String>,
    pub involved_object_kind: Option<String>,
    pub event_type: Option<String>, // "Normal" or "Warning"
    pub field_selector: Option<String>,
    pub limit: Option<i64>,
}

/// The newest events in scope, most recent first.
///
/// `limit` is that sentence — "latest 500" — and not a page size, which
/// is what it used to be passed as: one etcd-ordered page of 500,
/// *then* sorted newest-first, so the panel's "latest" was 500
/// arbitrary events with the newest of those on top. The type filter
/// was applied later still, in memory, so "Warnings · latest 500" spent
/// its whole budget on Normal events and came back with a handful of
/// rows. Both now happen where they belong: the type goes to the
/// apiserver as a field selector, and the limit is applied after the
/// sort.
///
/// `limit: None` means "everything", and walks until the collection is
/// exhausted — the same total the unbounded list it replaces returned,
/// in bounded pages instead of one response.
#[tauri::command]
pub async fn list_events(
    filters: Option<EventFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<EventInfo>> {
    let filters = filters.unwrap_or_default();
    let ctx = ResourceContext::for_list(&state, filters.namespace)?;

    let mut field_selectors = Vec::new();
    if let Some(name) = &filters.involved_object_name {
        field_selectors.push(format!("involvedObject.name={name}"));
    }
    if let Some(kind) = &filters.involved_object_kind {
        field_selectors.push(format!("involvedObject.kind={kind}"));
    }
    if let Some(event_type) = &filters.event_type {
        field_selectors.push(format!("type={event_type}"));
    }
    if let Some(custom) = &filters.field_selector {
        field_selectors.push(custom.clone());
    }

    let mut base = ListParams::default().limit(EVENT_PAGE_SIZE);
    if !field_selectors.is_empty() {
        base = base.fields(&field_selectors.join(","));
    }

    // Use namespaced API when namespace is provided for proper filtering
    let api: kube::Api<Event> = ctx.namespaced_or_cluster_api();

    let budget = match filters.limit {
        Some(limit) if limit > 0 => MAX_EVENT_PAGES,
        _ => usize::MAX,
    };

    let mut items: Vec<Event> = Vec::new();
    let mut token: Option<String> = None;
    for page_number in 0..budget {
        let mut params = base.clone();
        if let Some(token) = token.as_deref() {
            params = params.continue_token(token);
        }
        let page = api.list(&params).await;
        let mut page = match (page, page_number) {
            (Ok(page), _) => page,
            // Nothing was read at all, so there is no answer to give.
            (Err(e), 0) => return Err(e.into()),
            // A continue token that expired mid-walk (a compaction, a
            // restarted apiserver) invalidates the rest of the walk, not
            // the pages already in hand.
            (Err(e), _) => {
                tracing::warn!("Event page {page_number} failed, returning what was read: {e}");
                break;
            }
        };
        token = page.metadata.continue_.take().filter(|t| !t.is_empty());
        items.append(&mut page.items);
        if token.is_none() {
            break;
        }
    }

    let mut events: Vec<EventInfo> = items.iter().map(EventInfo::from).collect();

    // Sort by last timestamp (most recent first)
    events.sort_by_key(|event| std::cmp::Reverse(event.last_timestamp.clone()));

    if let Some(limit) = filters.limit {
        if limit > 0 {
            events.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        }
    }

    Ok(events)
}
