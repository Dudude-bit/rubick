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

import { groupMounts } from "./mounts";
import type {
  ChainStop,
  ConnectionEdge,
  ObjectFacts,
  ObjectRef,
  Relation,
  IngressClassBinding,
  ResourceConnections,
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
  }
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
 * The three ways a path stops, each a different repair.
 *
 * `noneReady` is the one this view was built for: a Service whose pods are
 * running and none of which passes its readiness probe looks healthy on every
 * list page in the app, and refuses every connection.
 */
export function describeStop(stop: ChainStop): { title: string; note: string } {
  switch (stop.reason) {
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
        note: "A Service publishes no endpoint for a pod that fails its readiness probe, so traffic is refused while the pods sit there running — which is why every list page in the app draws this as healthy.",
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
}

export interface ChainHopPods {
  at: "pods";
  pods: ObjectRef[];
  summary: string;
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
  | ChainHopPods
  | ChainHopStop
  | ChainHopCertificate
  | ChainHopController;

export interface ChainPath {
  key: string;
  hops: ChainHop[];
  /** Whether this path stops before it reaches a ready pod. */
  broken: boolean;
}

const verb = <V extends Relation["verb"]>(
  edges: ConnectionEdge[],
  which: V
): (ConnectionEdge & { relation: Extract<Relation, { verb: V }> })[] =>
  edges.filter((edge) => edge.relation.verb === which) as never;

function routeHop(edges: ConnectionEdge[], object: ObjectRef): ChainHopObject {
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
  };
}

function serviceHop(object: ObjectRef, self: boolean): ChainHopObject {
  return {
    at: "object",
    object,
    self,
    detail: servicePorts(object),
    via: describeFacts(object.facts),
  };
}

function podsHop(pods: ObjectRef[]): ChainHopPods {
  const ready = pods.filter(
    (pod) => pod.facts?.kind === "pod" && pod.facts.ready
  ).length;
  const serving =
    ready === pods.length
      ? pods.length === 1
        ? "serving"
        : pods.length === 2
          ? "both serving"
          : `all ${pods.length} serving`
      : `${ready} of ${pods.length} serving`;
  return {
    at: "pods",
    pods,
    summary: join(pods.length > 1 && `and ${pods.length - 1} more`, serving),
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
 * match rather than a miss.
 */
function servesAny(tlsHosts: string[], pathHosts: string[]): boolean {
  if (tlsHosts.length === 0) return true;
  return pathHosts.some((host) => host === "" || tlsHosts.includes(host));
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
    controller?: IngressClassBinding;
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
      const pods = unique(
        selects
          .filter(
            (edge) => sameObject(edge.from, service) && edge.to.kind === "Pod"
          )
          .map((edge) => edge.to)
      );

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
        hops.push({ ...routeHop(mine, subject), self: true });
        hops.push(
          service.kind === "Service"
            ? serviceHop(service, false)
            : {
                at: "object",
                object: service,
                self: false,
                detail: null,
                via: "a resource backend — the app does not follow these",
              }
        );
      } else {
        for (const edge of routes.filter((entry) =>
          sameObject(entry.to, service)
        )) {
          hops.push(routeHop([edge], edge.from));
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
        });
      }
      if (subject.kind === "Pod") {
        hops.push({
          at: "object",
          object: subject,
          self: true,
          detail: null,
          via: describeFacts(subject.facts),
        });
      }

      if (stop) hops.push({ at: "stop", ...describeStop(stop) });
      else if (subject.kind !== "Pod" && pods.length > 0)
        hops.push(podsHop(pods));

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
      return "This Service has no selector, so whatever answers here was registered by hand — the app cannot say what it is.";
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

export interface ConnRow {
  key: string;
  /** Left column. Empty continues the row above, as a table of facts does. */
  label: string;
  object: ObjectRef | null;
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
  EndpointSlice: "Endpoints",
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
 * Where the scheduler put it.
 *
 * Only ever read outwards, from a pod to its node. The mirror — a Node's own
 * page listing the pods on it — is not offered: `get_resource_connections`
 * resolves a missing namespace to `default`, so a cluster-scoped subject
 * would come back with whatever happens to live there and draw that as the
 * whole answer.
 */
function placement(conns: ResourceConnections): ConnGroup | null {
  const edges = verb(conns.edges, "runsOn");
  if (edges.length === 0) return null;
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
export function connectionGroups(conns: ResourceConnections): ConnGroup[] {
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
    // Only for the kinds that take part in ownership at all. "Controlled by:
    // nothing" is a real answer on a Deployment and a non-sequitur on a
    // ConfigMap, which no controller was ever going to have made.
    OWNABLE.has(conns.subject.kind)
      ? {
          key: "owners",
          title: "Made by, and makes",
          caption: null,
          rows: madeByAndMakes(conns),
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

/** How many distinct objects the tab draws — what its count mark stands for. */
export function connectionCount(conns: ResourceConnections): number {
  return unique(
    connectionGroups(conns)
      .flatMap((group) => group.rows)
      .map((row) => row.object)
      .filter((object): object is ObjectRef => object !== null)
  ).length;
}
