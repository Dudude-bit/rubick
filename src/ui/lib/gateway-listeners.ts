import type { ListenerInfo, ObjectName } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { conditionSaid, failingCondition } from "@/lib/condition-health";

/** What a parentRef says about the listeners it means. */
export interface ListenerPick {
  /** The `ListenerSet` it named, where it named one rather than the Gateway. */
  set: ObjectName | null;
  sectionName: string | null;
  port: number | null;
}

/** The listeners a parentRef points at: one by section, those on a port, or all. */
export function pickListeners(
  listeners: ListenerInfo[],
  pick: ListenerPick
): ListenerInfo[] {
  // A route that named a ListenerSet reaches only that set's listeners. The
  // Gateway's own and every other set's are merged into the same array, so
  // without this a route through one team's set is checked against another
  // team's, and a sectionName that means nothing to it can match.
  const { set } = pick;
  const mine = set
    ? listeners.filter(
        (l) =>
          l.fromListenerSet?.name === set.name &&
          l.fromListenerSet.namespace === set.namespace
      )
    : listeners;
  if (pick.sectionName) {
    return mine.filter((l) => l.name === pick.sectionName);
  }
  if (pick.port != null) {
    return mine.filter((l) => l.port === pick.port);
  }
  return mine;
}

const SCHEME: Partial<Record<string, "http" | "https">> = {
  HTTP: "http",
  HTTPS: "https",
};
const DEFAULT_PORT = { http: 80, https: 443 };

const covers = (pattern: string, name: string) =>
  pattern.startsWith("*.") ? name.endsWith(pattern.slice(1)) : pattern === name;

/** The names a listener answers this route on; a wildcard is no name to paste. */
function hostsOn(listener: ListenerInfo, hostnames: string[]): string[] {
  const own = listener.hostname;
  const concrete = own !== null && !own.startsWith("*") ? own : null;
  if (hostnames.length === 0) return concrete ? [concrete] : [];
  return hostnames.flatMap((name) => {
    if (!name.startsWith("*")) return !own || covers(own, name) ? [name] : [];
    return concrete && covers(name, concrete) ? [concrete] : [];
  });
}

/** The addresses an HTTPRoute hands out on these listeners, the way an Ingress rule's are written. */
export function routeUrlsOn(
  route: { kind: string; hostnames: string[]; paths: string[] },
  listeners: ListenerInfo[]
): string[] {
  if (route.kind !== "HTTPRoute") return [];
  return [
    ...new Set(
      listeners.flatMap((listener) => {
        const scheme = SCHEME[listener.protocol];
        if (!scheme) return [];
        const port =
          listener.port === DEFAULT_PORT[scheme] ? "" : `:${listener.port}`;
        return hostsOn(listener, route.hostnames).flatMap((host) =>
          route.paths.map((path) => `${scheme}://${host}${port}${path}`)
        );
      })
    ),
  ];
}

/** Each listener its controller refused, and what it said about it. */
export function listenerRefusals(listeners: ListenerInfo[], t: T): string[] {
  return listeners.flatMap((listener) => {
    const failing = failingCondition(listener.conditions);
    return failing
      ? [
          t("empty", "gwListenerRefusedSaid", {
            name: listener.name,
            said: conditionSaid(failing),
          }),
        ]
      : [];
  });
}
