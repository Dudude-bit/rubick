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

import type { T } from "@/i18n/useT";
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

/**
 * "a, and b" for two; "a, b, and c" past that — the mock's rhythm.
 *
 * The last join is a catalogue string because it is a word: English puts
 * "and" there and Russian puts "и", with no comma before it. Hard-coding
 * either one leaves the other language reading a sentence in two.
 */
function sentence(parts: string[], t: T): string {
  const kept = [...new Set(parts.filter(Boolean))];
  if (kept.length <= 1) return kept[0] ?? "";
  return t("nav", "listAndLast", {
    list: kept.slice(0, -1).join(", "),
    last: kept[kept.length - 1],
  });
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
function describeUsage(
  usage: Usage,
  containers: string[] | null,
  t: T
): string {
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
        ? t("nav", "projectedInto", { path: usage.path })
        : t("nav", "mountedAt", { path: usage.path });
      const from = usage.subPath
        ? t("nav", "fromSubPath", { subPath: usage.subPath })
        : "";
      return inside(
        `${where}${from}${usage.readOnly ? t("nav", "readOnlySuffix") : ""}`
      );
    }
    case "unmounted":
      return t("nav", "inVolumeUnmounted", { volume: usage.volume });
    case "env":
      return inside(`${usage.name} reads ${usage.key}`);
    case "envFrom":
      return inside(t("nav", "everyKeyBecomesEnv"));
    case "imagePullSecret":
      return t("nav", "usedToPullImages");
    case "identity":
      return t("nav", "identityItRunsAs");
    case "ingressTls":
      return usage.hosts.length > 0
        ? t("nav", "servesTlsFor", { hosts: usage.hosts.join(", ") })
        : t("nav", "servesTlsForHosts");
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
export function describeUsages(usages: Usage[], t: T): string[] {
  const groups = groupMounts(usages.filter((use) => use.how === "mount"));
  const rest = usages.filter((use) => use.how !== "mount");
  const drawnBy = new Set(
    usages.flatMap((use) => ("container" in use ? [use.container] : []))
  );

  const say = (containers: boolean) => [
    ...new Set([
      ...groups.map((group) =>
        describeUsage(group.mount, containers ? group.containers : null, t)
      ),
      ...rest.map((use) =>
        describeUsage(
          use,
          containers && "container" in use ? [use.container] : null,
          t
        )
      ),
    ]),
  ];

  const ways = say(false);
  if (ways.length > 2 || (ways.length > 1 && drawnBy.size > 1))
    return say(true);
  return [sentence(ways, t)].filter(Boolean);
}

/** What the far end knows about itself, where it is worth a line. */
function describeFacts(facts: ObjectFacts | null, t: T): string | null {
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
      return serviceVia(facts, t);
    case "ingress":
      return facts.className;
    case "autoscaler":
      return join(autoscalerRange(facts, t), autoscalerReplicas(facts, t));
    case "budget":
      return join(budgetRule(facts, t), budgetRoom(facts, t));
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

function serviceVia(
  facts: Extract<ObjectFacts, { kind: "service" }>,
  t: T
): string {
  const address =
    facts.externalName !== null
      ? `ExternalName → ${facts.externalName}`
      : join(facts.type, facts.clusterIp);
  return join(
    address,
    facts.selector ? `selects ${facts.selector}` : t("nav", "noSelector")
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
  t: T,
  verifiable = true
): string | null {
  if (ref.existence === "missing") return t("nav", "notInThisNamespace");
  if (ref.existence === "notChecked" && verifiable)
    return t("nav", "notChecked");
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
export function describeStop(
  stop: ChainStop,
  t: T
): { title: string; note: string } {
  switch (stop.reason) {
    case "publishesNothing": {
      const matched =
        stop.readyPods === stop.pods
          ? t("count", "podsMatchAllReady", { n: stop.pods })
          : t("count", "podsMatchSomeReady", {
              n: stop.pods,
              ready: stop.readyPods,
            });
      if (stop.unnamedPorts.length === 0) {
        return {
          title: t("nav", "servicePublishesNoEndpoint"),
          note: t("nav", "stopNoSliceNote", { matched }),
        };
      }
      const asked = stop.unnamedPorts
        .map((name) => t("nav", "targetPortNamed", { name }))
        .join(", ");
      return {
        title: t("nav", "servicePublishesNoEndpoint"),
        note: t("nav", "stopUnnamedPortNote", { matched, asked }),
      };
    }
    case "backendMissing":
      return {
        title: t("nav", "stopNoServiceNamed", { name: stop.service.name }),
        note: t("nav", "ingressBackendNeverCreated"),
      };
    case "selectsNothing":
      return {
        title: t("nav", "stopNoPodCarries", { selector: stop.selector }),
        note: t("nav", "connectionRefusedNothingBehind"),
      };
    case "noneReady":
      return {
        title: t("count", "podsCarryNotReady", {
          n: stop.pods,
          selector: stop.selector,
        }),
        note: t("nav", "stopNoneReadyNote"),
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
  /** Who picks it up, including t("nav", "nobodyDoes"). */
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
  t: T,
  known?: RoutedIngress
): ChainHopObject {
  const relations = edges.map(
    (edge) => edge.relation as Extract<Relation, { verb: "routes" }>
  );
  const detail = [
    ...new Set(
      relations.map(
        (rule) => `${rule.host ?? `${t("action", "anyHost")} `}${rule.path}`
      )
    ),
  ].join(", ");
  return {
    at: "object",
    object,
    self: false,
    detail,
    via: join(
      relations.some((rule) => rule.tls)
        ? t("nav", "overHttps")
        : t("nav", "overHttpPlain"),
      describeFacts(object.facts, t)
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

function serviceHop(object: ObjectRef, self: boolean, t: T): ChainHopObject {
  return {
    at: "object",
    object,
    self,
    detail: servicePorts(object),
    via: describeFacts(object.facts, t),
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
function publishedHop(published: ServicePublished, t: T): ChainHopPublished {
  const first = published.endpoints[0];
  const rest = endpointCount(published) - 1;
  const summary = join(
    rest > 0 && t("empty", "andMore", { n: rest }),
    published.ready > 0 &&
      t("readings", "publishedCount", { n: published.ready }),
    published.draining > 0 &&
      `${t("readings", "drainingCount", { n: published.draining })}${
        published.ready === 0 ? t("readings", "stillTakingTraffic") : ""
      }`,
    published.notReady > 0 &&
      t("readings", "notReadyEndpoints", { n: published.notReady }),
    sourceMark(published, t)
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
  t: T,
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
      const stop = conns.stops.find((entry) =>
        sameObject(entry.service, service)
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
          ...routeHop(mine, subject, t, extra.routing?.get(refKey(subject))),
          self: true,
        });
        hops.push(
          service.kind === "Service"
            ? serviceHop(service, false, t)
            : {
                at: "object",
                object: service,
                self: false,
                detail: null,
                via: t("nav", "resourceBackend"),
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
          hops.push(routeHop([edge], edge.from, t, known));
        }
        hops.push(serviceHop(service, subject.kind === "Service", t));
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
          via: describeFacts(subject.facts, t),
          urls: [],
          publishedAt: null,
        });
      }

      if (stop) hops.push({ at: "stop", ...describeStop(stop, t) });
      else if (
        subject.kind !== "Pod" &&
        published &&
        endpointCount(published) > 0
      )
        hops.push(publishedHop(published, t));

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
export function chainSilence(conns: ResourceConnections, t: T): string | null {
  const subject = conns.subject;
  const facts = subject.facts;
  if (subject.kind === "Service") {
    if (facts?.kind === "service" && facts.externalName !== null) {
      return t("nav", "serviceResolvesExternal", {
        name: facts.externalName,
      });
    }
    if (facts?.kind === "service" && facts.selector === null) {
      return t("nav", "endpointsByHandNoneWritten");
    }
    return null;
  }
  if (subject.kind === "Ingress") {
    return t("nav", "ingressStatesNoBackend");
  }
  if (subject.kind === "Pod") {
    return t("nav", "noServiceSelectsPod");
  }
  return t("nav", "noServiceSelectsThese", { kind: subject.kind });
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
  /** Sort order, where the group has one. Not a label — see NEED_LABEL. */
  rank?: number;
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
   * Whether this row is worth saying t("nav", "notChecked") on.
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
/**
 * What a needed object is called, as a catalogue key rather than the words.
 *
 * The words used to be the key: this table held "Configuration" and the sort
 * below looked that same string up in an order list. Translating the label
 * would have left every row ranked last, in whatever order the API happened
 * to return them — a label doing double duty as a sort key breaks the moment
 * the label stops being English.
 */
const NEED_LABEL: Record<string, NeedKey> = {
  ConfigMap: "configuration",
  Secret: "configuration",
  PersistentVolumeClaim: "storage",
  ServiceAccount: "identity",
};

type NeedKey = "configuration" | "tlsCertificate" | "storage" | "identity";

/** Worst-to-least surprising, and independent of the language. */
const NEED_ORDER: NeedKey[] = [
  "configuration",
  "tlsCertificate",
  "storage",
  "identity",
];

/** Which of the four a needed object is, or none of them. */
function needKey(edge: { relation: { usages: Usage[] }; to: ObjectRef }) {
  return edge.relation.usages.every((use) => use.how === "ingressTls")
    ? ("tlsCertificate" as NeedKey)
    : NEED_LABEL[edge.to.kind];
}

/** Its place in the order, or last for a kind the table does not name. */
function needRank(edge: { relation: { usages: Usage[] }; to: ObjectRef }) {
  const key = needKey(edge);
  const at = key ? NEED_ORDER.indexOf(key) : -1;
  return at === -1 ? NEED_ORDER.length : at;
}

/** And what to call it — the kind's own name where the table has none. */
function needLabel(
  edge: { relation: { usages: Usage[] }; to: ObjectRef },
  t: T
): string {
  // The four live in two sections of the catalogue, so the section is part
  // of the answer rather than something a caller can guess.
  switch (needKey(edge)) {
    case "configuration":
      return t("nav", "configuration");
    case "tlsCertificate":
      return t("nav", "tlsCertificate");
    case "storage":
      return t("nav", "storage");
    case "identity":
      return t("columns", "identity");
    default:
      return edge.to.kind;
  }
}

/**
 * What the top of an ownership chain is worth opening for. Shared with the
 * overview's own chain so the two never say it differently.
 */
/** The catalogue key for it, so the two callers cannot word it differently. */
export const REPLICAS_SET_HERE = "replicaCountSetHere" as const;

const OWNABLE = new Set([
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
  "CronJob",
]);

const UNASKED_LABEL: Record<string, "autoscaling" | "disruptionBudget"> = {
  HorizontalPodAutoscaler: "autoscaling",
  PodDisruptionBudget: "disruptionBudget",
};

/** The same, for the group that names what was never read. */
function unaskedLabel(kind: string, t: T): string {
  const key = UNASKED_LABEL[kind];
  return key ? t("nav", key) : kind;
}

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
 * left off deliberately: t("nav", "notChecked") is a different claim from a fact the
 * cluster stated, and the row draws it in its own tone rather than smuggling
 * it into the same string.
 */
function rowFor(
  label: string,
  object: ObjectRef,
  t: T,
  extra?: string
): ConnRow {
  return {
    key: refKey(object),
    label,
    object,
    detail: join(extra, describeFacts(object.facts, t)),
    ways: [],
  };
}

function needsToRun(conns: ResourceConnections, t: T): ConnRow[] {
  const rows = verb(conns.edges, "uses")
    .filter((edge) => sameObject(edge.from, conns.subject))
    .map((edge) => ({
      ...rowFor(needLabel(edge, t), edge.to, t),
      ways: describeUsages(edge.relation.usages, t),
      verifiable: true,
      rank: needRank(edge),
    }));
  rows.sort(
    (a, b) => (a.rank ?? NEED_ORDER.length) - (b.rank ?? NEED_ORDER.length)
  );
  return labelled(rows);
}

function usedBy(conns: ResourceConnections, t: T): ConnRow[] {
  return labelled(
    verb(conns.edges, "uses")
      .filter((edge) => sameObject(edge.to, conns.subject))
      .map((edge) => ({
        ...rowFor(edge.from.kind, edge.from, t),
        ways: describeUsages(edge.relation.usages, t),
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
function answersHere(conns: ResourceConnections, t: T): ConnRow[] {
  const owns = verb(conns.edges, "owns");
  const owned = new Set(owns.map((edge) => refKey(edge.to)));
  return labelled(
    unique(
      owns
        .map((edge) => edge.from)
        .filter(
          (from) => !owned.has(refKey(from)) && !sameObject(from, conns.subject)
        )
    ).map((object) => rowFor(object.kind, object, t))
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
function madeByAndMakes(conns: ResourceConnections, t: T): ConnRow[] {
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
          t("columns", "controlledBy"),
          edge.from,
          t,
          edge.relation.controller ? undefined : t("nav", "ownerNotController")
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
      detail: join(t("nav", REPLICAS_SET_HERE), rows[top].detail),
    };
  }

  if (rows.length === 0) {
    rows.push({
      key: "owner:none",
      label: t("columns", "controlledBy"),
      object: null,
      detail: t("nav", "nothingIsTheTop", { kind: conns.subject.kind }),
      ways: [],
    });
  }

  const revisions = children
    .filter((edge) => edge.to.kind === "ReplicaSet")
    .sort((a, b) => revisionOf(b.to) - revisionOf(a.to));
  const rest = children.filter((edge) => edge.to.kind !== "ReplicaSet");

  for (const edge of [...revisions, ...rest]) {
    rows.push({
      ...rowFor(
        edge.to.kind === "ReplicaSet" ? "Revisions" : "Runs",
        edge.to,
        t
      ),
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
function placement(conns: ResourceConnections, t: T): ConnGroup | null {
  const edges = verb(conns.edges, "runsOn");
  if (edges.length === 0) return null;
  if (conns.subject.kind === "Node") return runsHere(conns, edges, t);
  return {
    key: "placement",
    title: t("nav", "runsOn"),
    caption: null,
    rows: labelled(
      unique(edges.map((edge) => edge.to)).map((object) =>
        rowFor("Nodes", object, t)
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
  edges: ConnectionEdge[],
  t: T
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
    title: t("nav", "whatRunsHere"),
    caption: `— ${join(tally, facts?.kind === "node" ? nodeCapacity(facts) : null)}`,
    rows: labelled(
      pods.map((pod) =>
        rowFor(pod.namespace ?? t("nav", "noNamespaceValue"), pod, t)
      )
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
function governedBy(conns: ResourceConnections, t: T): ConnRow[] {
  const rows = verb(conns.edges, "governs").map((edge) => ({
    ...rowFor(governorLabel(edge.from.kind, t), edge.from, t),
    key: `governs:${refKey(edge.from)}:${refKey(edge.to)}`,
    ways: [
      // Named where the far end is not the page's own subject — on a pod, an
      // autoscaler scales the Deployment above it, and saying "scales this"
      // there would be wrong about which object the number belongs to.
      ...(sameObject(edge.to, conns.subject)
        ? []
        : [
            `${t("nav", GOVERNS_VERB[edge.from.kind] ?? "actsOn")} ${edge.to.kind} ${edge.to.name}`,
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

const GOVERNOR_LABEL: Record<string, "autoscaling" | "disruptionBudget"> = {
  HorizontalPodAutoscaler: "autoscaling",
  PodDisruptionBudget: "disruptionBudget",
};

/** What governs this, in words — the kind's own name where there are none. */
function governorLabel(kind: string, t: T): string {
  const key = GOVERNOR_LABEL[kind];
  return key ? t("nav", key) : kind;
}

const GOVERNS_VERB: Record<string, "scalesVerb" | "protectsVerb"> = {
  HorizontalPodAutoscaler: "scalesVerb",
  PodDisruptionBudget: "protectsVerb",
};

function bindings(conns: ResourceConnections, t: T): ConnRow[] {
  return labelled(
    verb(conns.edges, "binds").map((edge) =>
      rowFor(
        edge.to.kind === "StorageClass"
          ? t("columns", "storageClass")
          : t("columns", "volume"),
        edge.to,
        t
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
  t: T,
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
  const deliveredBy = deliveredRows(delivery, t);
  const groups: (ConnGroup | null)[] = [
    {
      key: "needs",
      title: t("nav", "needsToRun"),
      caption: t("nav", "needsToRunNote"),
      rows: needsToRun(conns, t),
    },
    {
      key: "used-by",
      title: t("nav", "usedBy"),
      caption: t("nav", "usedByNote"),
      rows: usedBy(conns, t),
    },
    conns.subject.kind === "Service" || conns.subject.kind === "Ingress"
      ? {
          key: "answers",
          title: t("nav", "whatAnswersHere"),
          caption: t("nav", "whatAnswersHereNote"),
          rows: answersHere(conns, t),
        }
      : null,
    placement(conns, t),
    {
      key: "binds",
      title: t("nav", "boundTo"),
      caption: null,
      rows: bindings(conns, t),
    },
    {
      key: "governs",
      title: t("nav", "governedBy"),
      caption: t("nav", "governedByNote"),
      rows: governedBy(conns, t),
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
          title: t("nav", "madeByAndMakes"),
          caption: null,
          rows: [
            ...deliveredBy,
            ...(OWNABLE.has(conns.subject.kind)
              ? madeByAndMakes(conns, t)
              : []),
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
      title: t("nav", "notLookedAt"),
      caption: t("nav", "notLookedAtNote"),
      rows: conns.notLookedAt.map((entry) => ({
        key: entry.kind,
        label: unaskedLabel(entry.kind, t),
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
function deliveredRows(delivery: Delivery[], t: T): ConnRow[] {
  return labelled(
    delivered(delivery).map((source) => ({
      key: `delivered:${source.vendorId}:${source.owner.namespace}/${source.owner.name}`,
      label: t("nav", "deliveredBy"),
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
/**
 * A translator for the one caller that provably throws every word away.
 *
 * {@link connectionCount} reads `row.object` and nothing else, so the number
 * cannot depend on the language — and threading a translator through the ten
 * pages that ask for the count, so that a count could ignore it, would be a
 * parameter that exists to be discarded.
 */
const NO_WORDS: T = () => "";

export function connectionCount(conns: ResourceConnections): number {
  return unique(
    connectionGroups(conns, NO_WORDS)
      .flatMap((group) => group.rows)
      .map((row) => row.object)
      .filter((object): object is ObjectRef => object !== null)
  ).length;
}
