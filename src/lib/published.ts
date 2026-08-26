/**
 * What a Service publishes, in words.
 *
 * The backend answers with the Service's own EndpointSlices — the cluster's
 * bookkeeping rather than ours — and nothing here re-derives a fact from it.
 * `serving`, `terminating` and `hints.forZones` all arrive stated; this only
 * puts them into a sentence, and refuses to invent the ones that are not
 * there.
 */

import type { T } from "@/i18n/useT";
import type {
  ObjectRef,
  PublishedEndpoint,
  ResourceConnections,
  ServicePublished,
  UnpublishedPod,
} from "@/generated/types";

/** Everything in the answer, published or merely present in it. */
export const endpointCount = (published: ServicePublished): number =>
  published.ready + published.draining + published.notReady;

export function publishedFor(
  conns: ResourceConnections,
  service: ObjectRef
): ServicePublished | undefined {
  return conns.published.find(
    (entry) =>
      entry.service.kind === service.kind &&
      entry.service.name === service.name &&
      (entry.service.namespace ?? null) === (service.namespace ?? null)
  );
}

/**
 * The state of one address, in the slice's own vocabulary.
 *
 * `serving, terminating` is the one worth the extra word: it is a pod
 * finishing its open connections, it is still the address kube-proxy falls
 * back to when nothing else is ready, and the legacy object could not say it
 * at all.
 */
export function endpointState(
  endpoint: PublishedEndpoint,
  t: T
): {
  text: string;
  tone: "ok" | "warn" | "err";
} {
  if (endpoint.ready) {
    return endpoint.terminating
      ? { text: t("readings", "epReadyTerminating"), tone: "warn" }
      : { text: t("readings", "epReady"), tone: "ok" };
  }
  if (endpoint.serving) {
    return {
      text: endpoint.terminating
        ? t("readings", "epServingTerminating")
        : t("readings", "epServingNotReady"),
      tone: "warn",
    };
  }
  return {
    text: endpoint.terminating
      ? t("readings", "epTerminating")
      : t("readings", "epNotReady"),
    tone: "err",
  };
}

/** "3 endpoints across 1 slice" — the count line over the first list. */
export function publishedSummary(published: ServicePublished, t: T): string {
  const total = endpointCount(published);
  switch (published.source) {
    case "slices":
      return t("count", "endpointsAcrossSlices", {
        endpoints: t("count", "endpointsCount", { n: total }),
        slices: t("count", "slicesCount", { n: published.slices }),
      });
    case "legacyEndpoints":
      return t("count", "addressesInEndpoints", { n: total });
    case "podReadiness":
      return t("count", "podsSelectorMatches", { n: total });
  }
}

/**
 * Which object answered, said outright.
 *
 * A cluster below 1.21 serves no slices and a wedged controller writes none,
 * and either way a confident empty would be the app inventing an outage out
 * of its own API version. Naming the source is the whole repair.
 */
export function sourceNote(published: ServicePublished, t: T): string | null {
  switch (published.source) {
    case "slices":
      // Addresses the controller wrote down and gave no port to. They are not
      // endpoints in any sense kube-proxy would recognise, so they are not in
      // the count above — and saying nothing about them would leave the first
      // list reading as an empty Service rather than a broken one.
      return published.unrouted > 0
        ? t("count", "unroutedMatched", { n: published.unrouted })
        : null;
    case "legacyEndpoints":
      return "This cluster served no EndpointSlices, so the legacy Endpoints object answered. It cannot tell a draining address from a dead one, and it stops at 1000.";
    case "podReadiness":
      return "Neither EndpointSlices nor the Endpoints object answered, so this is a deduction rather than the cluster's own word: the pods the selector matches, each read for its own Ready condition.";
  }
}

/** The short form of the same, for a line inside a chain hop. */
export function sourceMark(published: ServicePublished, t: T): string | null {
  switch (published.source) {
    case "slices":
      return null;
    case "legacyEndpoints":
      return t("readings", "epFromLegacy");
    case "podReadiness":
      return t("readings", "epDeducedFromPods");
  }
}

/**
 * What topology-aware routing does to this Service, where hints are on.
 *
 * Null on the overwhelming majority of Services, which is the point: hints
 * are off by default and a caption over a gap is worse than no caption.
 */
export function topologyNote(published: ServicePublished, t: T): string | null {
  const hinted = published.endpoints.filter(
    (endpoint) => endpoint.hintZones.length > 0
  );
  if (hinted.length === 0) return null;

  const zones = [...new Set(hinted.flatMap((endpoint) => endpoint.hintZones))];
  zones.sort();
  const reach = zones.map((zone) => {
    const count = hinted.filter((endpoint) =>
      endpoint.hintZones.includes(zone)
    ).length;
    return t("readings", "epZoneReach", {
      zone,
      n: count,
      total: published.endpoints.length,
    });
  });
  return t("readings", "epHintsOn", { reach: reach.join("; ") });
}

/**
 * Why one pod the selector matches is not published.
 *
 * The named-port case is derived from two things the app already holds — the
 * `targetPort` the Service asks for and the port names the containers declare
 * — and it is the only inference offered. Anything else says "Ready, and not
 * published" and stops there, because nothing else is written down.
 */
export function unpublishedNote(entry: UnpublishedPod, t: T): string {
  const facts = entry.pod.facts;
  const ready = facts?.kind === "pod" && facts.ready;
  const where = entry.inSlice
    ? t("readings", "epInSliceNoPort")
    : t("readings", "epInNoSlice");
  const head = ready
    ? t("readings", "epReadyAnd", { where })
    : t("readings", "epNotReadyNeverPublished", {
        state:
          facts?.kind === "pod"
            ? facts.display
            : t("readings", "epNotReadyWord"),
      });
  if (entry.unnamedPorts.length === 0) return head;
  const asked = entry.unnamedPorts
    .map((name) => t("readings", "epTargetPort", { name }))
    .join(", ");
  return `${head} — ${t("count", "portsMatchNothing", {
    n: entry.unnamedPorts.length,
    ports: asked,
  })}`;
}

/**
 * What the legacy `Endpoints` object is, next to the slices.
 *
 * The control plane still writes it, so the page stays — but it stops being
 * the source of truth. It is truncated at 1000 addresses and annotated
 * `endpoints.kubernetes.io/over-capacity` past that, and it cannot express
 * `serving` or `terminating` at all, so a draining address is simply absent
 * from it. A page silently showing 1000 of 1240, or 0 of 1, is not showing
 * the answer.
 */
export function legacyNote(
  listed: number,
  overCapacity: boolean,
  published: ServicePublished | undefined,
  t: T
): string {
  if (!published || published.source !== "slices") {
    return "This is the object the control plane writes for compatibility. It cannot express serving or terminating, and it stops at 1000 addresses — but no EndpointSlice answered here, so it is also all there is to read.";
  }
  const real = endpointCount(published) + published.unrouted;
  const from = t("count", "slicesRead", { n: published.slices });
  if (listed === real) {
    return t("readings", "epKeptForCompat", {
      addresses: t("count", "addressesAgree", { n: listed }),
      from,
    });
  }
  if (listed < real) {
    return t("readings", "epListsOf", {
      listed,
      real,
      from,
      why: overCapacity
        ? t("readings", "epOverCapacity")
        : t("readings", "epCannotExpress"),
    });
  }
  return t("readings", "epDisagree", { listed, real, from });
}

/** `10.42.1.51:8080`, or the bare address where the slice publishes no port. */
export function endpointAddress(endpoint: PublishedEndpoint): string {
  const port = endpoint.ports[0];
  return port === undefined ? endpoint.address : `${endpoint.address}:${port}`;
}
