/**
 * Whether a Service takes traffic, as one verdict for every surface.
 *
 * The page, the peek, the Endpoints object and the Services list all draw
 * it from here, from what the Service publishes. The state comes from the
 * published counts, which every reader holds, and from whether the
 * workloads behind a Service with none ready are only waiting on their pods,
 * which both backend readers ask alike; the page only adds a sharper reason.
 */

import { EyeOff, PenLine, type LucideIcon } from "lucide-react";

import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import type {
  ChainStop,
  NotServing,
  ObjectRef,
  ResourceConnections,
  ServiceHealthGroup,
  ServiceHealthInputs,
  ServicePublished,
  SharedCause,
} from "@/generated/types";
import {
  askedPorts,
  describeStop,
  stopCause,
  stopMood,
} from "@/lib/connections";
import { makersUnread } from "@/lib/stop-mood";
import { isPolicyStop, type PolicyStop } from "@/lib/policy-door";
import { sharedAfterCount } from "@/lib/pod-cause";
import { errorToShow } from "@/lib/error-utils";
import { endpointCount, publishedFor, servingCount } from "@/lib/published";
import type { StatusRole } from "@/lib/status-role";

export type ServiceHealth =
  | { state: "ready"; ready: number }
  | {
      state: "partly";
      ready: number;
      draining: number;
      total: number;
      /** Listed with none of the ports it targets, so nothing is sent there; ready or not is a separate fact. */
      unrouted: number;
      /** Of those, how many the slices call ready; `null` where the compact answer does not carry it. */
      unroutedReady: number | null;
    }
  /** Nothing ready: what it serves goes to addresses still finishing their connections. */
  | { state: "draining"; draining: number; total: number }
  | { state: "noneReady"; published: PublishedCounts }
  /** None ready or none listed, and every workload behind it is still starting its pods. */
  | { state: "comingUp"; published: PublishedCounts }
  /** None ready or none listed, and the pods every workload behind it waits on, or the workloads that could be at zero, were not read. */
  | { state: "podsUnread"; published: PublishedCounts }
  | { state: "noEndpoints"; published: PublishedCounts }
  /** Its pods are ready and a NetworkPolicy lets no connection to them through. */
  | { state: "shut"; ready: number; stop: PolicyStop }
  /** No pods by intent: every workload behind it is scaled to zero. */
  | { state: "idle"; stop: Extract<ChainStop, { reason: "scaledToZero" }> }
  /** A DNS alias: no endpoints, by design. */
  | { state: "externalName" }
  /** No selector, and nobody wrote an endpoint by hand. */
  | { state: "selectorless" }
  /** No selector, and addresses someone wrote: not picked from pods, and never probed here. */
  | { state: "byHand"; ready: number; total: number }
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
> &
  Partial<Pick<ServicePublished, "unroutedReady" | "door">> & {
    stop?: ChainStop | null;
  };

/** One Service as its verdict reads it, the shape `listServiceHealthInputs` answers in. */
export type ServiceHealthInput = ServiceShape &
  PublishedCounts &
  Pick<ServiceHealthGroup, "targets"> &
  Partial<Pick<ServiceHealthInputs, "networks">>;

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
  if (service.selectorless && serving > 0)
    return { state: "byHand", ready: published.ready, total };
  if (serving > 0) {
    const { ready, draining } = published;
    if (isPolicyStop(published.stop))
      return { state: "shut", ready, stop: published.stop };
    if (ready === total) return { state: "ready", ready };
    return ready > 0
      ? {
          state: "partly",
          ready,
          draining,
          total,
          unrouted: published.unrouted,
          unroutedReady: published.unroutedReady ?? null,
        }
      : { state: "draining", draining, total };
  }
  const waiting = waitingOn(published.stop);
  if (listed > 0) return { state: waiting ?? "noneReady", published };
  return published.stop?.reason === "scaledToZero"
    ? { state: "idle", stop: published.stop }
    : { state: waiting ?? "noEndpoints", published };
}

/**
 * Whether nothing a Service publishes serves and the pods every workload
 * behind it waits on were not read: an address of it not ready is then not
 * known to be a fault, and every reader of its Endpoints object draws it so.
 */
export function podsUnreadOf(published: PublishedCounts | undefined): boolean {
  return (
    !!published &&
    servingCount(published) === 0 &&
    waitingOn(published.stop) === "podsUnread"
  );
}

/**
 * What a Service serving nothing waits on, whether or not its slices list an
 * address yet: a pod pulling its image has none, and is as much coming up as
 * one that has an address and is not ready.
 */
function waitingOn(
  stop: ChainStop | null | undefined
): "comingUp" | "podsUnread" | null {
  if (stop?.reason === "podsBeingMade") return "comingUp";
  if (stop && makersUnread(stop)) return "podsUnread";
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
  /** The cause its pods share, drawn as theirs where the reason is not a tooltip. */
  cause?: StopCause;
  /** A mark of its own in place of the role's glyph. */
  glyph?: LucideIcon;
}

/** A stop whose pods share a cause: the stop's words, the pods they count, and the cause they lead to. */
export type StopCause = { lead: string; counted: number; shared: SharedCause };

/** A stop cause as plain words. */
export const stopCauseText = (cause: StopCause, t: T): string =>
  `${cause.lead}: ${sharedAfterCount(cause.shared, cause.counted, t)}`;

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

function stopWords(
  published: PublishedCounts,
  t: T
): Pick<Verdict, "reason" | "cause"> {
  const stop = published.stop;
  if (!stop || !("service" in stop)) return { reason: null };
  // The cause, where the stop knows one: "publishes no endpoint" beside a
  // badge reading No endpoints says nothing the badge did not.
  if (stop.reason === "publishesNothing" && stop.unnamedPorts.length > 0)
    return {
      reason: t("nav", "stopUnnamedPortCause", {
        asked: askedPorts(stop.unnamedPorts, t),
      }),
    };
  const title = describeStop(stop, t).title;
  const shared = stopCause(stop);
  if (shared && stop.reason === "noneReady") {
    const cause = { lead: title, counted: stop.pods, shared };
    return { reason: stopCauseText(cause, t), cause };
  }
  if (makersUnread(stop))
    return { reason: `${title}: ${t("empty", "causeMakersUnread")}` };
  const why =
    stop.reason === "noneReady"
      ? stop.why
      : stop.reason === "publishesNothingYet" && stop.podsUnread
        ? "podsUnread"
        : null;
  return {
    reason: why ? `${title}: ${t("empty", NONE_READY_CAUSE[why])}` : title,
  };
}

export function serviceHealthWords(health: ServiceHealth, t: T): Verdict {
  switch (health.state) {
    case "ready":
      return {
        code: health.state,
        label: t("count", "nReady", { n: health.ready }),
        role: "ok",
        reason: null,
      };
    case "partly": {
      const notReady =
        health.total - health.ready - health.draining - health.unrouted;
      return {
        code: health.state,
        // Ready and routed are two facts: an address with none of the
        // ports is not a not-ready one, so the count is of traffic.
        label:
          health.unrouted > 0
            ? t("count", "takeTrafficOfTotal", {
                n: health.ready + health.draining,
                total: health.total,
              })
            : t("count", "readyOfTotal", {
                ready: health.ready,
                total: health.total,
              }),
        role: "warn",
        reason: [
          health.draining > 0 &&
            t("readings", "drainingCount", { n: health.draining }),
          notReady > 0 && t("count", "addressesTakeNoTraffic", { n: notReady }),
          health.unrouted > 0 &&
            t(
              "count",
              health.unroutedReady === health.unrouted
                ? "addressesReadyOffPort"
                : "addressesOffPort",
              { n: health.unrouted }
            ),
        ]
          .filter(Boolean)
          .join(", "),
      };
    }
    case "draining":
      return {
        code: health.state,
        label: t("readings", "drainingCount", { n: health.draining }),
        role: "warn",
        reason: t("readings", "healthDrainingWhy"),
      };
    case "noneReady":
      return {
        code: health.state,
        label: t("empty", "stopNoneReady"),
        role: "err",
        ...stopWords(health.published, t),
      };
    case "comingUp":
      return {
        code: health.state,
        label: t("readings", "healthComingUp"),
        role: "pending",
        ...stopWords(health.published, t),
      };
    case "podsUnread":
      return {
        code: health.state,
        label:
          endpointCount(health.published) > 0
            ? t("empty", "stopNoneReady")
            : t("readings", "healthNoEndpoints"),
        role: "neutral",
        ...stopWords(health.published, t),
        glyph: EyeOff,
      };
    case "noEndpoints":
      return {
        code: health.state,
        label: t("readings", "healthNoEndpoints"),
        role: "err",
        ...stopWords(health.published, t),
      };
    case "shut":
      return {
        code: health.state,
        label: t("empty", "stopPolicyShutUnder"),
        role: "err",
        reason: describeStop(health.stop, t).title,
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
    case "byHand":
      return {
        code: health.state,
        label: t("count", "nByHand", { n: health.total }),
        role: "neutral",
        reason: [
          t("readings", "healthByHandWhy", { n: health.total }),
          health.ready < health.total &&
            t("readings", "healthByHandNotReady", {
              n: health.total - health.ready,
            }),
        ]
          .filter(Boolean)
          .join(" "),
        glyph: PenLine,
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
  t("count", "takeTrafficOfTotal", { n: 99, total: 99 }),
  t("readings", "drainingCount", { n: 99 }),
  t("empty", "stopNoneReady"),
  t("readings", "healthComingUp"),
  t("readings", "healthNoEndpoints"),
  t("readings", "healthIdle"),
  t("readings", "healthDnsAlias"),
  t("readings", "healthByHand"),
  t("count", "nByHand", { n: 99 }),
  t("readings", "healthStillReading"),
  t("nav", "notChecked"),
];

/**
 * What a Service's pod watch can say of its pods: how many it lists and when
 * that last changed, that it is still listing them, or nothing, where none
 * is running or it failed.
 */
export type PodsSeen = { pods: number; at: number } | "listing" | undefined;

/** What the watches under one Service have seen: its pods, and when a slice it publishes last changed (0 for never). */
export interface ServiceSeen {
  pods: PodsSeen;
  changed: number;
}

/** What the watches under each Service an answer names have seen, `undefined` for one nobody watches. */
export type SeenOf = (service: ObjectRef) => ServiceSeen | undefined;

/** One neighbourhood read, and when it answered: no older than its lists were asked for. */
export interface ReadAnswer {
  data: ResourceConnections;
  at: number;
}

const readTime = ({ data, at }: ReadAnswer) =>
  data.readAt ? Date.parse(data.readAt) : at;

/**
 * Whether what a read says each Service publishes can stand, read at `read`:
 * not where, about any Service it names, it found no pod carrying the
 * selector while that Service's pod watch is still listing them or has since
 * seen one, or stops it at a fault while a slice it publishes has changed
 * since. A read older than what is known is a read not taken yet. Sam's
 * big-pull drew "No pod carries app=big-pull" while its pod was being
 * created, and "publishes no endpoint" from a read whose pods were listed
 * after the pod was Ready and whose slices before its address was written.
 */
export function publishedSpeaks(
  published: readonly Pick<ServicePublished, "service" | "stop">[],
  read: number,
  seen: SeenOf
): boolean {
  return published.every(({ service, stop }) => {
    const watched = stop ? seen(service) : undefined;
    if (!stop || !watched) return true;
    if (stopMood(stop) === "fault" && read < watched.changed) return false;
    const pods = watched.pods;
    if (stop.reason !== "selectsNothing" || !pods) return true;
    if (pods === "listing") return false;
    return !(pods.pods > 0 && read < pods.at);
  });
}

/**
 * Whether a neighbourhood read can speak for the object on screen: not one
 * about another object of the same name, which drew "1 ready" from the
 * Service deleted before big-pull, nor one {@link publishedSpeaks} holds back.
 */
export function speaksFor(
  answer: ReadAnswer,
  subject: { name: string; uid: string | undefined },
  seen: SeenOf
): boolean {
  const { data } = answer;
  if (data.subject.name !== subject.name) return false;
  if (subject.uid && data.subjectUid && data.subjectUid !== subject.uid)
    return false;
  return publishedSpeaks(data.published, readTime(answer), seen);
}

/** Whether a read waits on a pod watch that has not listed yet, whose list reads it again. */
export function waitsOnList(
  data: { published: readonly Pick<ServicePublished, "service" | "stop">[] },
  seen: SeenOf
): boolean {
  return data.published.some(
    ({ service, stop }) =>
      stop?.reason === "selectsNothing" && seen(service)?.pods === "listing"
  );
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
