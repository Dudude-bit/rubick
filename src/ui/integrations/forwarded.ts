/**
 * Reaching an in-cluster Prometheus or Loki without asking anybody to run
 * `kubectl port-forward` in another window. A configured integration needs to
 * know **which** server, and a Service names one better than a URL does: the
 * app can already reach it, while the address the placeholder suggests
 * resolves only from inside the cluster. So the address is produced rather
 * than typed: pick the Service, the app forwards a local port to it and the
 * connection points at `localhost`.
 *
 * The forward goes through `port_forward_service`, which picks a ready pod,
 * lands on its `targetPort` (a number or a container port's name) the way
 * kube-proxy does, and moves to the next pod when a rollout replaces it.
 */

import { SaidError, type Saying } from "@/i18n/say";
import { commands } from "@/lib/commands";
import { ERROR_CODES, errorCode } from "@/lib/error-utils";
import type { PortForwardSessionInfo, ServiceInfo } from "@/generated/types";

/** Where a forwarded connection actually points. */
export interface Forwarded {
  namespace: string;
  service: string;
  /** The Service port being forwarded, which is what the reader chose. */
  remotePort: number;
  localPort: number;
  /** Empty for an API at the root — see {@link normalisedSubpath}. */
  subpath: string;
  url: string;
}

/**
 * A local port nothing on this machine is listening on.
 *
 * Above the ephemeral range so the kernel does not hand the same number to an
 * outgoing connection later, and re-checked rather than remembered: a port
 * free when a connection was saved is not free when the app restarts three
 * days later, and this is a shared machine.
 */
const PORT_FLOOR = 20000;
const PORT_CEILING = 32000;

export function freePort(taken: ReadonlySet<number>): number {
  for (let port = PORT_FLOOR; port <= PORT_CEILING; port += 1) {
    if (!taken.has(port)) return port;
  }
  throw new SaidError(
    {
      key: "forwardNoFreePort",
      values: { from: PORT_FLOOR, to: PORT_CEILING },
    },
    `Every local port between ${PORT_FLOOR} and ${PORT_CEILING} is already forwarding something.`
  );
}

/** The ports this app is already forwarding, so a new one does not collide. */
export async function portsInUse(): Promise<Set<number>> {
  const sessions = await commands.listPortForwards().catch(() => []);
  const configs = await commands.listPortForwardConfigs().catch(() => []);
  return new Set([
    ...sessions.map((session) => session.localPort),
    ...configs.map((config) => config.localPort),
  ]);
}

/**
 * Which port of this Service to forward.
 *
 * The vendor's own default first — a Prometheus is on 9090 and a Loki on 3100
 * whatever else the Service exposes — then a port named for the vendor, then
 * whatever single port it has. A Service with several unnamed ports and no
 * default match is not guessed at.
 */
export function portOf(
  service: ServiceInfo,
  preferred: number[]
): number | null {
  const numbers = service.ports.map((port) => port.port);
  for (const want of preferred) {
    if (numbers.includes(want)) return want;
  }
  const named = service.ports.find((port) =>
    ["http", "web", "http-metrics", "api"].includes(port.name ?? "")
  );
  if (named) return named.port;
  return numbers.length === 1 ? numbers[0] : null;
}

/**
 * The part of the address after the port, when the API does not sit at the root.
 *
 * Prometheus answers `/api/v1/query` straight off the host; VictoriaMetrics
 * does not — VMSingle serves the same API under `/prometheus`, and a
 * VMCluster's vmselect under `/select/<tenant>/prometheus`. The app cannot
 * work out which from the Service, so it is asked for and carried with the
 * forward, and everything downstream concatenates as it always did.
 */
export function normalisedSubpath(subpath: string | undefined): string {
  const trimmed = (subpath ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Point a local port at this Service, and say where. */
export async function forward(
  service: ServiceInfo,
  preferredPorts: number[],
  /**
   * A local port to keep if it can be kept, the one a saved connection's
   * address is already made of. Taken, a free one is chosen instead and the
   * caller is expected to move the address with it.
   */
  keepLocal?: number,
  subpath?: string
): Promise<Forwarded> {
  const remotePort = portOf(service, preferredPorts);
  if (remotePort === null) {
    throw new SaidError(
      {
        key: "forwardNoKnownPort",
        values: { name: service.name, n: service.ports.length },
      },
      `${service.name} exposes ${service.ports.length} ports and none of them is one this app recognises. Forward it by hand and give the address instead.`
    );
  }

  const open = (localPort: number) =>
    openForward(service, localPort, remotePort);

  // The kernel is the authority on whether a port is free: `portsInUse` knows
  // what *this app* is forwarding and nothing about the rest of the machine,
  // so the wanted port is tried and the fallback is chosen only if it fails.
  const session =
    keepLocal === undefined
      ? await open(freePort(await portsInUse()))
      : await open(keepLocal).catch(async (failure) => {
          if (failure instanceof SaidError) throw failure;
          return open(freePort(new Set([...(await portsInUse()), keepLocal])));
        });

  return {
    namespace: service.namespace,
    service: service.name,
    remotePort,
    localPort: session.localPort,
    subpath: normalisedSubpath(subpath),
    url: `http://localhost:${session.localPort}${normalisedSubpath(subpath)}`,
  };
}

/** A forward says nothing, and takes no connection, until it is subscribed to. */
async function openForward(
  service: ServiceInfo,
  localPort: number,
  remotePort: number
): Promise<PortForwardSessionInfo> {
  const session = await commands
    .portForwardService(service.name, service.namespace, {
      localPort,
      remotePort,
      autoReconnect: true,
    })
    .catch((failure: unknown) => {
      if (errorCode(failure) !== ERROR_CODES.NO_READY_POD) throw failure;
      const where = `${service.namespace}/${service.name}`;
      throw new SaidError(
        { key: "forwardNoPod", values: { where } },
        `No ready pod is behind ${where}, so there is nothing to forward to.`
      );
    });
  await commands.portForwardSubscribed(session.id);
  return session;
}

/** What a vendor knows about how its own Service is usually labelled. */
export interface InClusterHint {
  /** `app.kubernetes.io/name` values its charts use. */
  names: string[];
  /** Ports to prefer, most canonical first. */
  ports: number[];
  /**
   * Substrings of a Service name that mark the component queries go to, best
   * first. Ranked above an unmarked Service of the same vendor; nothing here
   * is required, and a chart that names its Service plainly is matched by
   * {@link names} alone.
   */
  prefer?: string[];
  /**
   * Substrings of a Service name that mark a component which answers HTTP and
   * cannot answer a query — Loki's write path, Prometheus's node exporter.
   *
   * **Excluded, not de-ranked.** A chart rarely installs one Service: Loki's
   * puts up a gateway, a read path, a write path, an ingester and a
   * compactor, all labelled `loki` and all answering HTTP. Offering the write
   * path as somewhere to query from is offering a connection that
   * establishes and then answers nothing, which is the exact failure this
   * feature exists to stop somebody hitting.
   */
  avoid?: string[];
  /**
   * What a subpath looks like for this vendor, shown as the field's
   * placeholder. Prometheus itself needs none; the things that speak its API
   * do, and the example is the fastest way to say which shape is wanted.
   */
  subpathExample?: string;
}

export interface Candidate {
  service: ServiceInfo;
  port: number;
  /**
   * Why it is in the list, for a reader deciding between two of them. Named
   * rather than written: the list is built in a query.
   */
  because: Saying;
}

/**
 * Services in this cluster that look like this vendor's.
 *
 * Ranked and never filtered down to one: two Prometheuses is an ordinary
 * cluster — the one the operator runs and the one somebody's chart brought —
 * and picking for the reader would be this app guessing which of their
 * monitoring stacks they meant. The label is stronger evidence than the name
 * and is said so in the row.
 */
export async function candidates(hint: InClusterHint): Promise<Candidate[]> {
  const services = await commands.listServices(null);
  const wanted = new Set(hint.names);

  return services
    .flatMap((service): Array<Candidate & { rank: number }> => {
      const lower = service.name.toLowerCase();
      const labelled =
        wanted.has(service.labels["app.kubernetes.io/name"] ?? "") ||
        wanted.has(service.labels["app"] ?? "");
      const named = hint.names.some((name) => lower.includes(name));
      if (!labelled && !named) return [];

      // A component that answers HTTP and cannot answer a query is not a
      // candidate at all — see `avoid`.
      if (hint.avoid?.some((part) => lower.includes(part))) return [];

      const port = portOf(service, hint.ports);
      // A match this app cannot forward is not offered either: the reader
      // would press it and get a sentence about ports, not a connection.
      if (port === null) return [];

      // A name-substring alone is weak evidence — kube-prometheus-stack
      // names the control plane's scrape targets after the vendor too, and
      // every one answers /metrics and cannot answer a query. Weak evidence
      // must carry the vendor's own port; a label is the chart's word and
      // may sit on any port it likes.
      if (!labelled && !hint.ports.includes(port)) return [];

      const prefers =
        hint.prefer?.findIndex((part) => lower.includes(part)) ?? -1;

      return [
        {
          service,
          port,
          rank: prefers >= 0 ? prefers : (hint.prefer?.length ?? 0),
          because:
            prefers >= 0
              ? {
                  key: "forwardByComponent" as const,
                  values: { part: hint.prefer![prefers] },
                }
              : labelled
                ? {
                    key: "forwardByLabel" as const,
                    values: {
                      label:
                        service.labels["app.kubernetes.io/name"] ??
                        service.labels["app"],
                    },
                  }
                : { key: "forwardByName" as const },
        },
      ];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.service.namespace.localeCompare(right.service.namespace) ||
        left.service.name.localeCompare(right.service.name)
    )
    .map(({ service, port, because }) => ({ service, port, because }));
}
