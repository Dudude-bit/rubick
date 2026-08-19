/**
 * The hosts-first model: what this cluster serves, one row per attachment,
 * broken first.
 *
 * The reader's question is "what does this cluster serve, and why is my
 * host dead" — not "which of five kinds am I in". So the unit here is a
 * (route, parent) pair keyed by what it serves: its hostnames, or the
 * listener's port for the kinds that have none. Verdicts come from what
 * the controllers wrote, in their words; backends from what each Service's
 * own slices publish; and the one thing no condition will ever say — a
 * parentRef naming a Gateway the API server does not have — from lookup.
 */

import { backingOf, type BackingSources } from "@/integrations";
import { describeStop } from "@/lib/connections";
import type {
  GatewayClassInfo,
  GatewayInfo,
  ListenerInfo,
  RouteInfo,
} from "@/generated/types";

export interface HostBackend {
  name: string;
  namespace: string;
  port: number | null;
  weight: number | null;
  /** What the Service publishes — null while the backing lists are unread. */
  ready: number | null;
  draining: number;
  external: boolean;
  stopTitle: string | null;
}

export interface HostRow {
  key: string;
  /** The hostname(s), the raw port, or — with neither — the route's name. */
  address: string;
  kindTag: string;
  route: { kind: string; name: string; namespace: string };
  gateway: {
    name: string;
    namespace: string;
    exists: boolean;
    /** `:{sectionName}`, where the parentRef names one. */
    listener: string | null;
  } | null;
  backends: HostBackend[];
  /** A quiet line instead of backends: a redirect, a mesh note. */
  tail: string | null;
  stop: { title: string; fix: string | null } | null;
}

export interface GatewayHostsModel {
  broken: HostRow[];
  served: HostRow[];
  ports: HostRow[];
  quiet: HostRow[];
  /** Gateways whose class no controller accepted — configured and dead. */
  unclaimed: { name: string; namespace: string; className: string }[];
  /** The pulse line: every claimed gateway with its address. */
  gateways: {
    name: string;
    namespace: string;
    className: string;
    address: string | null;
  }[];
  counts: { served: number; broken: number };
}

function findGateway(
  gateways: GatewayInfo[],
  name: string,
  namespace: string
): GatewayInfo | undefined {
  return gateways.find((g) => g.name === name && g.namespace === namespace);
}

function listenerOf(
  gateway: GatewayInfo | undefined,
  sectionName: string | null
): ListenerInfo | undefined {
  if (!gateway || !sectionName) return undefined;
  return gateway.listeners.find((l) => l.name === sectionName);
}

function backendsOf(
  route: RouteInfo,
  backing: BackingSources | undefined
): HostBackend[] {
  return route.rules.flatMap((rule) =>
    rule.backendRefs.map((backend): HostBackend => {
      const namespace = backend.namespace ?? route.namespace;
      if (backend.kind !== "Service") {
        return {
          name: backend.name,
          namespace,
          port: backend.port,
          weight: backend.weight,
          ready: null,
          draining: 0,
          external: false,
          stopTitle: null,
        };
      }
      const state = backing
        ? backingOf(
            { name: backend.name, namespace },
            { kind: route.kind, name: route.name, namespace: route.namespace },
            backing
          )
        : null;
      return {
        name: backend.name,
        namespace,
        port: backend.port,
        weight: backend.weight,
        ready: state?.known ? state.ready : null,
        draining: state?.known ? state.draining : 0,
        external: state?.service?.type === "ExternalName",
        stopTitle:
          state?.known && state.stop ? describeStop(state.stop).title : null,
      };
    })
  );
}

/** The route's verdict for one Gateway parent, in the controller's words. */
function verdictOf(
  route: RouteInfo,
  gatewayName: string,
  gatewayNamespace: string,
  listener: ListenerInfo | undefined
): { title: string; fix: string | null } | null {
  const entries = route.parents.filter(
    (entry) =>
      entry.parent.name === gatewayName &&
      (entry.parent.namespace ?? route.namespace) === gatewayNamespace
  );
  for (const entry of entries) {
    const refused = entry.conditions.find(
      (c) => c.type === "Accepted" && c.status === "False"
    );
    if (refused) {
      const serves = listener
        ? ` The ${listener.name} listener serves ${listener.hostname ?? "all hosts"}.`
        : "";
      return {
        title: `${gatewayName} does not accept this route`,
        fix: `${refused.reason ?? "Refused"}${refused.message ? ` — ${refused.message}` : ""}.${serves}`,
      };
    }
    const unresolved = entry.conditions.find(
      (c) => c.type === "ResolvedRefs" && c.status === "False"
    );
    if (unresolved) {
      return {
        title:
          unresolved.reason === "RefNotPermitted"
            ? "A reference is not permitted — no ReferenceGrant allows it"
            : "A reference this route makes did not resolve",
        fix: unresolved.message
          ? `${unresolved.reason ?? "ResolvedRefs: False"} — ${unresolved.message}.`
          : null,
      };
    }
  }
  if (entries.length === 0) {
    return {
      title: "No controller wrote status for this route",
      fix: "Either nothing claims the Gateway's class, or the controller is not running. Nothing serves it.",
    };
  }
  return null;
}

export function gatewayHosts(
  routes: RouteInfo[],
  gateways: GatewayInfo[],
  classes: GatewayClassInfo[],
  backing: BackingSources | undefined
): GatewayHostsModel {
  const broken: HostRow[] = [];
  const served: HostRow[] = [];
  const ports: HostRow[] = [];
  const quiet: HostRow[] = [];

  for (const route of routes) {
    const base = {
      kindTag: route.kind,
      route: { kind: route.kind, name: route.name, namespace: route.namespace },
    };

    const gatewayParents = route.parentRefs.filter((p) => p.kind === "Gateway");
    const meshParents = route.parentRefs.filter((p) => p.kind !== "Gateway");

    if (gatewayParents.length === 0 && meshParents.length > 0) {
      quiet.push({
        ...base,
        key: `${route.kind}/${route.namespace}/${route.name}/mesh`,
        address: route.name,
        gateway: null,
        backends: [],
        tail: "attaches to a Service, not a Gateway — mesh routing, which this app does not interpret",
        stop: null,
      });
      continue;
    }

    for (const parent of gatewayParents) {
      const gatewayNamespace = parent.namespace ?? route.namespace;
      const found = findGateway(gateways, parent.name, gatewayNamespace);
      const listener = listenerOf(found, parent.sectionName);

      const backends = backendsOf(route, backing);
      const redirectOnly =
        backends.length === 0 && route.rules.some((rule) => rule.hasRedirect);

      const stop = !found
        ? {
            title: "Names a Gateway that does not exist",
            fix: "No controller will ever write status for that parent — this is the refusal the cluster cannot say itself.",
          }
        : verdictOf(route, parent.name, gatewayNamespace, listener);
      const backendStop = backends.find((b) => b.stopTitle !== null);

      const row: HostRow = {
        ...base,
        key: `${route.kind}/${route.namespace}/${route.name}/${gatewayNamespace}/${parent.name}/${parent.sectionName ?? ""}`,
        address:
          route.hostnames.length > 0
            ? route.hostnames.join(", ")
            : listener &&
                (listener.protocol === "TCP" || listener.protocol === "UDP")
              ? `:${listener.port} / ${listener.protocol}`
              : route.name,
        gateway: {
          name: parent.name,
          namespace: gatewayNamespace,
          exists: !!found,
          listener: parent.sectionName ? `:${parent.sectionName}` : null,
        },
        backends,
        tail: redirectOnly ? "redirects — no backend, and none needed" : null,
        stop:
          stop ??
          (backendStop
            ? { title: backendStop.stopTitle ?? "", fix: null }
            : null),
      };

      if (row.stop) broken.push(row);
      else if (
        route.hostnames.length === 0 &&
        listener &&
        (listener.protocol === "TCP" || listener.protocol === "UDP")
      )
        ports.push(row);
      else served.push(row);
    }
  }

  const byAddress = (a: HostRow, b: HostRow) =>
    a.address.localeCompare(b.address);
  broken.sort(byAddress);
  served.sort(byAddress);
  ports.sort(byAddress);

  const accepted = new Map(classes.map((c) => [c.name, c.accepted]));
  const unclaimed = gateways
    .filter((g) => accepted.get(g.className) !== true)
    .map((g) => ({
      name: g.name,
      namespace: g.namespace,
      className: g.className,
    }));
  const claimed = gateways
    .filter((g) => accepted.get(g.className) === true)
    .map((g) => ({
      name: g.name,
      namespace: g.namespace,
      className: g.className,
      address: g.addresses[0] ?? null,
    }));

  return {
    broken,
    served,
    ports,
    quiet,
    unclaimed,
    gateways: claimed,
    counts: { served: served.length + ports.length, broken: broken.length },
  };
}
