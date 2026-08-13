/**
 * How often the app is allowed to ask the cluster the same question again.
 *
 * Every number here used to be two seconds, and every screen used it: 45 call
 * sites, 9 of which stopped for a watch and 2 of which cared whether anybody
 * was looking. An app parked on one Pod page cost the API server ~1000
 * requests a minute while its reader made coffee.
 *
 * The rates below are still the rates a *moving* screen re-reads at — that
 * part was never the problem. What was missing is the three conditions under
 * which re-reading is pointless, and this module is where all three are
 * decided so no screen decides them for itself:
 *
 * 1. **Nobody is looking.** An off-screen detail tab, a hidden window: the
 *    interval is not lengthened, it is switched off. Coming back refetches.
 * 2. **Nothing is happening.** Identical answers, over and over, are the
 *    cluster telling us to stop asking. The interval doubles to a cap.
 * 3. **The window is not the one being used.** A visible but unfocused window
 *    is a glance, not a reading, so it is held at the cap.
 *
 * Backing off is a promise the UI has to keep: {@link effectiveInterval} is
 * also what tells `DataFreshness` to say "slowed" instead of "polling", so
 * nothing on screen is older than the badge above it implies. A *watch* is a
 * different thing entirely and is not touched here — a connected stream keeps
 * data live at any poll rate, and `refresh: false` is how a watched query says
 * so.
 *
 * @module lib/refresh
 */

/**
 * The rate a screen re-reads at while it is being watched *and* still moving.
 *
 * Unchanged from when every one of them was chosen: this is what "as it
 * happens" costs on a screen that has no watch behind it. The saving comes
 * from {@link effectiveInterval}, not from making a moving screen sluggish.
 */
export const REFRESH_INTERVALS = {
  resourceList: 2000,
  resourceDetail: 2000,
  /**
   * The cluster-wide aggregate: the sidebar's row counts, the namespace
   * picker, the status bar, and the Overview page.
   *
   * The one rate that was measured rather than reasoned about, and the one
   * that had to move. Counted against the API server on an idle Pod page,
   * this single query was most of what the app cost: one poll fans out to
   * about a dozen cluster-wide LISTs, and the window asks for it in two
   * scopes at once — the current namespace for the rail, the whole cluster
   * for the status bar. At two seconds that is ~700 requests a minute for
   * numbers nobody is waiting on.
   *
   * It is also the one query that cannot back off on its own: the payload
   * carries node CPU and memory usage, which is different on every single
   * read, so a rule that waits for an identical answer waits forever. The
   * rate is the only lever it has.
   *
   * Ten seconds, because nothing this reports turns over faster. A kubelet
   * takes ten seconds to report a status change at all; a CrashLoopBackOff
   * lasts minutes; a namespace's pod count is chrome, glanced at rather than
   * watched. Two seconds was never buying information here, only the
   * appearance of it.
   */
  overview: 10_000,
  metrics: 2000,
  fast: 1000,
  slow: 8000,
  /**
   * Things that change with a deploy rather than with the cluster's own work —
   * a Helm release, an installed chart. Already at the backoff cap, so it never
   * grows: it is as slow as this app is willing to call "polling".
   */
  steady: 30_000,
} as const;

/** The name of a rate, which is what surfaces ask for. */
export type RefreshRate = keyof typeof REFRESH_INTERVALS;

/**
 * The rates where the interval is the *sample spacing of a recording* rather
 * than a staleness budget, and so may not be stretched by the backoff.
 *
 * The usage chart draws what it polled: `bucketize` puts a gap where no sample
 * landed, deliberately, because a gap is not a zero. Slowing that query down
 * does not make a reading older, it makes the recording worse — a line with
 * holes in it, for data that had not changed anyway. So a recorder keeps its
 * cadence for as long as somebody is watching it, and stops dead when they are
 * not, which is the one saving that costs the chart nothing.
 */
export const RECORDED: ReadonlySet<RefreshRate> = new Set(["metrics"]);

export const STALE_TIMES = {
  resourceList: 1000,
  metrics: 1000,
  overview: 1000,
  resourceDetail: 1000,
  fast: 500,
  slow: 6000,
} as const;

/**
 * The three numbers that decide how fast a still screen goes quiet.
 *
 * `steadyAfter: 3` — three identical answers in a row before anything changes.
 * At the 2s base that is six seconds of a screen not moving, which is long
 * enough that a Deployment mid-rollout (something different every poll) never
 * backs off at all, and short enough that an idle page stops costing almost
 * immediately.
 *
 * `factor: 2` — doubling reaches the cap in four more reads. From arrival, a
 * still page runs at 2s for the first ~6s, then 4s, 8s, 16s, and is at the cap
 * ~34 seconds in. The half-minute in which a reader is actually deciding
 * something is served at full rate; what follows is wallpaper.
 *
 * `cap: 30_000` — the same order as the intervals the cluster itself works on
 * (kubelet status updates and node leases are 10s), so half a minute cannot
 * hide a state change that has been settled for long. It is also about as long
 * as a "slowed" label can carry: past that the honest word would be "stale",
 * and a screen that needs that word should not be on screen.
 *
 * `unfocusedFloor: 30_000` — a window you can see but are not typing into is
 * being glanced at. It keeps updating, because it is on screen and must not
 * lie, but it goes straight to the cap instead of walking there.
 */
export const BACKOFF = {
  steadyAfter: 3,
  factor: 2,
  cap: 30_000,
  unfocusedFloor: 30_000,
} as const;

export interface RefreshState {
  /** The surface holding this query is on screen: shown tab, shown window. */
  visible: boolean;
  /** The OS window has focus — the reader is *in* the app, not beside it. */
  focused: boolean;
  /** Consecutive re-reads that came back identical to the one before. */
  steadyRuns: number;
  /** This rate is a recording's cadence — see {@link RECORDED}. */
  recording?: boolean;
}

/**
 * What this query should actually re-read at, or `false` for "do not".
 *
 * `false` in means `false` out: a query a watch stream feeds is not on a timer
 * at all and none of the rules below apply to it.
 */
export function effectiveInterval(
  base: number | false,
  { visible, focused, steadyRuns, recording = false }: RefreshState
): number | false {
  if (base === false) return false;
  // Off screen is not "slower", it is off. The reader cannot be misled by a
  // number they cannot see, and returning to it refetches before they can.
  if (!visible) return false;

  const steps = recording
    ? 0
    : Math.max(0, steadyRuns - BACKOFF.steadyAfter + 1);
  const grown = Math.min(base * BACKOFF.factor ** steps, BACKOFF.cap);
  // `max`, not `=`: a rate slower than the floor stays at its own rate. The
  // floor is a ceiling on effort, not a promise to poll more often.
  return focused ? grown : Math.max(grown, BACKOFF.unfocusedFloor);
}
