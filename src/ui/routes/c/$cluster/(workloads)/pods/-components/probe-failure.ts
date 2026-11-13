import type { EventInfo } from "@/generated/types";

export type Probe = "liveness" | "readiness" | "startup";

const FAILED = /^(Liveness|Readiness|Startup) probe failed/i;

/** The newest probe failure the kubelet wrote about a pod, or nothing where its events say none: an unread list says nothing either. */
export function probeFailure(
  events: readonly EventInfo[] | undefined
): { probe: Probe; message: string } | null {
  const stamp = (event: EventInfo) =>
    Date.parse(event.lastTimestamp ?? event.firstTimestamp ?? "") || 0;
  const newest = (events ?? [])
    .filter(
      (event) =>
        event.reason === "Unhealthy" && FAILED.test(event.message ?? "")
    )
    .sort((a, b) => stamp(b) - stamp(a))[0];
  const probe = newest?.message?.match(FAILED)?.[1]?.toLowerCase() as
    | Probe
    | undefined;
  return newest && probe ? { probe, message: newest.message ?? "" } : null;
}
