/**
 * The reader's questions, built from the cluster's verbs.
 *
 * `get_resource_connections` returns typed edges — six verbs and nothing
 * inferred — deliberately, so the backend never has to guess how a page wants
 * to read them. That leaves the grouping here, in one place: "Related
 * resources: ConfigMap, Secret, PVC, Node" is a pile, and *what does this need
 * to run* is a question. Ten pages asking the same question want one answer,
 * not ten spellings of it.
 *
 * Nothing here re-derives a fact. `Usage` already carries how a volume is
 * mounted and which key an environment variable reads; this only puts those
 * into a sentence.
 */

import { covers } from "./certificates";
import { formatKubernetesBytes } from "./k8s-quantity";
import { isScalable } from "./resource-registry";
import { groupMounts } from "./mounts";
import { gitRevisionLink, type Delivery, type GitLink } from "@/integrations";
import { delivered } from "./delivery";
import {
  autoscalerRange,
  autoscalerReplicas,
  budgetRoom,
  budgetRule,
} from "./governance";
import {
  endpointAddress,
  endpointCount,
  publishedFor,
  sourceMark,
} from "./published";
import type {
  ChainStop,
  ConnectionEdge,
  ObjectFacts,
  ObjectRef,
  Relation,
  IngressClassBinding,
  ResourceConnections,
  ServicePublished,
  TlsCertificate,
  Usage,
} from "@/generated/types";

function sameObject(a: ObjectRef, b: ObjectRef): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    (a.namespace ?? null) === (b.namespace ?? null)
  );
}

const refKey = (ref: ObjectRef) =>
  `${ref.kind}/${ref.namespace ?? "-"}/${ref.name}`;

function unique(refs: ObjectRef[]): ObjectRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "a, and b" for two; "a, b, and c" past that — the mock's rhythm. */
function sentence(parts: string[]): string {
  const kept = [...new Set(parts.filter(Boolean))];
  if (kept.length <= 1) return kept[0] ?? "";
  return `${kept.slice(0, -1).join(", ")}, and ${kept[kept.length - 1]}`;
}

const join = (...parts: (string | null | undefined | false)[]) =>
  parts.filter(Boolean).join(" · ");

// --- what the cluster said, in words ------------------------------------

/**
 * One way an object is drawn on. Every field here came from the backend.
 *
 * `containers` is the containers this one line covers — several, where a
 * mount was grouped — and null where naming them would be noise.
 */
function describeUsage(usage: Usage, containers: string[] | null): string {
  // Leading rather than trailing: on their own lines these read as a column
  // of containers, and "mounted at /etc/app in app" invites the path to be
  // read as part of the sentence.
  const inside = (text: string) =>
    containers && containers.length > 0
      ? `${containers.join(", ")} · ${text}`
      : text;
  switch (usage.how) {
    case "mount": {
      const where = usage.projected
        ? `projected into ${usage.path}`
        : `mounted at ${usage.path}`;
      const from = usage.subPath ? ` from ${usage.subPath}` : "";
      return inside(`${where}${from}${usage.readOnly ? ", read-only" : ""}`);
    }
    case "unmounted":
      return `in volume ${usage.volume}, which no container mounts`;
    case "env":
      return inside(`${usage.name} reads ${usage.key}`);
    case "envFrom":
      return inside("every key becomes an environment variable");
    case "imagePullSecret":
      return "used to pull the images";
    case "identity":
      return "the identity it runs as";
    case "ingressTls":
      return usage.hosts.length > 0
        ? `serves TLS for ${usage.hosts.join(", ")}`
        : "serves TLS for every host on this Ingress";
  }
}

/**
 * Every way one object draws on another.
 *
 * Mounts are grouped before they are worded, so two containers mounting one
 * volume at one path are one line naming both rather than the same path
 * printed twice. Two mounts that genuinely differ — the same path, one of
 * them read-only — stay two lines, because the difference is the finding.
 *
 * Two ways read as a sentence — "mounted at /etc/app, and APP_MESSAGE reads
 * app.conf" — and the row stays one line. Past that a sentence stops being
 * one: a ConfigMap that a pod mounts twice, reads a key from and imports
 * wholesale is five clauses nobody finishes, so each way becomes its own
 * line. Containers are named where they tell two lines apart, and nowhere
 * else: one line covering three containers is not ambiguous, and the roster
 * on it would be read on every pod page in the app for no answer.
 *
 * No "all containers" here, unlike the pod's Volumes block. That summary is
 * a claim about a denominator — the pod's whole container list — which the
 * edge does not carry, and which a ConfigMap page listing four pods that use
 * it could not know for any of them.
 */
export function describeUsages(usages: Usage[]): string[] {
  const groups = groupMounts(usages.filter((use) => use.how === "mount"));
  const rest = usages.filter((use) => use.how !== "mount");
  const drawnBy = new Set(
    usages.flatMap((use) => ("container" in use ? [use.container] : []))
  );

  const say = (containers: boolean) => [
    ...new Set([
      ...groups.map((group) =>
        describeUsage(group.mount, containers ? group.containers : null)
      ),
      ...rest.map((use) =>
        describeUsage(
          use,
          containers && "container" in use ? [use.container] : null
        )
      ),
    ]),
  ];

  const ways = say(false);
  if (ways.length > 2 || (ways.length > 1 && drawnBy.size > 1))
    return say(true);
  return [sentence(ways)].filter(Boolean);
}

/** What the far end knows about itself, where it is worth a line. */
function describeFacts(facts: ObjectFacts | null): string | null {
  if (!facts) return null;
  switch (facts.kind) {
    case "claim":
      return join(facts.capacity, facts.storageClass, facts.phase);
    case "pod":
      return facts.display;
    case "workload":
      return facts.revision === null
        ? `${facts.readyReplicas}/${facts.replicas} ready`
        : join(
            `revision ${facts.revision}${facts.current ? ", current" : ""}`,
            `${facts.replicas} ${facts.replicas === 1 ? "pod" : "pods"}`
          );
    case "service":
      return serviceVia(facts);
    case "ingress":
      return facts.className;
    case "gateway":
      return facts.className;
    case "autoscaler":
      return join(autoscalerRange(facts), autoscalerReplicas(facts));
    case "budget":
      return join(budgetRule(facts), budgetRoom(facts));
    case "node":
      return nodeCapacity(facts);
  }
}

/**
 * What the scheduler may still hand out here, and whether it is allowed to.
 *
 * Allocatable, not capacity: capacity is what the machine has and allocatable
 * is what is left once the kubelet has reserved its own, and a pod is placed
 * against the second. Cordoned is last because it is the one that changes what
 * the rest of the line means — the room is there and nothing may take it.
 */
function nodeCapacity(facts: Extract<ObjectFacts, { kind: "node" }>): string {
  return join(
    facts.cpu && `${facts.cpu} CPU`,
    facts.memory && formatKubernetesBytes(facts.memory),
    !facts.schedulable && "cordoned"
  );
}

function serviceVia(facts: Extract<ObjectFacts, { kind: "service" }>): string {
  const address =
    facts.externalName !== null
      ? `ExternalName → ${facts.externalName}`
      : join(facts.type, facts.clusterIp);
  return join(
    address,
    facts.selector ? `selects ${facts.selector}` : "no selector"
  );
}

function servicePorts(ref: ObjectRef): string | null {
  const facts = ref.facts;
  if (facts?.kind !== "service" || facts.ports.length === 0) return null;
  return facts.ports
    .map((port) =>
      String(port.port) === port.targetPort
        ? `:${port.port}`
        : `:${port.port} → ${port.targetPort}`
    )
    .join(" · ");
}

/**
 * What was left unverified, and never silently.
 *
 * `notChecked` is the whole reason `Existence` is three-valued: a ConfigMap
 * named by a pod spec was read off that spec, not looked up, so a typo'd name
 * and a real one arrive here looking identical. Saying so is cheap; implying
 * the app checked is not.
 */
export function describeExistence(
  ref: ObjectRef,
  verifiable = true
): string | null {
  if (ref.existence === "missing") return "does not exist in this namespace";
  if (ref.existence === "notChecked" && verifiable) return "not checked";
  return null;
}

// --- where the path stops ----------------------------------------------

/**
 * The four ways a path stops, each a different repair.
 *
 * `publishesNothing` is the sharpest: a healthy selector, healthy pods, a
 * green everything and no traffic at all, because the Service asks for a port
 * name no container declares. It is invisible to every deduction — including
 * the one this chain used to make — since the pods really are Ready and it is
 * the endpoint controller that skipped them.
 */
export function describeStop(stop: ChainStop): { title: string; note: string } {
  switch (stop.reason) {
    case "publishesNothing": {
      const matched =
        stop.pods === 1
          ? "1 pod matches its selector and it is Ready"
          : stop.readyPods === stop.pods
            ? `${stop.pods} pods match its selector and all of them are Ready`
            : `${stop.pods} pods match its selector and ${stop.readyPods} of them are Ready`;
      if (stop.unnamedPorts.length === 0) {
        return {
          title: "This Service publishes no endpoint",
          note: `${matched}, and not one of them is in anything this Service publishes. Why is not something these objects state — a pod is written into a slice a moment after it turns Ready, and never at all while the endpoint controller is not running.`,
        };
      }
      const asked = stop.unnamedPorts
        .map((name) => `targetPort: ${name}`)
        .join(", ");
      return {
        title: "This Service publishes no endpoint",
        note: `${matched}, but it asks for ${asked} and no container declares a port by that name, so the endpoint controller skips every one of them. Nothing reaches them. Name the port in the container, or give the Service the number.`,
      };
    }
    case "backendMissing":
      return {
        title: `No Service named ${stop.service.name} in this namespace`,
        note: "The Ingress routes this path to a backend that was never created, so the controller has nothing to send the request to. The rule above is fine; the name in it is the fault.",
      };
    case "selectsNothing":
      return {
        title: `No pod carries ${stop.selector}`,
        note: "Anything that reaches this address gets a connection refused. The Service exists and is wired up; there is simply nothing behind it.",
      };
    case "noneReady":
      return {
        title:
          stop.pods === 1
            ? `1 pod carries ${stop.selector}, and it is not ready`
            : `${stop.pods} pods carry ${stop.selector}, and none of them is ready`,
        note: "A Service publishes no endpoint for a pod that fails its readiness probe, so traffic is refused while the pods sit there running — which is why every list page in the app draws this as healthy. The slices say the same: every address behind this Service is in them, and not one is serving.",
      };
    case "routeNotAccepted":
      return {
        title: `${stop.gateway.name} does not accept this route`,
        note:
          `The controller answered Accepted: False` +
          (stop.conditionReason ? ` — ${stop.conditionReason}` : "") +
          (stop.message ? `: ${stop.message}` : ".") +
          " The route's YAML is valid and nothing serves it — an unaccepted route is simply never programmed.",
      };
    case "routeRefsUnresolved":
      return {
        title:
          stop.conditionReason === "RefNotPermitted"
            ? "A reference this route makes is not permitted — no ReferenceGrant allows it"
            : "A reference this route makes did not resolve",
        note:
          `The controller answered ResolvedRefs: False` +
          (stop.conditionReason ? ` — ${stop.conditionReason}` : "") +
          (stop.message ? `: ${stop.message}` : ".") +
          " The spec obliges the implementation to fail the affected traffic rather than route around it.",
      };
    case "gatewayMissing":
      return {
        title: `Names a Gateway that does not exist`,
        note: `${stop.route.name} attaches to ${stop.gateway.namespace ? `${stop.gateway.namespace}/` : ""}${stop.gateway.name}, which the API server does not have. No controller will ever write status for that parent — this is the one refusal the cluster cannot say itself.`,
      };
  }
}

// --- the traffic chain --------------------------------------------------

export interface ChainHopObject {
  at: "object";
  object: ObjectRef;
  /** The page's own subject: named rather than linked to itself. */
  self: boolean;
  /** Beside the name, in mono — the thing that makes it this hop. */
  detail: string | null;
  /** Under the name, quieter. */
  via: string | null;
  /**
   * Where this hop is reachable from outside, scheme included.
   *
   * Only an Ingress ever has one, and only where the rule names a host: the
   * scheme comes from whether `spec.tls` covers that host, which the routing
   * edge already states, and a URL with a placeholder host is an address
   * nobody can paste anywhere. Empty for every other hop.
   */
  urls: string[];
  /**
   * What that hostname has to resolve to, where the page has read it.
   *
   * `null` where nothing was read, which is not the same as *read and empty*
   * — an Ingress the controller has not published is unreachable whatever its
   * rules say, and that is a sentence the chain owes the reader rather than a
   * gap it can leave to be inferred.
   */
  publishedAt: string[] | null;
}

/**
 * The last hop, and it is the cluster's own answer rather than ours.
 *
 * It used to be a list of the pods the selector matched with their `Ready`
 * conditions counted — a deduction, one edge per pod, and wrong in both the
 * directions that matter: a draining pod reads as dead while it is still
 * taking traffic, and a Service that publishes nothing at all reads as green.
 */
export interface ChainHopPublished {
  at: "published";
  published: ServicePublished;
  /** The pod behind the first address, so the hop has a name and not only a
   * number. Null where the endpoints name no pod, which a hand-written slice
   * does not. */
  first: ObjectRef | null;
  /** The first address itself, for a slice that names no pod. */
  address: string | null;
  summary: string;
  tone: "on" | "warn";
}

export interface ChainHopStop {
  at: "stop";
  title: string;
  note: string;
}

/**
 * The certificate the connection is made under, above the Ingress.
 *
 * It is a hop rather than a fact on the Ingress hop because it is where the
 * path stops for a browser: an expired certificate refuses the connection
 * before any of the rest of this chain is consulted.
 */
export interface ChainHopCertificate {
  at: "certificate";
  secret: ObjectRef;
  hosts: string[];
  /** `undefined` until the read comes back. */
  read: TlsCertificate | undefined;
}

/**
 * Which controller picks this Ingress up, including "none does".
 *
 * An Ingress object is a request, not a fact. One asking for a class no
 * controller claims looks perfectly configured — correct YAML, no events,
 * no error — and is never served, which is the failure that looks like
 * nothing at all. `IngressClass` is a built-in kind, so this is core.
 */
export interface ChainHopController {
  at: "controller";
  binding: IngressClassBinding;
}

export type ChainHop =
  | ChainHopObject
  | ChainHopPublished
  | ChainHopStop
  | ChainHopCertificate
  | ChainHopController;

export interface ChainPath {
  key: string;
  hops: ChainHop[];
  /** Whether this path stops before it reaches a ready pod. */
  broken: boolean;
}

/**
 * What one Ingress in front of the subject says about itself, read from the
 * Ingress rather than deduced from the edge that names it.
 *
 * Keyed by `refKey` of the Ingress, so a page can fill in as many as it has
 * read and the chain simply draws less for the ones it has not.
 */
export interface RoutedIngress {
  tls: Array<{ secretName: string; hosts: string[] }>;
  /** Who picks it up, including "nobody does". */
  binding: IngressClassBinding | null;
  /**
   * Where the controller published it: `status.loadBalancer.ingress`, as an
   * address or a hostname.
   *
   * Empty is a finding rather than a blank. Until something assigns an
   * address nothing reaches the Ingress at all, and it is the single most
   * common reason a perfectly correct one "does not work" — so the chain says
   * so instead of printing a URL that resolves to nothing.
   */
  addresses: string[];
}

const verb = <V extends Relation["verb"]>(
  edges: ConnectionEdge[],
  which: V
): (ConnectionEdge & { relation: Extract<Relation, { verb: V }> })[] =>
  edges.filter((edge) => edge.relation.verb === which) as never;

function routeHop(
  edges: ConnectionEdge[],
  object: ObjectRef,
  known?: RoutedIngress
): ChainHopObject {
  const relations = edges.map(
    (edge) => edge.relation as Extract<Relation, { verb: "routes" }>
  );
  const detail = [
    ...new Set(
      relations.map((rule) => `${rule.host ?? "any host "}${rule.path}`)
    ),
  ].join(", ");
  return {
    at: "object",
    object,
    self: false,
    detail,
    via: join(
      relations.some((rule) => rule.tls) ? "over HTTPS" : "over plain HTTP",
      describeFacts(object.facts)
    ),
    urls: [
      ...new Set(
        relations.flatMap((rule) =>
          rule.host
            ? [`${rule.tls ? "https" : "http"}://${rule.host}${rule.path}`]
            : []
        )
      ),
    ],
    publishedAt: known ? known.addresses : null,
  };
}

function serviceHop(object: ObjectRef, self: boolean): ChainHopObject {
  return {
    at: "object",
    object,
    self,
    detail: servicePorts(object),
    via: describeFacts(object.facts),
    urls: [],
    publishedAt: null,
  };
}

/**
 * What the Service hands to kube-proxy, counted.
 *
 * A draining address is counted as taking traffic, and that is the fix rather
 * than a nicety: kube-proxy falls back to the terminating endpoints when no
 * ready one is left, so a Service down to one draining pod is a restart in
 * progress and the app used to call it an outage.
 */
function publishedHop(published: ServicePublished): ChainHopPublished {
  const first = published.endpoints[0];
  const rest = endpointCount(published) - 1;
  const summary = join(
    rest > 0 && `and ${rest} more`,
    published.ready > 0 && `${published.ready} published`,
    published.draining > 0 &&
      `${published.draining} draining${published.ready === 0 ? ", still taking traffic" : ""}`,
    published.notReady > 0 && `${published.notReady} not ready`,
    sourceMark(published)
  );
  return {
    at: "published",
    published,
    first: first?.target ?? null,
    address: first ? endpointAddress(first) : null,
    summary,
    tone: published.ready === 0 && published.draining > 0 ? "warn" : "on",
  };
}

/**
 * Which Secret an Ingress serves TLS from, and for which hosts.
 *
 * Read off the same `ingressTls` edge the Connections tab uses — no second
 * request, and no second reading of `spec.tls`.
 */
export function tlsSecrets(
  conns: ResourceConnections
): { secret: ObjectRef; hosts: string[] }[] {
  return verb(conns.edges, "uses")
    .filter(
      (edge) =>
        sameObject(edge.from, conns.subject) && edge.to.kind === "Secret"
    )
    .flatMap((edge) =>
      edge.relation.usages
        .filter((use) => use.how === "ingressTls")
        .map((use) => ({ secret: edge.to, hosts: use.hosts }))
    );
}

/**
 * Whether a `spec.tls` entry covers any of the hosts on this path.
 *
 * An entry with no hosts is the catch-all the Ingress spec allows, and it
 * covers every host the Ingress routes — which is why an empty list is a
 * match rather than a miss. Where hosts are named, matching them is
 * {@link covers}'s job rather than string equality: a Secret named for
 * `*.example.com` is exactly the common case, and exact matching drew no
 * certificate hop for it at all — silently, on the setup most clusters
 * actually use.
 */
function servesAny(tlsHosts: string[], pathHosts: string[]): boolean {
  if (tlsHosts.length === 0) return true;
  return pathHosts.some((host) => host === "" || covers(tlsHosts, host));
}

/**
 * How traffic gets in, one path per Service that fronts the subject.
 *
 * A path with a single hop is not a path — a Service nothing routes to and
 * that selects nothing has only itself to say — so it is dropped here and
 * `chainSilence` states the absence in one line instead. That is what keeps a
 * Deployment with no Service in front of it from costing a diagram.
 */
export function trafficChains(
  conns: ResourceConnections,
  /**
   * What the page has read beyond the edges. Every field is optional and
   * the chain is whole without any of them — the hops they add extend the
   * path, they never replace part of it.
   */
  extra: {
    certificates?: Map<string, TlsCertificate>;
    /** The binding for the subject Ingress, on the Ingress's own page. */
    controller?: IngressClassBinding;
    /**
     * What the Ingresses *in front of* the subject say about themselves, for
     * a page whose subject is not one.
     *
     * The neighbourhood answer carries the routing edges and the Ingress's
     * class, and stops there — an Ingress's `spec.tls` is only walked when
     * the Ingress is the subject. Without this a Deployment could say which
     * hostname reaches it and never whether that hostname is served over TLS,
     * which is the half somebody is usually asking about. Absent, the chain
     * draws exactly what it drew before.
     */
    routing?: Map<string, RoutedIngress>;
  } = {}
): ChainPath[] {
  const subject = conns.subject;
  const routes = verb(conns.edges, "routes");
  const selects = verb(conns.edges, "selects");
  const tls = tlsSecrets(conns);

  const fronting: ObjectRef[] =
    subject.kind === "Service"
      ? [subject]
      : subject.kind === "Ingress"
        ? unique(routes.map((edge) => edge.to))
        : unique(
            selects
              .filter(
                (edge) =>
                  edge.from.kind === "Service" && sameObject(edge.to, subject)
              )
              .map((edge) => edge.from)
          );

  return fronting
    .map((service): ChainPath => {
      // Only the Service-anchored stops belong to this hop; the Gateway API
      // ones stop at a route or a Gateway and are drawn on their own hops.
      const stop = conns.stops.find(
        (entry) => "service" in entry && sameObject(entry.service, service)
      );
      const published = publishedFor(conns, service);

      const hops: ChainHop[] = [];
      if (subject.kind === "Ingress") {
        const mine = routes.filter((edge) => sameObject(edge.to, service));
        const hosts = mine.map((edge) => edge.relation.host ?? "");
        for (const entry of tls.filter((cert) =>
          servesAny(cert.hosts, hosts)
        )) {
          hops.push({
            at: "certificate",
            secret: entry.secret,
            hosts: entry.hosts,
            read: extra.certificates?.get(entry.secret.name),
          });
        }
        if (extra.controller) {
          hops.push({ at: "controller", binding: extra.controller });
        }
        hops.push({
          ...routeHop(mine, subject, extra.routing?.get(refKey(subject))),
          self: true,
        });
        hops.push(
          service.kind === "Service"
            ? serviceHop(service, false)
            : {
                at: "object",
                object: service,
                self: false,
                detail: null,
                via: "a resource backend — the app does not follow these",
                urls: [],
                publishedAt: null,
              }
        );
      } else {
        // One Ingress at a time, and its own certificate and controller above
        // it: two Ingresses fronting the same Service can be served by
        // different classes under different certificates, and a single shared
        // hop at the top would state one of those as if it were both.
        for (const edge of routes.filter((entry) =>
          sameObject(entry.to, service)
        )) {
          const known = extra.routing?.get(refKey(edge.from));
          const host = edge.relation.host ?? "";
          for (const entry of known?.tls ?? []) {
            if (!servesAny(entry.hosts, [host])) continue;
            hops.push({
              at: "certificate",
              secret: {
                kind: "Secret",
                name: entry.secretName,
                namespace: edge.from.namespace,
                existence: "notChecked",
                facts: null,
              },
              hosts: entry.hosts,
              read: extra.certificates?.get(entry.secretName),
            });
          }
          if (known?.binding) {
            hops.push({ at: "controller", binding: known.binding });
          }
          hops.push(routeHop([edge], edge.from, known));
        }
        hops.push(serviceHop(service, subject.kind === "Service"));
      }

      if (
        subject.kind !== "Service" &&
        subject.kind !== "Ingress" &&
        subject.kind !== "Pod"
      ) {
        hops.push({
          at: "object",
          object: subject,
          self: true,
          detail: null,
          via: null,
          urls: [],
          publishedAt: null,
        });
      }
      if (subject.kind === "Pod") {
        hops.push({
          at: "object",
          object: subject,
          self: true,
          detail: null,
          via: describeFacts(subject.facts),
          urls: [],
          publishedAt: null,
        });
      }

      if (stop) hops.push({ at: "stop", ...describeStop(stop) });
      else if (
        subject.kind !== "Pod" &&
        published &&
        endpointCount(published) > 0
      )
        hops.push(publishedHop(published));

      return { key: refKey(service), hops, broken: !!stop };
    })
    .filter((path) => path.hops.length > 1);
}

/**
 * The one line that replaces a chain there is no chain to draw.
 *
 * The backend listed every Service in the namespace, so this is a checked
 * claim rather than an absence of data — which is the only reason it is
 * allowed to be this short.
 */
export function chainSilence(conns: ResourceConnections): string | null {
  const subject = conns.subject;
  const facts = subject.facts;
  if (subject.kind === "Service") {
    if (facts?.kind === "service" && facts.externalName !== null) {
      return `This Service has no selector: it resolves to ${facts.externalName} rather than to anything in this cluster.`;
    }
    if (facts?.kind === "service" && facts.selector === null) {
      return "This Service has no selector and publishes nothing: its endpoints are written by hand, and nobody has written any.";
    }
    return null;
  }
  if (subject.kind === "Ingress") {
    return "This Ingress states no backend, so it routes nothing.";
  }
  if (subject.kind === "Pod") {
    return "No Service in this namespace selects this pod, so nothing in the cluster routes traffic to it.";
  }
  return `No Service in this namespace selects these pods, so nothing in the cluster routes traffic to this ${subject.kind}.`;
}

// --- the tab -----------------------------------------------------------

/**
 * A far end that is not in the cluster at all.
 *
 * The one edge in this model whose other side is a commit. Every other verb
 * joins two objects an API server can be asked about; `delivers` joins an
 * object to the repository that made it, and the reason it belongs in the
 * same list rather than in a box of its own is that it answers the same
 * question the ownership walk answers — *what made this* — and gives a truer
 * answer than the ReplicaSet does.
 */
export interface OutsideEnd {
  /** The controller's object, and where it is in this app. */
  name: string;
  to: string;
  /** What it applied, and a page to read it on where the remote resolves. */
  revision: string | null;
  link: GitLink | null;
}

export interface ConnRow {
  key: string;
  /** Left column. Empty continues the row above, as a table of facts does. */
  label: string;
  object: ObjectRef | null;
  /** Set instead of `object` for the one edge that leaves the cluster. */
  outside?: OutsideEnd;
  /** What the far end knows about itself, beside the name. */
  detail: string;
  /** Every way the subject draws on it — one line each past two. */
  ways: string[];
  /**
   * Whether this row is worth saying "not checked" on.
   *
   * Only where existence bears on the claim the group makes. "If one of these
   * is missing the pod does not start" is exactly such a claim, so a name the
   * app read off a pod spec and never looked up has to say so there. A Node
   * the pod is demonstrably running on does not: repeating it on every row
   * turns an admission into wallpaper, and then nobody reads the one that
   * matters. A `missing` object always says so, in every group.
   */
  verifiable?: boolean;
  /** Set where the row is the app admitting it did not look. */
  unasked?: boolean;
}

export interface ConnGroup {
  key: string;
  title: string;
  caption: string | null;
  rows: ConnRow[];
}

/** Which question a thing a pod spec names is an answer to. */
const NEED_LABEL: Record<string, string> = {
  ConfigMap: "Configuration",
  Secret: "Configuration",
  PersistentVolumeClaim: "Storage",
  ServiceAccount: "Identity",
};

const NEED_ORDER = ["Configuration", "TLS certificate", "Storage", "Identity"];

/**
 * What the top of an ownership chain is worth opening for. Shared with the
 * overview's own chain so the two never say it differently.
 */
export const REPLICAS_SET_HERE = "the replica count is set here";

const OWNABLE = new Set([
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
  "CronJob",
]);

const UNASKED_LABEL: Record<string, string> = {
  HorizontalPodAutoscaler: "Autoscaling",
  PodDisruptionBudget: "Disruption budget",
};

/** A label is written once and left blank on the rows that repeat it. */
function labelled(rows: ConnRow[]): ConnRow[] {
  let last = "";
  return rows.map((row) => {
    const label = row.label === last ? "" : row.label;
    last = row.label;
    return { ...row, label };
  });
}

/**
 * A row for an object with nothing but its own facts to add. Existence is
 * left off deliberately: "not checked" is a different claim from a fact the
 * cluster stated, and the row draws it in its own tone rather than smuggling
 * it into the same string.
 */
function rowFor(label: string, object: ObjectRef, extra?: string): ConnRow {
  return {
    key: refKey(object),
    label,
    object,
    detail: join(extra, describeFacts(object.facts)),
    ways: [],
  };
}

function needsToRun(conns: ResourceConnections): ConnRow[] {
  const rows = verb(conns.edges, "uses")
    .filter((edge) => sameObject(edge.from, conns.subject))
    .map((edge) => ({
      ...rowFor(
        edge.relation.usages.every((use) => use.how === "ingressTls")
          ? "TLS certificate"
          : (NEED_LABEL[edge.to.kind] ?? edge.to.kind),
        edge.to
      ),
      ways: describeUsages(edge.relation.usages),
      verifiable: true,
    }));
  rows.sort((a, b) => {
    const rank = (label: string) => {
      const at = NEED_ORDER.indexOf(label);
      return at === -1 ? NEED_ORDER.length : at;
    };
    return rank(a.label) - rank(b.label);
  });
  return labelled(rows);
}

function usedBy(conns: ResourceConnections): ConnRow[] {
  return labelled(
    verb(conns.edges, "uses")
      .filter((edge) => sameObject(edge.to, conns.subject))
      .map((edge) => ({
        ...rowFor(edge.from.kind, edge.from),
        ways: describeUsages(edge.relation.usages),
      }))
  );
}

/**
 * What made the pods behind an address.
 *
 * A Service states no workload. The pods it selects state their owners, and
 * the top of that chain is the thing somebody deploys — so the roots of the
 * ownership edges are the answer, and the ReplicaSet in between is noise
 * here.
 */
function answersHere(conns: ResourceConnections): ConnRow[] {
  const owns = verb(conns.edges, "owns");
  const owned = new Set(owns.map((edge) => refKey(edge.to)));
  return labelled(
    unique(
      owns
        .map((edge) => edge.from)
        .filter(
          (from) => !owned.has(refKey(from)) && !sameObject(from, conns.subject)
        )
    ).map((object) => rowFor(object.kind, object))
  );
}

/**
 * Who made this, all the way up, and what it made.
 *
 * Walked rather than read one hop: a pod's owner is a hash nobody named, and
 * the object somebody actually deploys is one further up. The backend already
 * sent every hop of the chain, so this costs a loop rather than a request.
 *
 * ## Why the top of the chain says where the replica count is set
 *
 * A pod is not scalable and must not pretend to be — a Scale control here
 * would write a number to an object that has no such field. But a reader
 * standing on a crash-looping pod asking where to set the count is two hops
 * from the answer, and nothing on the row says which of the two names is the
 * one to open: `crash-demo-c688f57cf` is a revision that will be replaced,
 * `crash-demo` is where the number lives. The name is already a link; the
 * clause is what makes it worth following, and it is only ever put on a kind
 * this app can actually scale, so it never points somewhere with no control.
 */
function madeByAndMakes(conns: ResourceConnections): ConnRow[] {
  const owns = verb(conns.edges, "owns");
  const children = owns.filter((edge) => sameObject(edge.from, conns.subject));

  const rows: ConnRow[] = [];
  const seen = new Set<string>([refKey(conns.subject)]);
  let child = conns.subject;
  for (;;) {
    const up = owns.filter((edge) => sameObject(edge.to, child));
    if (up.length === 0) break;
    for (const edge of up) {
      rows.push({
        ...rowFor(
          "Controlled by",
          edge.from,
          edge.relation.controller ? undefined : "an owner, not the controller"
        ),
        key: `owner:${refKey(edge.from)}`,
      });
    }
    const next = up.find((edge) => edge.relation.controller) ?? up[0];
    if (seen.has(refKey(next.from))) break;
    seen.add(refKey(next.from));
    child = next.from;
  }

  const top = rows.findIndex((row) => row.key === `owner:${refKey(child)}`);
  if (top !== -1 && isScalable(child.kind)) {
    rows[top] = {
      ...rows[top],
      detail: join(REPLICAS_SET_HERE, rows[top].detail),
    };
  }

  if (rows.length === 0) {
    rows.push({
      key: "owner:none",
      label: "Controlled by",
      object: null,
      detail: `nothing — a ${conns.subject.kind} is the top`,
      ways: [],
    });
  }

  const revisions = children
    .filter((edge) => edge.to.kind === "ReplicaSet")
    .sort((a, b) => revisionOf(b.to) - revisionOf(a.to));
  const rest = children.filter((edge) => edge.to.kind !== "ReplicaSet");

  for (const edge of [...revisions, ...rest]) {
    rows.push({
      ...rowFor(edge.to.kind === "ReplicaSet" ? "Revisions" : "Runs", edge.to),
      key: `child:${refKey(edge.to)}`,
    });
  }
  return labelled(rows);
}

function revisionOf(object: ObjectRef): number {
  const facts = object.facts;
  if (facts?.kind !== "workload" || facts.revision === null) return -1;
  return Number.parseInt(facts.revision, 10) || -1;
}

/**
 * Where the scheduler put it — the same edge, read from whichever end the
 * page is standing on.
 *
 * The mirror used to be withheld. `get_resource_connections` resolved a
 * missing namespace to `default`, so a Node came back with whatever happened
 * to live there and would have drawn that as the whole answer; the subject's
 * own scope decides now, and a Node's pods are read across every namespace.
 */
function placement(conns: ResourceConnections): ConnGroup | null {
  const edges = verb(conns.edges, "runsOn");
  if (edges.length === 0) return null;
  if (conns.subject.kind === "Node") return runsHere(conns, edges);
  return {
    key: "placement",
    title: "Runs on",
    caption: null,
    rows: labelled(
      unique(edges.map((edge) => edge.to)).map((object) =>
        rowFor("Nodes", object)
      )
    ),
  };
}

/**
 * The pods a node is carrying, labelled by the namespace they are in.
 *
 * The namespace is the label rather than a suffix on the name because it is
 * the thing that repeats: a node in a real cluster carries kube-system's
 * pods, an ingress controller's and the reader's own, and the grouping is
 * what turns a flat list of forty names into three answers. It is also the
 * fact the old, namespace-scoped answer could not have stated at all.
 *
 * The count reads against what the scheduler will allow, because a list of
 * pods with no denominator does not answer "is this node full".
 */
function runsHere(
  conns: ResourceConnections,
  edges: ConnectionEdge[]
): ConnGroup {
  const pods = unique(edges.map((edge) => edge.from)).sort(
    (a, b) =>
      (a.namespace ?? "").localeCompare(b.namespace ?? "") ||
      a.name.localeCompare(b.name)
  );
  const namespaces = new Set(pods.map((pod) => pod.namespace ?? "")).size;
  const facts = conns.subject.facts;
  const capacity =
    facts?.kind === "node" && facts.podCapacity !== null
      ? `, of the ${facts.podCapacity} this node will take`
      : "";
  const tally = `${pods.length === 1 ? "1 pod" : `${pods.length} pods`}${
    namespaces > 1 ? ` across ${namespaces} namespaces` : ""
  }${capacity}`;
  return {
    key: "placed",
    title: "What runs here",
    caption: `— ${join(tally, facts?.kind === "node" ? nodeCapacity(facts) : null)}`,
    rows: labelled(
      pods.map((pod) => rowFor(pod.namespace ?? "no namespace", pod))
    ),
  };
}

/**
 * What acts on this object without it having asked, and without it knowing.
 *
 * Its own group rather than a couple of rows in "Made by, and makes", and the
 * difference is the tense: that group answers *what made this*, which is a
 * fact about the past and is settled. These two are about what is going to
 * happen next — a replica count that moves back in fifteen seconds, an
 * eviction that gets refused — and the reader looking for either is not
 * looking at provenance.
 *
 * Nor does it merge with "Needs to run": that group's claim is "if one of
 * these is missing the pod does not start", and an autoscaler is the exact
 * opposite kind of thing. The workload runs perfectly well without it, and
 * has no say in it either way.
 */
function governedBy(conns: ResourceConnections): ConnRow[] {
  const rows = verb(conns.edges, "governs").map((edge) => ({
    ...rowFor(GOVERNOR_LABEL[edge.from.kind] ?? edge.from.kind, edge.from),
    key: `governs:${refKey(edge.from)}:${refKey(edge.to)}`,
    ways: [
      // Named where the far end is not the page's own subject — on a pod, an
      // autoscaler scales the Deployment above it, and saying "scales this"
      // there would be wrong about which object the number belongs to.
      ...(sameObject(edge.to, conns.subject)
        ? []
        : [
            `${GOVERNS_VERB[edge.from.kind] ?? "acts on"} ${edge.to.kind} ${edge.to.name}`,
          ]),
      // And which query reached it. A budget names no workload — it matched
      // labels — so "why does this apply to me" is otherwise unanswerable
      // from the page it applies to. An autoscaler states its target
      // outright and carries no selector to print.
      ...(edge.relation.selector ? [`matched ${edge.relation.selector}`] : []),
    ],
  }));
  return labelled(rows);
}

const GOVERNOR_LABEL: Record<string, string> = {
  HorizontalPodAutoscaler: "Autoscaling",
  PodDisruptionBudget: "Disruption budget",
};

const GOVERNS_VERB: Record<string, string> = {
  HorizontalPodAutoscaler: "scales",
  PodDisruptionBudget: "protects",
};

function bindings(conns: ResourceConnections): ConnRow[] {
  return labelled(
    verb(conns.edges, "binds").map((edge) =>
      rowFor(
        edge.to.kind === "StorageClass" ? "Storage class" : "Volume",
        edge.to
      )
    )
  );
}

/**
 * Every group this object has, in the order the questions get asked.
 *
 * The traffic edges are deliberately absent: the chain on the Overview draws
 * them, and a tab that repeated them would be a second answer to a question
 * already answered one scroll up.
 */
export function connectionGroups(
  conns: ResourceConnections,
  /**
   * What delivered the subject, where anything did.
   *
   * Passed in rather than fetched here for the reason the whole module is
   * pure: the edges come from one backend call and the provenance from a
   * capability that may not be installed, and the grouping must not learn
   * how either of them is fetched.
   */
  delivery: Delivery[] = []
): ConnGroup[] {
  const deliveredBy = deliveredRows(delivery);
  const groups: (ConnGroup | null)[] = [
    {
      key: "needs",
      title: "Needs to run",
      caption: "— if one of these is missing the pod does not start",
      rows: needsToRun(conns),
    },
    {
      key: "used-by",
      title: "Used by",
      caption: "— what names this in its pod spec",
      rows: usedBy(conns),
    },
    conns.subject.kind === "Service" || conns.subject.kind === "Ingress"
      ? {
          key: "answers",
          title: "What answers here",
          caption: "— what made the pods behind this address",
          rows: answersHere(conns),
        }
      : null,
    placement(conns),
    { key: "binds", title: "Bound to", caption: null, rows: bindings(conns) },
    {
      key: "governs",
      title: "Governed by",
      caption:
        "— acts on this on its own schedule, and nothing here asked for it",
      rows: governedBy(conns),
    },
    // Only for the kinds that take part in ownership at all. "Controlled by:
    // nothing" is a real answer on a Deployment and a non-sequitur on a
    // ConfigMap, which no controller was ever going to have made.
    // Drawn for a delivered object whatever its kind: a ConfigMap has no
    // controller and "Controlled by: nothing" would be a non-sequitur, but a
    // ConfigMap applied from a repository was still *made* by something, and
    // that is exactly what this group is called.
    OWNABLE.has(conns.subject.kind) || deliveredBy.length > 0
      ? {
          key: "owners",
          title: "Made by, and makes",
          caption: null,
          rows: [
            ...deliveredBy,
            ...(OWNABLE.has(conns.subject.kind) ? madeByAndMakes(conns) : []),
          ],
        }
      : null,
  ];

  const drawn = groups.filter(
    (group): group is ConnGroup => group !== null && group.rows.length > 0
  );

  if (conns.notLookedAt.length > 0) {
    drawn.push({
      key: "unasked",
      title: "Not looked at",
      caption:
        "— named, so a group that is absent is never read as a group that is empty",
      rows: conns.notLookedAt.map((entry) => ({
        key: entry.kind,
        label: UNASKED_LABEL[entry.kind] ?? entry.kind,
        object: null,
        detail: entry.why,
        ways: [],
        unasked: true,
      })),
    });
  }

  return drawn;
}

/**
 * The `delivers` edge, whose far end is out of the cluster.
 *
 * Only a *confirmed* delivery earns a structural edge. A label nothing
 * honours is a claim about provenance and is said as one, on the Overview —
 * drawing it here would put a line in the connection graph for a relationship
 * that does not exist.
 */
function deliveredRows(delivery: Delivery[]): ConnRow[] {
  return labelled(
    delivered(delivery).map((source) => ({
      key: `delivered:${source.vendorId}:${source.owner.namespace}/${source.owner.name}`,
      label: "Delivered by",
      object: null,
      outside: {
        name: source.owner.name,
        to: source.owner.to,
        revision: source.revision,
        link: source.repoUrl
          ? gitRevisionLink(source.repoUrl, source.revision)
          : null,
      },
      detail: [
        `${source.vendor} ${source.owner.kind}`,
        source.path ? `from ${source.path}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      ways: [],
    }))
  );
}

/**
 * How many pods a node is carrying.
 *
 * The `runsOn` edges, counted. The node page used to ask for the same list a
 * second time to fill the Pods row of its Headroom block; both reads are
 * `spec.nodeName=<node>` across every namespace, and one of them is enough.
 */
export function podsOnNode(
  conns: ResourceConnections | undefined
): number | undefined {
  if (!conns || conns.subject.kind !== "Node") return undefined;
  return unique(verb(conns.edges, "runsOn").map((edge) => edge.from)).length;
}

/** How many distinct objects the tab draws — what its count mark stands for. */
export function connectionCount(conns: ResourceConnections): number {
  return unique(
    connectionGroups(conns)
      .flatMap((group) => group.rows)
      .map((row) => row.object)
      .filter((object): object is ObjectRef => object !== null)
  ).length;
}
