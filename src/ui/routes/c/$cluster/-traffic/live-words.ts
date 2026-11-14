/** What a live stream says where it has no flows to draw. */
import type { LiveEnd } from "@/generated/types";
import type { LiveSnapshot } from "@/hooks/useLiveTraffic";
import type { T } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";

/** How a live stream ended, said; `closed` is the page leaving and says nothing. */
const LIVE_END: Record<LiveEnd["says"], (end: LiveEnd, t: T) => string> = {
  closed: () => "",
  unsubscribed: (_, t) => t("traffic", "liveUnsubscribed"),
  notEnabled: (_, t) => t("traffic", "liveNotEnabled"),
  notLooked: (end, t) =>
    t("traffic", "liveNotLooked", { said: "said" in end ? end.said : "" }),
  servesTls: (end, t) =>
    t("traffic", "liveServesTls", {
      namespace: "namespace" in end ? end.namespace : "",
    }),
  noPod: (end, t) =>
    end.says === "noPod"
      ? t("traffic", "liveNoPod", {
          namespace: end.namespace,
          service: end.service,
        })
      : "",
  relayEnded: (_, t) => t("traffic", "liveRelayEnded"),
  failed: (end, t) =>
    t("traffic", "liveFailed", { said: "said" in end ? end.said : "" }),
};

/** The sentence a live stream stands at instead of flows, or `null` once it flows. */
export function liveStopped(live: LiveSnapshot, t: T): string | null {
  if (live.error)
    return t("traffic", "liveFailed", { said: errorToShow(live.error) });
  if (live.phase === "ended" && live.end && live.end.says !== "closed")
    return LIVE_END[live.end.says](live.end, t);
  if (live.phase === "connecting") return t("traffic", "liveConnecting");
  return null;
}
