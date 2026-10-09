/**
 * Whether a Service takes traffic, as one verdict for every surface.
 *
 * The page, the peek, the Endpoints object and the Services list all draw
 * it from here, from what the Service publishes. The state comes from the
 * published counts, which every reader holds, and from whether the
 * workloads behind a Service with none ready are only waiting on their pods,
 * which both backend readers ask alike; the page only adds a sharper reason.
 */

import { EyeOff, type LucideIcon } from "lucide-react";

import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import type {
  ChainStop,
  NotServing,
  ResourceConnections,
  ServicePublished,
} from "@/generated/types";
import { askedPorts, describeStop } from "@/lib/connections";
import { errorToShow } from "@/lib/error-utils";
import { endpointCount, publishedFor, servingCount } from "@/lib/published";
import type { StatusRole } from "@/lib/status-role";

export type ServiceHealth =
  | { state: "ready"; serving: number }
  | { state: "partly"; serving: number; total: number }
  | { state: "noneReady"; published: PublishedCounts }
  /** None ready or none listed, and every workload behind it is still starting its pods. */
  | { state: "comingUp"; published: PublishedCounts }
  /** None ready or none listed, and the pods every workload behind it waits on were not read. */
  | { state: "podsUnread"; published: PublishedCounts }
  | { state: "noEndpoints"; published: PublishedCounts }
  /** No pods by intent: every workload behind it is scaled to zero. */
  | { state: "idle"; stop: Extract<ChainStop, { reason: "scaledToZero" }> }
  /** A DNS alias: no endpoints, by design. */
  | { state: "externalName" }
  /** No selector, and nobody wrote an endpoint by hand. */
  | { state: "selectorless" }
  /** What it publishes was not read, or not yet. */
  | { state: "unknown"; why: string | null };

export interface ServiceShape {
  type: string;
  selectorless: boolean;
}

/** What the verdict reads of what a Service publishes: the full answer and the compact one both carry it. */
export type PublishedCounts = Pick<
  ServicePublished,
  "ready" | "draining" | "notReady" | "unrouted"
> & { stop?: ChainStop | null };

/** One Service as its verdict reads it, the shape `listServiceHealthInputs` answers in. */
export type ServiceHealthInput = ServiceShape & PublishedCounts;

export function serviceHealthOf(
  service: ServiceShape,
  published: PublishedCounts | undefined,
  failure: string | null
): ServiceHealth {
  if (service.type === "ExternalName") return { state: "externalName" };
  if (!published) return { state: "unknown", why: failure };
  const serving = servingCount(published);
  const listed = endpointCount(published);
  const total = listed + published.unrouted;
  if (service.selectorless && total === 0) return { state: "selectorless" };
  if (serving > 0) {
    return serving === total
      ? { state: "ready", serving }
      : { state: "partly", serving, total };
  }
  const waiting = waitingOn(published.stop);
  if (listed > 0) return { state: waiting ?? "noneReady", published };
  return published.stop?.reason === "scaledToZero"
    ? { state: "idle", stop: published.stop }
    : { state: waiting ?? "noEndpoints", published };
}

/**
 * What a Service serving nothing waits on, whether or not its slices list an
 * address yet: a pod pulling its image has none, and is as much coming up as
 * one that has an address and is not ready.
 */
function waitingOn(
  stop: ChainStop | null | undefined
): "comingUp" | "podsUnread" | null {
  if (stop?.reason === "publishesNothingYet")
    return stop.podsUnread ? "podsUnread" : null;
  if (stop?.reason !== "noneReady") return null;
  return stop.why === "comingUp" || stop.why === "podsUnread" ? stop.why : null;
}

export interface Verdict {
  /** A stable code for `StatusBadge`; the role is given, not looked up. */
  code: string;
  label: string;
  role: StatusRole;
  reason: string | null;
  /** A mark of its own in place of the role's glyph. */
  glyph?: LucideIcon;
}

/** What follows "none of them is ready": a cause, never the same words again. */
const NONE_READY_CAUSE: Record<NotServing, keyof typeof en.empty> = {
  unscheduled: "stopNotScheduled",
  starting: "stopNotStarted",
  crashLooping: "stopCrashLooping",
  terminating: "stopTerminating",
  failingReadiness: "causeFailingReadiness",
  finished: "stopFinished",
  mixed: "causeSeveral",
  other: "causeOwnStatus",
  inSlices: "causeOnServicePage",
  comingUp: "causeComingUp",
  podsUnread: "causePodsUnread",
};

function stopReason(published: PublishedCounts, t: T): string | null {
  const stop = published.stop;
  if (!stop || !("service" in stop)) return null;
  // The cause, where the stop knows one: "publishes no endpoint" beside a
  // badge reading No endpoints says nothing the badge did not.
  if (stop.reason === "publishesNothing" && stop.unnamedPorts.length > 0)
    return t("nav", "stopUnnamedPortCause", {
      asked: askedPorts(stop.unnamedPorts, t),
    });
  const title = describeStop(stop, t).title;
  const why =
    stop.reason === "noneReady"
      ? stop.why
      : stop.reason === "publishesNothingYet" && stop.podsUnread
        ? "podsUnread"
        : null;
  return why ? `${title}: ${t("empty", NONE_READY_CAUSE[why])}` : title;
}

export function serviceHealthWords(health: ServiceHealth, t: T): Verdict {
  switch (health.state) {
    case "ready":
      return {
        code: health.state,
        label: t("count", "nReady", { n: health.serving }),
        role: "ok",
        reason: null,
      };
    case "partly":
      return {
        code: health.state,
        label: t("count", "readyOfTotal", {
          ready: health.serving,
          total: health.total,
        }),
        role: "warn",
        reason: t("count", "addressesTakeNoTraffic", {
          n: health.total - health.serving,
        }),
      };
    case "noneReady":
      return {
        code: health.state,
        label: t("empty", "stopNoneReady"),
        role: "err",
        reason: stopReason(health.published, t),
      };
    case "comingUp":
      return {
        code: health.state,
        label: t("readings", "healthComingUp"),
        role: "pending",
        reason: stopReason(health.published, t),
      };
    case "podsUnread":
      return {
        code: health.state,
        label:
          endpointCount(health.published) > 0
            ? t("empty", "stopNoneReady")
            : t("readings", "healthNoEndpoints"),
        role: "neutral",
        reason: stopReason(health.published, t),
        glyph: EyeOff,
      };
    case "noEndpoints":
      return {
        code: health.state,
        label: t("readings", "healthNoEndpoints"),
        role: "err",
        reason: stopReason(health.published, t),
      };
    case "idle":
      return {
        code: health.state,
        label: t("readings", "healthIdle"),
        role: "neutral",
        reason: describeStop(health.stop, t).title,
      };
    case "externalName":
      return {
        code: health.state,
        label: t("readings", "healthDnsAlias"),
        role: "neutral",
        reason: t("readings", "healthDnsAliasWhy"),
      };
    case "selectorless":
      return {
        code: health.state,
        label: t("readings", "healthByHand"),
        role: "neutral",
        reason: t("nav", "endpointsByHandNoneWritten"),
      };
    case "unknown":
      // Refused and not yet answered are two states, and only one is final.
      return health.why === null
        ? {
            code: "reading",
            label: t("readings", "healthStillReading"),
            role: "neutral",
            reason: null,
          }
        : {
            code: health.state,
            label: t("nav", "notChecked"),
            role: "neutral",
            reason: health.why,
          };
  }
}

/** Every label `serviceHealthWords` can draw, two-digit counts included, for the column that has to hold the widest. */
export const serviceVerdictLabels = (t: T) => [
  t("count", "nReady", { n: 99 }),
  t("count", "readyOfTotal", { ready: 99, total: 99 }),
  t("empty", "stopNoneReady"),
  t("readings", "healthComingUp"),
  t("readings", "healthNoEndpoints"),
  t("readings", "healthIdle"),
  t("readings", "healthDnsAlias"),
  t("readings", "healthByHand"),
  t("readings", "healthStillReading"),
  t("nav", "notChecked"),
];

/** One neighbourhood read, and when it answered: no older than its lists were asked for. */
export interface ReadAnswer {
  data: ResourceConnections;
  at: number;
}

/**
 * Whether a neighbourhood read can speak for the Service on screen. One about
 * another Service of the same name cannot, nor one that found no pod carrying
 * the selector while the Service's own pod watch has since seen one: a read
 * older than what is known is a read not taken yet. Sam's big-pull page drew
 * "1 ready" from the Service deleted before it, and "No pod carries
 * app=big-pull" for seconds while its pod was being created.
 */
export function speaksFor(
  answer: ReadAnswer,
  service: { name: string; uid: string | undefined },
  watched: { pods: number; at: number } | undefined
): boolean {
  const { data } = answer;
  if (data.subject.name !== service.name) return false;
  if (service.uid && data.subjectUid && data.subjectUid !== service.uid)
    return false;
  const none =
    publishedFor(data, data.subject)?.stop?.reason === "selectsNothing";
  const read = data.readAt ? Date.parse(data.readAt) : answer.at;
  return !(none && watched && watched.pods > 0 && read < watched.at);
}

/** A Service's verdict from its neighbourhood, the answer its trace draws. */
export function healthFromConnections(
  data: ResourceConnections | undefined,
  error: unknown
): ServiceHealth {
  if (!data) {
    return { state: "unknown", why: error ? errorToShow(error) : null };
  }
  const facts = data.subject.facts;
  const shape =
    facts?.kind === "service"
      ? { type: facts.type, selectorless: facts.selector === null }
      : { type: "", selectorless: false };
  return serviceHealthOf(shape, publishedFor(data, data.subject), null);
}
