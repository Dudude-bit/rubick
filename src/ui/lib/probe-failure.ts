import type {
  ContainerRestarts,
  EventInfo,
  ProbeFailure,
  ProbeKind,
} from "@/generated/types";
import type { T } from "@/i18n/useT";

/** How long a probe failure the kubelet reported still counts; `src/contracts/probe-failure-conformance.json` holds both halves to it. */
export const PROBE_WINDOW_MINUTES = 60;

const FAILED = /^(liveness|readiness|startup) probe failed/i;

const seen = (event: EventInfo): number | null => {
  const at = event.lastTimestamp ?? event.firstTimestamp;
  return at === null ? null : Date.parse(at);
};

/**
 * What the events about one pod say of its probes, given the restarts of
 * the containers a probe runs in: the same answer as `probe_failure` in
 * Rust, which raises the Overview's row and the list's mark. Nothing where
 * none restarted, where no probe failed inside the window, and where the
 * events were not read.
 */
export function probeFailure(
  containers: readonly ContainerRestarts[],
  events: readonly EventInfo[] | undefined,
  now: number
): ProbeFailure | null {
  const restarted = containers
    .filter((container) => container.n > 0)
    .reduce<ContainerRestarts | null>(
      (most, next) => (most === null || next.n > most.n ? next : most),
      null
    );
  if (restarted === null || events === undefined) return null;
  const cutoff = now - PROBE_WINDOW_MINUTES * 60_000;
  let newest: { event: EventInfo; probe: ProbeKind } | null = null;
  for (const event of events) {
    if (event.type !== "Warning" || event.reason !== "Unhealthy") continue;
    const at = seen(event);
    if (at !== null && at < cutoff) continue;
    const probe = event.message?.match(FAILED)?.[1]?.toLowerCase() as
      | ProbeKind
      | undefined;
    if (!probe) continue;
    if (
      newest === null ||
      (at ?? -Infinity) > (seen(newest.event) ?? -Infinity)
    )
      newest = { event, probe };
  }
  if (newest === null) return null;
  return {
    container: restarted.container,
    probe: newest.probe,
    restarts: restarted.n,
    said: newest.event.message ?? "",
    since: newest.event.firstTimestamp ?? newest.event.lastTimestamp,
  };
}

/** The finding as one line, the words the page's headline and the Overview's row share. */
export const probeFailureHeadline = (failure: ProbeFailure, t: T): string =>
  t("empty", "probeFailing", {
    container: failure.container,
    probe: failure.probe,
  });
