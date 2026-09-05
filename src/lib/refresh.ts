/**
 * How often the app is allowed to ask the cluster the same question again.
 *
 * The rates are what a *moving* screen re-reads at. The three conditions
 * under which re-reading is pointless are decided here, so no screen decides
 * them for itself:
 *
 * 1. **Nobody is looking.** An off-screen tab or hidden window switches the
 *    interval off rather than lengthening it. Coming back refetches.
 * 2. **Nothing is happening.** Identical answers are the cluster telling us
 *    to stop asking; the interval doubles to a cap.
 * 3. **The window is not the one being used.** Visible but unfocused is a
 *    glance, not a reading, so it is held at the cap.
 *
 * Backing off is a promise the UI keeps: {@link effectiveInterval} is also
 * what tells `DataFreshness` to say "slowed" instead of "polling", so nothing
 * on screen is older than the badge above it implies. A watch is not touched
 * here — a connected stream keeps data live at any poll rate, and
 * `refresh: false` is how a watched query says so.
 *
 * @module lib/refresh
 */

/**
 * The rate a screen re-reads at while it is being watched *and* still moving:
 * what "as it happens" costs on a screen that has no watch behind it. The
 * saving comes from {@link effectiveInterval}, not from making a moving
 * screen sluggish.
 */
export const REFRESH_INTERVALS = {
  resourceList: 2000,
  resourceDetail: 2000,
  /**
   * The cluster-wide aggregate: the sidebar's row counts, the namespace
   * picker, the status bar, and the Overview page.
   *
   * The priciest query in the app. One poll fans out to about a dozen
   * cluster-wide LISTs, and the window asks for it in two scopes at once —
   * the current namespace for the rail, the whole cluster for the status bar
   * — so at a two-second rate it alone is ~700 requests a minute.
   *
   * It is also the one query that cannot back off on its own: the payload
   * carries node CPU and memory usage, different on every single read, so a
   * rule that waits for an identical answer waits forever. The rate is the
   * only lever it has.
   *
   * Ten seconds, because nothing this reports turns over faster: a kubelet
   * takes ten seconds to report a status change at all, a CrashLoopBackOff
   * lasts minutes, and a namespace's pod count is chrome.
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
 * does not make a reading older, it makes the recording worse. So a recorder
 * keeps its cadence while somebody is watching it and stops dead when they are
 * not — the one saving that costs the chart nothing.
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
 * `steadyAfter: 3` — three identical answers before anything changes; six
 * seconds at the 2s base. Long enough that a Deployment mid-rollout (something
 * different every poll) never backs off at all, short enough that an idle page
 * stops costing almost immediately.
 *
 * `factor: 2` — doubling reaches the cap in four more reads: 2s for the first
 * ~6s, then 4s, 8s, 16s, at the cap ~34 seconds in. The half-minute in which a
 * reader is actually deciding something is served at full rate.
 *
 * `cap: 30_000` — the same order as the intervals the cluster itself works on
 * (kubelet status updates and node leases are 10s), so half a minute cannot
 * hide a settled state change. It is also as long as a "slowed" label can
 * carry: past that the honest word would be "stale".
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
