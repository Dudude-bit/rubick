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
use tokio::sync::oneshot;

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

/// The last moment worth asking at, once the plugin has answered the margin
/// with the token it already had. Some only mint a new one inside their own
/// skew window: the way to one is to ask later, not more often.
///
/// Longer than the silent flow's own 30-second ceiling, deliberately: at
/// twenty seconds an exchange that takes twenty-five finishes *after* the
/// credentials it was renewing have died. kubelogin re-uses its `id-token`
/// until a minute before expiry, so forty-five is still inside the window.
const CREEP: Duration = Duration::seconds(45);

/// One attempt past the deadline, for a plugin that refuses to mint a new
/// credential until the old one is actually dead.
///
/// Every earlier attempt is answered with the token in use, and the schedule
/// used to give up a few seconds short of the `401`. This is a few seconds of
/// refusal that lifts itself instead of a Sign in screen awaiting a click.
const PAST: Duration = Duration::seconds(5);

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
    /// The deadline it named has already gone by. Not `NoDeadline`, which
    /// says the plugin never named a moment — a screen saying that under
    /// "your credentials expired four minutes ago" contradicts itself.
    Passed,
    /// It was tried and cannot finish without a person.
    NeedsYou,
    /// It was tried and failed for a reason that was not about a person.
    /// Kept apart from `NeedsYou`: only one of them predicts a sign-in.
    Failed,
    /// It was tried until there was no room left before the deadline, and the
    /// plugin kept answering with the credentials already in use.
    RanOut,
    /// One attempt is left and it lands *after* the deadline — for a plugin
    /// that mints nothing while the old credential is alive. Kept apart from
    /// `Scheduled`, which promises a renewal before the deadline: this one
    /// means a few seconds of refusal are coming whatever happens.
    LastChance,
    /// `kubectl proxy` holds the credentials and renews them itself.
    Delegated,
    /// Nothing has said yet. The default, because every other answer is a
    /// claim nobody established.
    Unknown,
}

/// A scheduled renewal, and the way to ask it to stop — asking rather than
/// aborting, because a task dropped mid-attempt takes the plugin's PTY child,
/// its browser shim and its auth session with it: the cleanup lives after the
/// `await` that never returns. The attempt itself is already cancelled
/// through its auth session, so this only stops the loop going round.
pub struct RenewManager {
    scheduled: Arc<DashMap<String, oneshot::Sender<()>>>,
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
        if let Some((_, stop)) = self.scheduled.remove(context) {
            let _ = stop.send(());
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
        let _ = previous.send(());
    }
    manager.record(context, Renewal::Delegated);
}

/// Arrange for `context` to renew itself before `deadline`, replacing any
/// renewal already scheduled — its deadline belonged to a replaced token.
pub fn schedule(app: &AppHandle, context: &str, deadline: Option<DateTime<Utc>>) {
    let manager = Arc::clone(&app.state::<AppState>().renew_manager);
    let manager = &*manager;
    if let Some((_, previous)) = manager.scheduled.remove(context) {
        let _ = previous.send(());
    }

    let Some(deadline) = deadline else {
        manager.record(context, Renewal::NoDeadline);
        return;
    };
    let Some(wait) = wait_for(deadline, Utc::now()) else {
        manager.record(context, Renewal::Passed);
        return;
    };

    manager.record(context, Renewal::Scheduled);
    let owned = context.to_string();
    // The handle, not the state: `State<'_, AppState>` borrows from it.
    let app = app.clone();
    let (stop_tx, stop_rx) = oneshot::channel();
    tokio::spawn(async move {
        run(app, owned, wait, stop_rx).await;
    });
    manager.scheduled.insert(context.to_string(), stop_tx);
}

/// One task per context, until the plugin needs a person, the context goes
/// away, or there is no next deadline. A loop rather than a task that spawns
/// its successor, whose recursive shape makes `Send`ness self-referential.
async fn run(
    app: AppHandle,
    context: String,
    first: std::time::Duration,
    stop_rx: oneshot::Receiver<()>,
) {
    let mut wait = first;
    let mut failures = 0u32;
    let mut timing = Timing::Margin;
    let mut stop_rx = stop_rx;
    tracing::info!(
        %context,
        in_seconds = wait.as_secs(),
        "credential renewal scheduled"
    );

    loop {
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            _ = &mut stop_rx => return,
        }

        // Disconnected or reconnected by hand while this slept: either way
        // this attempt is about a token no longer in use.
        let state = app.state::<AppState>();
        if state.client_manager.get_client(&context).is_none() {
            state.renew_manager.forget(&context);
            return;
        }
        let Some(before) = state.client_manager.credential_deadline(&context) else {
            tracing::info!(%context, "no deadline to renew from; nothing scheduled");
            stop(&state, &context, Renewal::NoDeadline);
            return;
        };
        tracing::info!(
            %context,
            ?timing,
            deadline = %before,
            "running the credential plugin to renew"
        );

        let attempt = renew_once(&app, &context, before, &mut stop_rx).await;
        if stopped(&mut stop_rx) {
            return;
        }
        let renewed = match attempt {
            Ok(renewed) => renewed,
            Err(error) => {
                failures += 1;
                if failures < GIVE_UP_AFTER && !needs_person(&error) {
                    wait = FLOOR;
                    continue;
                }
                // Left alone on purpose: the credentials in use are still
                // the ones the cluster accepted, and the `401` path says so
                // when it stops. Which failure it was decides what the
                // reader is told — only one of them predicts a sign-in.
                let outcome = if needs_person(&error) {
                    Renewal::NeedsYou
                } else {
                    Renewal::Failed
                };
                // The words, not just the verdict: which of the two it was
                // decides what the reader is told, and only the message says
                // what the plugin actually ran into.
                tracing::warn!(
                    %context,
                    ?outcome,
                    why = %crate::auth::for_the_log(&error.to_string()),
                    "credential renewal gave up"
                );
                stop(&state, &context, outcome);
                return;
            }
        };
        failures = 0;

        let next = match renewed {
            // No deadline on the new credentials: nothing to schedule from,
            // and `Scheduled` would claim a wake-up that is not set.
            Renewed::Replaced(None) => {
                tracing::info!(
                    %context,
                    "credentials renewed, but the new ones name no deadline"
                );
                stop(&state, &context, Renewal::NoDeadline);
                return;
            }
            Renewed::Replaced(Some(at)) => {
                tracing::info!(%context, deadline = %at, "credentials renewed");
                at
            }
            // Somebody moved this context while the plugin ran, and whoever
            // did owns what happens next.
            Renewed::Superseded => {
                tracing::info!(
                    %context,
                    "the context moved while the plugin ran; leaving it to whoever moved it"
                );
                return;
            }
            // Nothing was replaced and nobody was told; the same schedule
            // would run the plugin every half minute for the same token.
            Renewed::Unchanged => before,
        };

        if matches!(renewed, Renewed::Unchanged) {
            tracing::info!(
                %context,
                ?timing,
                "the plugin answered with the credentials already in use"
            );
            let Some(later) = timing.next() else {
                tracing::warn!(
                    %context,
                    "the plugin never minted new credentials; the sign-in screen is next"
                );
                stop(&state, &context, Renewal::RanOut);
                return;
            };
            timing = later;
        } else {
            timing = Timing::Margin;
        }

        let Some((rung, again)) = rung_with_room(next, Utc::now(), timing) else {
            // Out of room, and nothing here will stop the `401` now. Not
            // `NeedsYou`: no plugin asked for anybody.
            tracing::warn!(%context, ?timing, "no room left before the deadline");
            stop(&state, &context, Renewal::RanOut);
            return;
        };
        timing = rung;
        tracing::info!(
            %context,
            ?timing,
            in_seconds = again.as_secs(),
            "next credential renewal scheduled"
        );
        wait = again;
        // Past is after the deadline by construction: the credentials are
        // gone by then, and calling that "scheduled" would put a reassuring
        // chip over a window that is about to be refused.
        state.renew_manager.record(
            &context,
            if timing == Timing::Past {
                Renewal::LastChance
            } else {
                Renewal::Scheduled
            },
        );
    }
}

/// Whether this failure is one only a person can get past — asked of the
/// error's variant, never of its words. Everything else, a kubeconfig that
/// would not read included, says nothing about a sign-in.
fn needs_person(error: &crate::error::Error) -> bool {
    matches!(
        error,
        crate::error::Error::Auth(crate::error::AuthError::NeedsPerson(_))
    )
}

/// How far into the schedule for one deadline this has got. A plugin that
/// keeps answering with the credentials in use is asked later each time, and
/// finally once past the deadline, which is the only moment some of them
/// will mint a new one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Timing {
    /// The ordinary attempt, a margin before the deadline.
    Margin,
    /// It answered with the same token: ask again nearer the deadline.
    Creep,
    /// And nearer did not help either: ask once after it.
    Past,
}

impl Timing {
    /// The next timing to try, or `None` when there is nothing later left.
    fn next(self) -> Option<Self> {
        match self {
            Self::Margin => Some(Self::Creep),
            Self::Creep => Some(Self::Past),
            Self::Past => None,
        }
    }
}

/// The first rung from `timing` onward that still has a moment ahead of it,
/// and when that moment is.
///
/// Walking rather than giving up is the whole reason `Past` exists. A
/// credential with less than `CREEP` of life left when the margin attempt
/// answers "same token" has no room on the creep rung — and if that ended
/// the ladder, the one attempt that reaches a plugin which mints nothing
/// early would never be made, for exactly the short-lived credentials it was
/// added for.
fn rung_with_room(
    deadline: DateTime<Utc>,
    now: DateTime<Utc>,
    timing: Timing,
) -> Option<(Timing, std::time::Duration)> {
    let mut rung = timing;
    loop {
        if let Some(wait) = next_wait(deadline, now, rung) {
            return Some((rung, wait));
        }
        rung = rung.next()?;
    }
}

/// When to wake next for a given timing, or `None` when it has no moment
/// left ahead of it.
fn next_wait(
    deadline: DateTime<Utc>,
    now: DateTime<Utc>,
    timing: Timing,
) -> Option<std::time::Duration> {
    match timing {
        Timing::Margin => wait_for(deadline, now),
        Timing::Creep => (deadline - CREEP - now).to_std().ok(),
        // Always ahead of us by construction, so this is the one timing that
        // cannot run out of room.
        Timing::Past => Some(
            (deadline + PAST - now)
                .to_std()
                .unwrap_or(std::time::Duration::ZERO),
        ),
    }
}

/// The last word on a context: what became of it, and no next wake-up.
fn stop(state: &AppState, context: &str, outcome: Renewal) {
    state.renew_manager.record(context, outcome);
    state.renew_manager.scheduled.remove(context);
}

/// What one silent attempt came back with.
enum Renewed {
    /// New credentials are in place; the deadline is the new one, if any.
    Replaced(Option<DateTime<Utc>>),
    /// The plugin handed back the credentials already in use.
    Unchanged,
    /// Somebody moved the context while the plugin was running, so the
    /// result was dropped rather than installed.
    Superseded,
}

/// Whether this renewal was asked to stop, or its record replaced. `Empty` is
/// the only answer that means carry on — a closed channel is `schedule`
/// dropping the sender for a newer renewal.
fn stopped(stop_rx: &mut oneshot::Receiver<()>) -> bool {
    !matches!(stop_rx.try_recv(), Err(oneshot::error::TryRecvError::Empty))
}

/// One silent attempt: run the plugin, and swap the client only if what came
/// back is new. Swapping in an identical one still tells every watch and log
/// stream to start again, and the screen rebuilds itself for nothing.
async fn renew_once(
    app: &AppHandle,
    context: &str,
    before: DateTime<Utc>,
    stop_rx: &mut oneshot::Receiver<()>,
) -> crate::error::Result<Renewed> {
    let state = app.state::<AppState>();
    // From disk, not the copy taken at connect: an OIDC refresh spends the
    // stored token and writes its replacement to the file, so the second
    // renewal would offer one the provider already rotated.
    state
        .client_manager
        .load_kubeconfig_resolved(crate::commands::cluster::read_kubeconfig_overrides())
        .await
        .map_err(|e| crate::error::Error::Config(e.to_string()))?;
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
    if prepared.expires_at == Some(before) {
        return Ok(Renewed::Unchanged);
    }
    // Everything past here installs the result, and a renewal whose context
    // was disconnected or signed into again while the plugin ran would lay a
    // stale token over what the reader now has.
    if stopped(stop_rx) || state.client_manager.credential_deadline(context) != Some(before) {
        return Ok(Renewed::Superseded);
    }
    state
        .client_manager
        .connect_with_kubeconfig(context, prepared.kubeconfig)
        .await
        .map_err(|e| crate::error::Error::Connection(e.to_string()))?;
    // After the client: a deadline written for credentials that then failed
    // to connect describes a token the window is not using.
    state
        .client_manager
        .set_credential_deadline(context, prepared.expires_at);
    // One request before anybody is told: building a client proves nothing,
    // and this event is what lifts the refusal screen.
    state
        .client_manager
        .test_connection(context)
        .await
        .map_err(|e| crate::error::Error::Connection(e.to_string()))?;
    // Only now: telling the holders of the old client any earlier would have
    // them rebuild onto it.
    state.emit(crate::state::AppEvent::CredentialsRenewed {
        context: context.to_string(),
    });
    Ok(Renewed::Replaced(prepared.expires_at))
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

    /// A plugin that hands back the token it already had cannot be asked
    /// again on the same schedule: kubelogin re-uses an `id-token` until a
    /// minute before it expires, so the ordinary margin gets the same answer
    /// every thirty seconds until the deadline passes — and each answer used
    /// to restart every watch in the window.
    #[test]
    fn a_plugin_that_answered_with_the_same_token_is_asked_later_not_sooner() {
        let now = Utc::now();
        let deadline = now + Duration::minutes(2);

        let ordinary = next_wait(deadline, now, Timing::Margin).expect("still ahead");
        let crept = next_wait(deadline, now, Timing::Creep).expect("still ahead");
        assert!(
            crept > ordinary,
            "creeping has to land later than the margin it already tried"
        );
        assert!(
            crept < (Duration::minutes(2)).to_std().unwrap(),
            "and still before the deadline"
        );

        // Already inside the creep: there is no later left to ask at.
        assert_eq!(
            next_wait(now + Duration::seconds(5), now, Timing::Creep),
            None
        );
    }

    /// The silent flow is given thirty seconds of its own. A last attempt
    /// twenty seconds before the deadline can therefore finish *after* the
    /// credentials it was renewing have died — the reader gets the refusal
    /// this exists to prevent, from the attempt meant to prevent it.
    #[test]
    fn the_last_attempt_before_the_deadline_has_room_to_finish() {
        assert!(
            CREEP.num_seconds() as u64 > crate::auth::interactive::SILENT_FLOW_TIMEOUT_SECS,
            "a renewal that can outlive the token it renews is not a renewal"
        );
        assert!(
            CREEP < Duration::minutes(1),
            "kubelogin hands back the token it has until a minute before expiry"
        );
    }

    /// The rung that has no room hands the ladder on; it does not end it.
    ///
    /// A credential answered "same token" with less than `CREEP` of life
    /// left has no moment on the creep rung — and giving up there would skip
    /// the one attempt past the deadline, for exactly the short-lived
    /// credentials it was added for. This is the walk `run` does between
    /// rungs, which no test reached while it was written inline.
    #[test]
    fn a_rung_with_no_room_hands_on_rather_than_ending_the_ladder() {
        let now = Utc::now();

        // Forty seconds left: the creep rung wanted forty-five.
        let deadline = now + Duration::seconds(40);
        assert_eq!(next_wait(deadline, now, Timing::Creep), None, "no room");
        let (rung, wait) = rung_with_room(deadline, now, Timing::Creep).expect("one left");
        assert_eq!(rung, Timing::Past, "the creep rung handed on");
        assert!(
            wait > (Duration::seconds(40)).to_std().unwrap(),
            "and it lands after the deadline, which is the whole point"
        );

        // Past is the last one: once it has been used there is nothing left.
        assert_eq!(
            rung_with_room(deadline, now, Timing::Past).map(|(r, _)| r),
            Some(Timing::Past)
        );
        assert!(rung_with_room(deadline, now, Timing::Past)
            .and_then(|_| Timing::Past.next())
            .is_none());
    }

    /// Some plugins mint nothing until the old credential is actually dead,
    /// so every attempt before the deadline is answered with the token in
    /// use and the schedule used to give up a few seconds short of the
    /// `401`. One attempt past the deadline is a few seconds of refusal that
    /// lifts itself, instead of a Sign in screen that waits for a click.
    #[test]
    fn a_plugin_that_mints_nothing_early_is_asked_once_after_the_deadline() {
        let now = Utc::now();
        let deadline = now + Duration::seconds(10);

        assert_eq!(Timing::Margin.next(), Some(Timing::Creep));
        assert_eq!(Timing::Creep.next(), Some(Timing::Past));
        assert_eq!(Timing::Past.next(), None, "and then there is nothing left");

        // The creep has already gone by, and the attempt past the deadline
        // is still ahead: that is the one that reaches such a plugin.
        assert_eq!(next_wait(deadline, now, Timing::Creep), None);
        let past = next_wait(deadline, now, Timing::Past).expect("always ahead");
        assert!(
            past > (Duration::seconds(10)).to_std().unwrap(),
            "past the deadline, not before it"
        );
    }

    /// Only one kind of failure predicts a sign-in *because somebody was
    /// asked*. A kubeconfig that would not read says nothing about whether a
    /// person is needed, and running out of room before the deadline is a
    /// third thing again — `RanOut`, not `NeedsYou`.
    #[test]
    fn only_a_plugin_asking_for_a_person_is_reported_as_needing_one() {
        use crate::error::{AuthError, Error};
        assert!(needs_person(&Error::Auth(AuthError::NeedsPerson(
            "the stored tokens are spent".to_string()
        ))));
        assert!(!needs_person(&Error::Config("no such file".to_string())));
        assert!(!needs_person(&Error::Connection("timed out".to_string())));
        assert!(!needs_person(&Error::Auth(AuthError::Kubeconfig(
            "exec command missing".to_string()
        ))));
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

    /// TEMPORARY simulation of `run`'s rung ladder for a plugin that always
    /// answers with the token in use.
    #[test]
    fn sim_ladder_reachability() {
        fn walk(life: i64, plugin: i64) -> Vec<Timing> {
            let t0 = Utc::now();
            let deadline = t0 + Duration::seconds(life);
            let mut now = t0;
            let mut timing = Timing::Margin;
            let mut reached: Vec<Timing> = Vec::new();
            let Some(mut wait) = wait_for(deadline, now) else {
                return reached;
            };
            for _ in 0..10 {
                now += Duration::from_std(wait).unwrap();
                reached.push(timing);
                now += Duration::seconds(plugin);
                let Some(later) = timing.next() else { break };
                timing = later;
                let Some(again) = next_wait(deadline, now, timing) else {
                    break;
                };
                wait = again;
            }
            reached
        }
        for life in [45i64, 60, 70, 76, 100, 105, 110, 150, 300, 3600] {
            for plugin in [0i64, 1, 5, 25] {
                println!(
                    "life={life:5} plugin={plugin:3} -> {:?}",
                    walk(life, plugin)
                );
            }
        }
    }
}
