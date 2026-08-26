/**
 * Reaching an in-cluster Prometheus or Loki without asking anybody to run
 * `kubectl port-forward` in another window.
 *
 * The observation this exists for is the reader's own: *we are typing an
 * address anyway.* A configured integration needs to know **which** server,
 * and a Service in this cluster names one exactly as well as a URL does —
 * better, because the app can already reach it. What it could not do was tell
 * the reader that the obvious address, the one its own placeholder suggested,
 * is resolvable only from inside the cluster.
 *
 * So the address can be produced rather than typed: pick the Service, the app
 * forwards a local port to it and the connection points at `localhost`.
 *
 * ## The thing that breaks the naive version
 *
 * `port_forward_pod` forwards to a **pod**, by name, and `autoReconnect`
 * retries *that pod* with a backoff — it does not go and find another one.
 * So the first rollout, node drain or OOM kill leaves the forward retrying a
 * pod that no longer exists, for ever, behind a `localhost` URL that used to
 * work. Every chart in the app would go quietly empty, which is the exact
 * failure this codebase keeps refusing to ship.
 *
 * The pod is therefore resolved from the Service **every time the forward is
 * established**, and re-resolved when the connection stops answering. The
 * durable thing is the Service; the pod is a detail that is looked up again.
 */

import { SaidError, type Saying } from "@/i18n/say";
import { commands } from "@/lib/commands";
import type { ServiceInfo } from "@/generated/types";

/** Where a forwarded connection actually points. */
export interface Forwarded {
  namespace: string;
  service: string;
  /** The Service port being forwarded, which is what the reader chose. */
  remotePort: number;
  localPort: number;
  /** The pod it resolved to this time. Never durable — see the module note. */
  pod: string;
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
 * A pod currently behind this Service.
 *
 * Read through the Service's own selector rather than through its
 * EndpointSlices, because the answer wanted here is "somewhere to forward to"
 * and a pod that is Running but not yet Ready still answers a query — while
 * an endpoint list that has not caught up yet would say there is nowhere to
 * go on a cluster that is merely mid-rollout.
 */
export async function podFor(service: ServiceInfo): Promise<string | null> {
  const selector = Object.entries(service.selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  // A Service with no selector has hand-managed endpoints and names no pods.
  if (selector === "") return null;

  const pods = await commands.listPods({
    namespace: service.namespace,
    labelSelector: selector,
    fieldSelector: null,
    limit: null,
    statusFilter: null,
    selector: null,
    nodeName: null,
  });

  // Ready first, then merely running: a rollout should move the forward onto
  // the new pod rather than refusing to make one.
  const running = pods.filter((pod) => pod.status.phase === "Running");
  const ready = running.find((pod) => pod.status.ready);
  return (ready ?? running[0])?.name ?? null;
}

/**
 * Point a local port at this Service, and say where.
 *
 * `autoReconnect` is on because it costs nothing and covers the blips; it is
 * explicitly *not* the answer to a pod that has gone for good, which is what
 * {@link reestablish} is for.
 */
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

export async function forward(
  service: ServiceInfo,
  preferredPorts: number[],
  /**
   * A local port to keep if it can be kept — the one a saved connection's
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
      `${service.name} exposes ${service.ports.length} ports and none of them is one this app recognises — forward it by hand and give the address instead.`
    );
  }

  const pod = await podFor(service);
  if (pod === null) {
    throw new SaidError(
      {
        key: "forwardNoPod",
        values: { where: `${service.namespace}/${service.name}` },
      },
      `No running pod is behind ${service.namespace}/${service.name}, so there is nothing to forward to.`
    );
  }

  const open = async (localPort: number) => {
    await commands.portForwardPod(pod, service.namespace, {
      localPort,
      remotePort,
      autoReconnect: true,
    });
    return localPort;
  };

  // The kernel is the authority on whether a port is free: `portsInUse` knows
  // what *this app* is forwarding and nothing about the rest of the machine,
  // so the wanted port is tried and the fallback is chosen only if it fails.
  let localPort: number;
  if (keepLocal !== undefined) {
    localPort = await open(keepLocal).catch(async () =>
      open(freePort(new Set([...(await portsInUse()), keepLocal])))
    );
  } else {
    localPort = await open(freePort(await portsInUse()));
  }

  return {
    namespace: service.namespace,
    service: service.name,
    remotePort,
    localPort,
    pod,
    subpath: normalisedSubpath(subpath),
    url: `http://localhost:${localPort}${normalisedSubpath(subpath)}`,
  };
}

/**
 * Put the forward back on a pod that exists, keeping the local port.
 *
 * The local port is what the saved connection's URL is made of, so it must
 * survive: the reader's address stays true and only the far end moves. Called
 * when the connection stops answering, which on a forwarded one nearly always
 * means the pod it was pinned to is gone.
 */
export async function reestablish(
  found: Forwarded,
  service: ServiceInfo
): Promise<Forwarded> {
  const sessions = await commands.listPortForwards().catch(() => []);
  for (const session of sessions) {
    if (session.localPort === found.localPort) {
      await commands.stopPortForward(session.id).catch(() => undefined);
    }
  }

  const pod = await podFor(service);
  if (pod === null) {
    throw new SaidError(
      {
        key: "forwardNoPodAnyMore",
        values: { where: `${found.namespace}/${found.service}` },
      },
      `No running pod is behind ${found.namespace}/${found.service} any more.`
    );
  }

  await commands.portForwardPod(pod, found.namespace, {
    localPort: found.localPort,
    remotePort: found.remotePort,
    autoReconnect: true,
  });

  return { ...found, pod };
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
