//! Renewing a context's credentials before the cluster stops accepting them.
//!
//! Runs the same plugin the same way, a little before the deadline it named,
//! while the old credentials still work. One that can answer alone answers
//! and nobody sees anything; one that needs a person fails here and the
//! reader meets the Sign in screen exactly as before, so this only ever
//! removes an interruption.
//!
//! Two deliberate omissions. It does not disconnect first — the new client
//! replaces the old only once it exists, or the window goes blind for as long
//! as the plugin takes. And it schedules nothing for a context whose deadline
//! is unknown: a plugin that names no expiry is not one whose token lasts
//! forever, and `credential_renewal` reports that rather than leaving a
//! reader to assume they are covered.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use tauri::{AppHandle, Manager};
use tokio::task::JoinHandle;

use crate::state::AppState;

/// How early to try: long enough for a slow plugin on a slow network to
/// finish while the old token is still good, short enough that a token with a
/// five-minute life is renewed once rather than never.
const MARGIN: Duration = Duration::minutes(2);

/// Never sooner than this. A plugin handing back an already-expired token —
/// or one whose clock disagrees with ours — would otherwise run in a loop.
const FLOOR: std::time::Duration = std::time::Duration::from_secs(30);

/// A plugin that needs a human fails every time, and the `401` is coming to
/// say so anyway.
const GIVE_UP_AFTER: u32 = 2;

/// What became of the attempt to renew a context's credentials on its own.
///
/// Reported rather than inferred: "the screen has not asked you to sign in"
/// is not evidence that anything renewed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Renewal {
    /// A deadline is known and a renewal is scheduled before it.
    Scheduled,
    /// The plugin named no deadline, so there is nothing to schedule from.
    NoDeadline,
    /// It was tried and could not finish without a person.
    NeedsYou,
    /// `kubectl proxy` holds the credentials and renews them itself.
    Delegated,
    /// Nothing has said yet. The default, because every other answer is a
    /// claim nobody established.
    Unknown,
}

pub struct RenewManager {
    scheduled: Arc<DashMap<String, JoinHandle<()>>>,
    outcomes: Arc<DashMap<String, Renewal>>,
}

impl Default for RenewManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RenewManager {
    #[must_use]
    pub fn new() -> Self {
        Self {
            scheduled: Arc::new(DashMap::new()),
            outcomes: Arc::new(DashMap::new()),
        }
    }

    /// What to tell a reader about this context renewing itself. A context
    /// this has not looked at is not a context that renews.
    #[must_use]
    pub fn outcome(&self, context: &str) -> Renewal {
        self.outcomes
            .get(context)
            .map_or(Renewal::Unknown, |outcome| *outcome)
    }

    /// Stop renewing a context — it was disconnected, or is being replaced.
    pub fn forget(&self, context: &str) {
        if let Some((_, handle)) = self.scheduled.remove(context) {
            handle.abort();
        }
        self.outcomes.remove(context);
    }

    fn record(&self, context: &str, outcome: Renewal) {
        self.outcomes.insert(context.to_string(), outcome);
    }
}

/// When to wake for a deadline, or `None` if it has already gone. Separated
/// so the arithmetic is testable without a cluster or a moving clock.
#[must_use]
pub fn wait_for(deadline: DateTime<Utc>, now: DateTime<Utc>) -> Option<std::time::Duration> {
    // The token a past deadline describes is gone; the `401` has landed.
    if deadline <= now {
        return None;
    }
    // `to_std` refuses a negative span — here, a deadline already inside the
    // margin. Close, but still worth one try.
    let wait = (deadline - MARGIN - now).to_std().unwrap_or(FLOOR);
    Some(wait.max(FLOOR))
}

/// Record that kubectl is renewing this context's credentials — the proxy
/// path, where it holds the token and re-runs the plugin itself. Nothing here
/// has a deadline to act on, and `NoDeadline` would report that as a gap.
pub fn delegated(app: &AppHandle, context: &str) {
    let manager = Arc::clone(&app.state::<AppState>().renew_manager);
    if let Some((_, previous)) = manager.scheduled.remove(context) {
        previous.abort();
    }
    manager.record(context, Renewal::Delegated);
}

/// Arrange for `context` to renew itself before `deadline`, replacing any
/// renewal already scheduled — its deadline belonged to a replaced token.
pub fn schedule(app: &AppHandle, context: &str, deadline: Option<DateTime<Utc>>) {
    let manager = Arc::clone(&app.state::<AppState>().renew_manager);
    let manager = &*manager;
    if let Some((_, previous)) = manager.scheduled.remove(context) {
        previous.abort();
    }

    let Some(deadline) = deadline else {
        manager.record(context, Renewal::NoDeadline);
        return;
    };
    let Some(wait) = wait_for(deadline, Utc::now()) else {
        manager.record(context, Renewal::NoDeadline);
        return;
    };

    manager.record(context, Renewal::Scheduled);
    let owned = context.to_string();
    // The handle, not the state: `State<'_, AppState>` borrows from it.
    let app = app.clone();
    let handle = tokio::spawn(async move {
        run(app, owned, wait).await;
    });
    manager.scheduled.insert(context.to_string(), handle);
}

/// One task per context, until the plugin needs a person, the context goes
/// away, or there is no next deadline. A loop rather than a task that spawns
/// its successor, whose recursive shape makes `Send`ness self-referential.
async fn run(app: AppHandle, context: String, first: std::time::Duration) {
    let mut wait = first;
    let mut failures = 0u32;

    loop {
        tokio::time::sleep(wait).await;

        // Disconnected or reconnected by hand while this slept: either way
        // this attempt is about a token no longer in use.
        let state = app.state::<AppState>();
        if state.client_manager.get_client(&context).is_none() {
            state.renew_manager.forget(&context);
            return;
        }

        let Ok(renewed) = renew_once(&app, &context).await else {
            failures += 1;
            if failures < GIVE_UP_AFTER {
                wait = FLOOR;
                continue;
            }
            // Left alone on purpose: the credentials in use are still the
            // ones the cluster accepted, and the `401` path already says so
            // when it stops. Interrupting earlier is what this exists to end.
            stop(&state, &context, Renewal::NeedsYou);
            return;
        };

        // No next deadline: nothing to schedule from, and `Scheduled` would
        // claim a wake-up that is not set.
        let Some(again) = renewed.and_then(|at| wait_for(at, Utc::now())) else {
            stop(&state, &context, Renewal::NoDeadline);
            return;
        };
        failures = 0;
        wait = again;
        state.renew_manager.record(&context, Renewal::Scheduled);
    }
}

/// The last word on a context: what became of it, and no next wake-up.
fn stop(state: &AppState, context: &str, outcome: Renewal) {
    state.renew_manager.record(context, outcome);
    state.renew_manager.scheduled.remove(context);
}

/// One silent attempt: run the plugin, and swap the client only if it worked.
async fn renew_once(app: &AppHandle, context: &str) -> crate::error::Result<Option<DateTime<Utc>>> {
    let state = app.state::<AppState>();
    let kubeconfig = state
        .client_manager
        .kubeconfig_clone()
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;
    let prepared = crate::auth::prepare_kubeconfig_for_context(
        &state,
        kubeconfig,
        context,
        crate::auth::AuthMode::Silent,
    )
    .await?;
    state
        .client_manager
        .set_credential_deadline(context, prepared.expires_at);
    state
        .client_manager
        .connect_with_kubeconfig(context, prepared.kubeconfig)
        .await
        .map_err(|e| crate::error::Error::Connection(e.to_string()))?;
    // Only now: telling the holders of the old client any earlier would have
    // them rebuild onto it.
    state.emit(crate::state::AppEvent::CredentialsRenewed {
        context: context.to_string(),
    });
    Ok(prepared.expires_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point is to run while the old token still works, so the
    /// wait has to land before the deadline — and never so soon that a
    /// plugin whose clock disagrees with ours turns this into a loop.
    #[test]
    fn the_wait_lands_before_the_deadline_and_never_immediately() {
        let now = Utc::now();

        let hour = wait_for(now + Duration::hours(1), now).expect("an hour off is worth waiting");
        assert!(
            hour < (Duration::hours(1)).to_std().unwrap(),
            "a renewal after the deadline renews nothing"
        );
        assert!(
            hour >= (Duration::minutes(57)).to_std().unwrap(),
            "the margin is two minutes, not an hour"
        );

        // Inside the margin: still worth doing, but not instantly.
        let soon = wait_for(now + Duration::seconds(30), now).expect("still ahead of us");
        assert!(soon >= FLOOR, "a floor under every wait");

        // Already gone: the `401` has landed or is about to, and running the
        // plugin against a dead token buys nothing.
        assert_eq!(wait_for(now - Duration::seconds(1), now), None);
        assert_eq!(wait_for(now, now), None);
    }

    /// A context with no deadline is not a context that never expires, and
    /// a context nobody has looked at is neither — both would read as
    /// "covered" if the missing answer were anything but its own word.
    #[test]
    fn a_context_with_no_deadline_is_reported_rather_than_assumed_safe() {
        let manager = RenewManager::new();
        assert_eq!(manager.outcome("nothing-yet"), Renewal::Unknown);
        manager.record("no-plugin", Renewal::NoDeadline);
        assert_eq!(manager.outcome("no-plugin"), Renewal::NoDeadline);
        manager.record("no-plugin", Renewal::Scheduled);
        assert_eq!(manager.outcome("no-plugin"), Renewal::Scheduled);
        manager.forget("no-plugin");
        assert_eq!(manager.outcome("no-plugin"), Renewal::Unknown);
    }
}
