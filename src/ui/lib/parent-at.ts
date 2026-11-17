import type {
  GatewayInfo,
  ListenerSetInfo,
  ObjectName,
  ObjectRef,
} from "@/generated/types";
import type { T } from "@/i18n/useT";

/**
 * Where a route's parentRef leads, as the Connections chain resolves it too
 * (`parent_at` in Rust, held to this by `parent-resolution-conformance.json`).
 * `via` is the `ListenerSet` the route went through, where that set is there.
 */
export type ParentAt =
  | { state: "found"; gateway: GatewayInfo; via: ObjectName | null }
  | ParentGap;

/** A parent no Gateway carries: missing where its list was read, else unread. */
export interface ParentGap {
  state: "missing" | "unread";
  kind: "Gateway" | "ListenerSet";
  name: string;
  namespace: string;
  via: ObjectName | null;
}

/**
 * A Gateway parent is found by name. A `ListenerSet` parent is found through
 * the Gateway that keeps it, or else through the set, whose own parentRef
 * names its Gateway: a set that is there leads to that Gateway, and that is
 * the one missing; a set that is not there is named itself. `null` is a list
 * not read, and nothing in it is called missing.
 */
export function parentAt(
  parent: { kind: string; name: string; namespace: string | null },
  routeNamespace: string,
  gateways: GatewayInfo[] | null,
  sets: ListenerSetInfo[] | null
): ParentAt {
  const at = parent.namespace ?? routeNamespace;
  const named = (name: string, namespace: string) =>
    gateways?.find(
      (gateway) => gateway.name === name && gateway.namespace === namespace
    );
  const gap = (
    kind: ParentGap["kind"],
    name: string,
    namespace: string,
    read: boolean,
    via: ObjectName | null = null
  ): ParentGap => ({
    state: read ? "missing" : "unread",
    kind,
    name,
    namespace,
    via,
  });
  if (parent.kind !== "ListenerSet") {
    const gateway = named(parent.name, at);
    return gateway
      ? { state: "found", gateway, via: null }
      : gap("Gateway", parent.name, at, gateways !== null);
  }
  const via = { name: parent.name, namespace: at };
  const kept = gateways?.find((gateway) =>
    gateway.listenerSets.some(
      (set) => set.name === via.name && set.namespace === via.namespace
    )
  );
  if (kept) return { state: "found", gateway: kept, via };
  if (sets === null) return gap("ListenerSet", parent.name, at, false);
  const set = sets.find(
    (each) => each.name === via.name && each.namespace === via.namespace
  );
  if (!set) return gap("ListenerSet", parent.name, at, true);
  const gateway = named(set.gatewayName, set.gatewayNamespace);
  return gateway
    ? { state: "found", gateway, via }
    : gap(
        "Gateway",
        set.gatewayName,
        set.gatewayNamespace,
        gateways !== null,
        via
      );
}

/** The parent a chain's `gatewayMissing` stop names: one that is not there. */
export function stopParent(stop: {
  gateway: ObjectRef;
  listenerSet: ObjectName | null;
}): ParentGap {
  return {
    state: "missing",
    kind: stop.gateway.kind === "ListenerSet" ? "ListenerSet" : "Gateway",
    name: stop.gateway.name,
    namespace: stop.gateway.namespace ?? "",
    via: stop.listenerSet,
  };
}

export interface ParentWords {
  say: string;
  /** The break at list length. */
  short: string;
  /** The break in the one word a door line carries. */
  word: string;
  detail?: { title: string; body: string };
}

/**
 * A parent no Gateway carries, in the words the Routes trace, the
 * Connections chain, the map and the peek all say it in. `said` is the
 * cluster's refusal of the list that would have held it.
 */
export function parentWords(
  gap: ParentGap,
  t: T,
  said: string | null = null
): ParentWords {
  const { name, namespace, via } = gap;
  if (gap.state === "unread") {
    if (gap.kind === "ListenerSet") {
      const say = t("empty", "gwSetsUnreadSay", { name });
      return {
        say,
        short: say,
        word: t("nav", "notChecked"),
        detail: {
          title: t("empty", "gwSetsUnreadTitle"),
          body: said
            ? `${t("empty", "gwSetsUnreadBody")} ${t("empty", "gwClusterSaid", { said })}`
            : t("empty", "gwSetsUnreadBody"),
        },
      };
    }
    const say = t("empty", "gwGatewayBlind", { name });
    return { say, short: say, word: t("nav", "notChecked") };
  }
  if (gap.kind === "ListenerSet") {
    return {
      say: t("empty", "gwSetMissingSay", { name, namespace }),
      short: t("empty", "gwGatewayMissingShort", { name }),
      word: t("empty", "gwSetMissingWord"),
      detail: {
        title: t("empty", "gwSetMissingTitle"),
        body: t("empty", "gwSetMissingBody"),
      },
    };
  }
  if (via) {
    return {
      say: t("empty", "gwSetGatewayMissingSay", {
        set: via.name,
        name,
        namespace,
      }),
      short: t("empty", "gwGatewayMissingShort", { name }),
      word: t("empty", "gwGatewayMissingWord"),
      detail: {
        title: t("empty", "gwSetGatewayMissingTitle"),
        body: t("empty", "gwSetGatewayMissingBody"),
      },
    };
  }
  return {
    say: t("empty", "gwGatewayMissingSay", { name, namespace }),
    short: t("empty", "gwGatewayMissingShort", { name }),
    word: t("empty", "gwGatewayMissingWord"),
    detail: {
      title: t("empty", "gwGatewayMissingTitle"),
      body: t("empty", "gwGatewayMissingBody"),
    },
  };
}
