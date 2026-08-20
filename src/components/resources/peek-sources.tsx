import type { ReactNode } from "react";
import { load as parseYaml } from "js-yaml";

import {
  CopyableAddress,
  CopyableAddresses,
  CopyableValue,
} from "@/components/ui/copyable-value";
import { ClickableServicePort } from "@/components/ui/clickable-port";
import { commands } from "@/lib/commands";
import {
  declaredContainers,
  podReadiness,
  PHASE_LABEL,
  type ContainerLists,
} from "@/lib/container-sequence";
import { parseCPU, parseMemory, parseQuantity } from "@/lib/k8s-quantity";
import { formatQuantity } from "@/lib/metric-format";
import { nodePlacement, statesPlacement } from "@/lib/node-pool";
import { describeRestarts } from "@/lib/pod-status";
import { formatDate } from "@/lib/utils";
import {
  getApiVersion,
  toKind,
  type ResourceKind,
} from "@/lib/resource-registry";
import { vendorPeek } from "@/integrations";
import { ImageRef } from "./ImageRef";
import { ResourceRef } from "./ResourceRef";
import { ClaimRef } from "./storage-refs";
import { conditionRole } from "@/lib/condition-health";
import type { StatusRole } from "@/lib/status-role";
import type { PeekTarget } from "@/hooks/usePeek";
import type { KeyValue, KeyValueTone } from "./key-values";
import type {
  ConditionInfo,
  ContainerPhase,
  CustomResourceDetailInfo,
  NodeInfo,
  RouteInfo,
} from "@/generated/types";

/**
 * What each kind says about itself in the peek's Overview tab.
 *
 * Kind to the command its detail page already uses, plus the handful of rows
 * that page leads with. Anything missing here falls back to the raw manifest,
 * which every kind answers.
 */

export interface PeekGroup {
  title: string;
  count?: ReactNode;
  items: KeyValue[];
  emptyMessage?: string;
}

export interface PeekSummary {
  /** Drives the header badge; leave unset where the API reports no state. */
  status?: string | null;
  createdAt?: string | null;
  /** For the kinds whose API hands back a rendered age instead of a stamp. */
  age?: string | null;
  groups: PeekGroup[];
}

interface PeekSource {
  fetch: (name: string, namespace: string | null) => Promise<unknown>;
  summarise: (data: unknown, target: PeekTarget) => PeekSummary;
}

function source<T>(
  fetch: (name: string, namespace: string | null) => Promise<T>,
  summarise: (data: T, target: PeekTarget) => PeekSummary
): PeekSource {
  return { fetch, summarise: (data, target) => summarise(data as T, target) };
}

/** A condition, in the reason-first wording every condition row speaks. */
function conditionItem(condition: ConditionInfo): KeyValue {
  const role = conditionRole(condition);
  const spoken = [
    condition.status,
    condition.reason && condition.reason !== condition.type
      ? condition.reason
      : null,
  ]
    .filter(Boolean)
    .join(" — ");
  return {
    label: condition.type,
    value:
      role !== "ok" && condition.message
        ? `${spoken}: ${condition.message}`
        : spoken,
    mono: true,
    tone: ROLE_TONE[role],
  };
}

/**
 * One reading for the five route kinds — the object is one shape, and a
 * peek that flattened it to dotted paths said nothing a person could act
 * on. Parents up, backends down, the controllers' verdicts in their own
 * polarity-aware tones, every name a peek and every port a forward.
 */
function gatewayRouteSource(kind: string): PeekSource {
  return source(
    (name, namespace) => commands.getGatewayRoute(kind, name, namespace),
    (route: RouteInfo) => {
      const verdicts = route.parents.flatMap((parent) => parent.conditions);
      const refused = verdicts.some(
        (c) => c.type === "Accepted" && c.status === "False"
      );
      const accepted = verdicts.some(
        (c) => c.type === "Accepted" && c.status === "True"
      );
      const redirectOnly =
        route.rules.length > 0 && route.rules.every((rule) => rule.hasRedirect);
      return {
        status: refused ? "Refused" : accepted ? "Accepted" : undefined,
        createdAt: route.createdAt,
        groups: [
          {
            title: "Serves",
            items: [
              {
                label: "Hostnames",
                value: (
                  <CopyableAddresses
                    values={route.hostnames}
                    label="Hostname"
                    empty="all hosts the listener serves"
                  />
                ),
              },
            ],
          },
          {
            title: "Parents",
            count: route.parentRefs.length || undefined,
            items: route.parentRefs.map((parent) => ({
              label: parent.kind,
              value:
                parent.kind === "Gateway" ? (
                  <span className="inline-flex flex-wrap items-baseline gap-x-1">
                    {ref(
                      "Gateway",
                      parent.name,
                      parent.namespace ?? route.namespace
                    )}
                    {parent.sectionName && (
                      <span className="text-fg-fnt">:{parent.sectionName}</span>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex flex-wrap items-baseline gap-x-1">
                    {ref(
                      parent.kind,
                      parent.name,
                      parent.namespace ?? route.namespace
                    )}
                    <span className="text-fg-fnt">— mesh (GAMMA)</span>
                  </span>
                ),
            })),
            emptyMessage:
              "No parentRefs — this route attaches to nothing and serves no traffic.",
          },
          {
            title: "Backends",
            items: route.rules.flatMap((rule) =>
              rule.backendRefs.map((backend): KeyValue => {
                const at = backend.namespace ?? route.namespace;
                return {
                  label: backend.kind,
                  value:
                    backend.kind === "Service" ? (
                      <span className="inline-flex flex-wrap items-baseline gap-x-1">
                        {ref("Service", backend.name, at)}
                        {backend.port != null && (
                          <ClickableServicePort
                            prefix=":"
                            port={backend.port}
                            serviceName={backend.name}
                            namespace={at}
                            className="text-xs"
                          />
                        )}
                        {backend.weight != null && (
                          <span className="text-fg-fnt">
                            · weight {backend.weight}
                          </span>
                        )}
                      </span>
                    ) : (
                      `${backend.kind} ${backend.name}`
                    ),
                };
              })
            ),
            emptyMessage: redirectOnly
              ? "Redirects — no backends, and none needed."
              : "No backendRefs — a matched request has nowhere to go.",
          },
          {
            title: "Verdicts",
            items: route.parents.flatMap((entry) =>
              entry.conditions.map(conditionItem)
            ),
            emptyMessage:
              "No controller wrote status — nothing serves this route.",
          },
        ],
      };
    }
  );
}

const ref = (kind: string, name: string, namespace?: string | null) => (
  <ResourceRef kind={kind} name={name} namespace={namespace} showKind={false} />
);

/**
 * Typed by what it reads rather than by either owner-reference shape: the
 * generated `OwnerReference` spells its fields with underscores and
 * `OwnerReferenceInfo` spells them in camel case, and this needs neither of
 * the two fields they disagree about.
 */
function controlledBy(
  owners: ReadonlyArray<{ kind: string; name: string }> | undefined,
  namespace: string | null
): PeekGroup[] {
  if (!owners?.length) return [];
  return [
    {
      title: "Controlled by",
      items: owners.map((owner) => ({
        label: owner.kind,
        value: ref(owner.kind, owner.name, namespace),
      })),
    },
  ];
}

/**
 * Every image the thing runs, in run order, each row saying which kind of
 * container it belongs to.
 *
 * Given the lists rather than an array, because `images(x.containers)` is
 * precisely how this group came to leave out a mesh proxy on all five
 * workload kinds. There is no room for the sequence UI in a peek row, so
 * the phase arrives as the word beside the name that the pod's Containers
 * tab prints for the same reason: without it, a reader counting three
 * images cannot tell which one their pod is actually serving from.
 */
function images(
  lists: ContainerLists<{ name: string; image: string; phase: ContainerPhase }>
): PeekGroup[] {
  const containers = declaredContainers(lists);
  if (!containers.length) return [];
  return [
    {
      title: "Images",
      count: containers.length > 1 ? containers.length : undefined,
      items: containers.map((container) => ({
        label: (
          <>
            {container.name}
            {PHASE_LABEL[container.phase] && (
              <span className="ml-1.5 text-[9px] uppercase tracking-[0.04em] text-fg-fnt">
                {PHASE_LABEL[container.phase]}
              </span>
            )}
          </>
        ),
        value: <ImageRef image={container.image} />,
      })),
    },
  ];
}

/**
 * A requests/limits value the way a person reads it: "268435456" is a
 * manifest's spelling, "256Mi" is an answer. Anything unparseable is shown
 * as written — the author's words beat a guess.
 */
function prettyQuantity(
  value: string | null,
  kind: "cpu" | "memory"
): string | null {
  if (!value) return null;
  if (parseQuantity(value) === null) return value;
  return formatQuantity(
    kind === "cpu" ? parseCPU(value) : parseMemory(value),
    kind
  );
}

const list = (values: string[], empty = "—") =>
  values.length ? values.join(" · ") : empty;

/**
 * What a managed cluster already says about the machine under a node: which
 * pool made it, what it is, where it sits, and whether it can be taken back.
 *
 * The Nodes list groups by these and the Node page states them; a peek is
 * where most readers meet a node first, so it says them too — through
 * `node-pool`, which is where the vendors' spellings are reached from, rather
 * than by reading a label key here.
 *
 * Absent when nothing states any of it. A k3d or bare-metal node is not "not
 * spot" and has no pool of "none"; it is a cluster nobody here recognises,
 * and the honest form of that is silence.
 */
function placement(node: NodeInfo): PeekGroup[] {
  const facts = nodePlacement(node);
  if (!statesPlacement(facts)) return [];

  return [
    {
      title: "Placement",
      items: [
        ...(facts.pool
          ? [{ label: "Pool", value: facts.pool, mono: true }]
          : []),
        ...(facts.machine
          ? [{ label: "Instance type", value: facts.machine, mono: true }]
          : []),
        ...(facts.zone
          ? [{ label: "Zone", value: facts.zone, mono: true }]
          : []),
        ...(facts.region
          ? [{ label: "Region", value: facts.region, mono: true }]
          : []),
        // Only ever set by a label that says so, and worth the one warn
        // colour on the panel: a node that can vanish on an hour's notice
        // changes what every pod listed under it means.
        ...(facts.spot
          ? [
              {
                label: "Spot",
                value:
                  "The cloud can take this node back at any time. Pods leaving here are the arrangement, not a fault.",
                tone: "warn" as const,
              },
            ]
          : []),
        // From `providerID`'s scheme and nothing else — a pool label can be
        // typed by anyone; this is the cloud signing its work.
        ...(facts.cloud ? [{ label: "Cloud", value: facts.cloud }] : []),
      ],
    },
  ];
}

const workloadStatus = (ready: number, desired: number) =>
  desired > 0 && ready >= desired ? "Ready" : "Progressing";

const SOURCES: Partial<Record<ResourceKind, PeekSource>> = {
  // What other objects ask of a namespace: whether it is Active, and the
  // labels every namespaceSelector — a listener's allowedRoutes included —
  // matches against.
  Namespace: source(
    (name) => commands.getNamespace(name),
    (ns) => ({
      status: ns.status,
      createdAt: ns.createdAt,
      groups: [
        {
          title: "Labels",
          count: Object.keys(ns.labels).length || undefined,
          items: Object.entries(ns.labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([label, value]) => ({ label, value, mono: true })),
          emptyMessage:
            "No labels — no namespaceSelector anywhere matches this namespace.",
        },
      ],
    })
  ),
  Gateway: source(commands.getGateway, (gateway) => {
    const programmed =
      gateway.conditions.find((c) => c.type === "Programmed") ??
      gateway.conditions.find((c) => c.type === "Ready");
    return {
      status:
        programmed?.status === "True"
          ? "Programmed"
          : (programmed?.reason ?? undefined),
      createdAt: gateway.createdAt,
      groups: [
        {
          title: "Gateway",
          items: [
            { label: "Class", value: ref("GatewayClass", gateway.className) },
            {
              label: "Addresses",
              value: (
                <CopyableAddresses
                  values={gateway.addresses}
                  label="Gateway address"
                  empty="none published"
                />
              ),
            },
          ],
        },
        {
          title: "Listeners",
          count: gateway.listeners.length || undefined,
          items: gateway.listeners.map((listener) => {
            const broken = listener.conditions.find(
              (c) => c.status === "False"
            );
            const address = gateway.addresses[0];
            return {
              label: listener.name,
              value: (
                <span className="inline-flex flex-wrap items-baseline gap-x-1 font-mono">
                  {address ? (
                    // The dialable pair rides the click; the label stays
                    // the listener's own :port.
                    <CopyableValue
                      value={`${address}:${listener.port}`}
                      label={`Copy ${address}:${listener.port}`}
                      quietMark
                    >
                      :{listener.port}
                    </CopyableValue>
                  ) : (
                    <>:{listener.port}</>
                  )}{" "}
                  {listener.protocol}
                  {listener.hostname && (
                    <CopyableValue
                      value={listener.hostname}
                      label={`Listener hostname ${listener.hostname}`}
                      quietMark
                    />
                  )}
                  {listener.attachedRoutes != null && (
                    <span className="font-sans text-fg-fnt">
                      · {listener.attachedRoutes} route
                      {listener.attachedRoutes === 1 ? "" : "s"}
                    </span>
                  )}
                  {broken && (
                    <span className="text-err">
                      — {broken.reason ?? "broken"}
                    </span>
                  )}
                </span>
              ),
              tone: broken ? ("err" as const) : undefined,
            };
          }),
          emptyMessage:
            "No listeners — this Gateway accepts no traffic, and no route can attach to it.",
        },
        {
          title: "Conditions",
          items: gateway.conditions.map(conditionItem),
          emptyMessage: "No controller has written conditions yet.",
        },
      ],
    };
  }),
  GatewayClass: source(
    (name) => commands.getGatewayClass(name),
    (cls) => ({
      status:
        cls.accepted === true
          ? "Claimed"
          : cls.accepted === false
            ? "Refused"
            : "Unclaimed",
      createdAt: cls.createdAt,
      groups: [
        {
          title: "GatewayClass",
          items: [
            { label: "Controller", value: cls.controllerName, mono: true },
            {
              label: "Claim",
              value:
                cls.accepted === true
                  ? `claimed by ${cls.controllerName}`
                  : cls.accepted === false
                    ? `refused by ${cls.controllerName}`
                    : "no controller has answered — everything through this class is dead",
              tone:
                cls.accepted === true
                  ? undefined
                  : cls.accepted === false
                    ? ("err" as const)
                    : ("warn" as const),
            },
            ...(cls.description
              ? [{ label: "Description", value: cls.description }]
              : []),
          ],
        },
      ],
    })
  ),
  HTTPRoute: gatewayRouteSource("HTTPRoute"),
  GRPCRoute: gatewayRouteSource("GRPCRoute"),
  TLSRoute: gatewayRouteSource("TLSRoute"),
  TCPRoute: gatewayRouteSource("TCPRoute"),
  UDPRoute: gatewayRouteSource("UDPRoute"),
  Pod: source(commands.getPod, (pod) => {
    const readiness = podReadiness(pod);
    return {
      status: pod.status.display,
      createdAt: pod.createdAt,
      groups: [
        {
          title: "Placement",
          items: [
            {
              label: "Node",
              value: pod.nodeName ? ref("Node", pod.nodeName) : "unscheduled",
              tone: pod.nodeName ? undefined : "warn",
            },
            {
              label: "Pod IP",
              value: <CopyableAddress value={pod.podIp} label="Pod IP" />,
            },
            {
              label: "Restarts",
              value: describeRestarts(pod),
              tone: pod.restartCount > 0 ? "warn" : undefined,
            },
            {
              label: "Containers",
              value: `${readiness.ready} of ${readiness.total} ready`,
              tone: readiness.allReady ? undefined : "warn",
            },
            // Only when it disagrees with the badge above. `Phase Running`
            // under a `Running` badge is the same word twice; `Phase
            // Running` under `CrashLoopBackOff` is the fact an SRE came for.
            ...(pod.status.phase !== pod.status.display
              ? [{ label: "Phase", value: pod.status.phase, mono: true }]
              : []),
            ...(pod.status.message || pod.status.reason
              ? [
                  {
                    label: "Reason",
                    value: pod.status.message || pod.status.reason || "",
                    tone: "err" as const,
                  },
                ]
              : []),
          ],
        },
        ...controlledBy(pod.ownerReferences, pod.namespace),
        // Every image, init and sidecar included: "which proxy build was
        // injected into this pod" is a question asked of this row, and the
        // app container's image never answers it.
        ...images(pod),
        {
          title: "Requests and limits",
          items: [
            {
              label: "CPU",
              value: `${prettyQuantity(pod.cpuRequests, "cpu") ?? "—"} → ${prettyQuantity(pod.cpuLimits, "cpu") ?? "unlimited"}`,
              mono: true,
            },
            {
              label: "Memory",
              value: `${prettyQuantity(pod.memoryRequests, "memory") ?? "—"} → ${prettyQuantity(pod.memoryLimits, "memory") ?? "unlimited"}`,
              mono: true,
            },
          ],
        },
      ],
    };
  }),

  Deployment: source(commands.getDeployment, (deployment) => ({
    status: workloadStatus(
      deployment.replicas.ready,
      deployment.replicas.desired
    ),
    createdAt: deployment.createdAt,
    groups: [
      {
        title: "Rollout",
        items: [
          {
            label: "Replicas",
            value: `${deployment.replicas.ready} of ${deployment.replicas.desired} ready`,
            tone:
              deployment.replicas.ready < deployment.replicas.desired
                ? "warn"
                : undefined,
          },
          { label: "Updated", value: deployment.replicas.updated, mono: true },
          {
            label: "Available",
            value: deployment.replicas.available,
            mono: true,
          },
          { label: "Strategy", value: deployment.strategy || "—" },
        ],
      },
      ...controlledBy(deployment.ownerReferences, deployment.namespace),
      ...images(deployment),
    ],
  })),

  StatefulSet: source(commands.getStatefulset, (set) => ({
    status: workloadStatus(set.replicas.ready, set.replicas.desired),
    createdAt: set.createdAt,
    groups: [
      {
        title: "Replicas",
        items: [
          {
            label: "Ready",
            value: `${set.replicas.ready} of ${set.replicas.desired}`,
            tone:
              set.replicas.ready < set.replicas.desired ? "warn" : undefined,
          },
          { label: "Current", value: set.replicas.current, mono: true },
          {
            label: "Service",
            value: set.serviceName
              ? ref("Service", set.serviceName, set.namespace)
              : "—",
          },
          { label: "Update strategy", value: set.updateStrategy || "—" },
        ],
      },
      ...images(set),
    ],
  })),

  DaemonSet: source(commands.getDaemonset, (set) => ({
    status: workloadStatus(set.ready, set.desired),
    createdAt: set.createdAt,
    groups: [
      {
        title: "Scheduling",
        items: [
          {
            label: "Ready",
            value: `${set.ready} of ${set.desired} nodes`,
            tone: set.ready < set.desired ? "warn" : undefined,
          },
          { label: "Current", value: set.current, mono: true },
          { label: "Up to date", value: set.upToDate, mono: true },
          { label: "Available", value: set.available, mono: true },
          { label: "Update strategy", value: set.updateStrategy || "—" },
        ],
      },
      ...images(set),
    ],
  })),

  Job: source(commands.getJob, (job) => ({
    status: job.status,
    createdAt: job.createdAt,
    groups: [
      {
        title: "Progress",
        items: [
          {
            label: "Succeeded",
            value: `${job.succeeded} of ${job.completions ?? 1}`,
          },
          {
            label: "Failed",
            value: job.failed,
            mono: true,
            tone: job.failed > 0 ? "err" : undefined,
          },
          { label: "Active", value: job.active, mono: true },
          {
            label: "Backoff limit",
            value: job.backoffLimit ?? "—",
            mono: true,
          },
          { label: "Started", value: formatDate(job.startTime) ?? "—" },
          { label: "Completed", value: formatDate(job.completionTime) ?? "—" },
        ],
      },
      ...controlledBy(job.ownerReferences, job.namespace),
      ...images(job),
    ],
  })),

  CronJob: source(commands.getCronjob, (cron) => ({
    status: cron.suspend ? "Suspended" : "Active",
    createdAt: cron.createdAt,
    groups: [
      {
        title: "Schedule",
        items: [
          { label: "Schedule", value: cron.schedule, mono: true },
          { label: "Time zone", value: cron.timezone || "cluster local" },
          {
            label: "Last run",
            value: formatDate(cron.lastSchedule) ?? "never",
          },
          {
            label: "Last success",
            value: formatDate(cron.lastSuccessfulTime) ?? "never",
          },
          { label: "Active jobs", value: cron.active, mono: true },
          { label: "Concurrency", value: cron.concurrencyPolicy || "Allow" },
        ],
      },
      ...images(cron),
    ],
  })),

  ConfigMap: source(commands.getConfigmap, (configMap) => ({
    createdAt: configMap.createdAt,
    groups: [
      {
        title: "Data",
        count: configMap.dataKeys.length,
        items: configMap.dataKeys.map((key) => ({
          label: key,
          value: "",
          mono: true,
        })),
        emptyMessage: "No keys",
      },
    ],
  })),

  Secret: source(commands.getSecret, (secret) => ({
    createdAt: secret.createdAt,
    groups: [
      {
        title: "Type",
        items: [{ label: "Type", value: secret.type, mono: true }],
      },
      {
        // Names only. A peek is read over someone's shoulder; the values
        // stay behind the detail page's explicit reveal.
        title: "Keys",
        count: secret.dataKeys.length,
        items: secret.dataKeys.map((key) => ({
          label: key,
          value: "",
          mono: true,
        })),
        emptyMessage: "No keys",
      },
    ],
  })),

  Service: source(commands.getService, (service) => ({
    createdAt: service.createdAt,
    groups: [
      {
        title: "Routing",
        items: [
          { label: "Type", value: service.type },
          {
            label: "Cluster IP",
            value: (
              <CopyableAddress
                value={service.clusterIp}
                label="Cluster IP"
                fallback="none"
              />
            ),
          },
          {
            label: "Ports",
            value: list(
              service.ports.map(
                (port) => `${port.port}→${port.targetPort}/${port.protocol}`
              )
            ),
            mono: true,
          },
          {
            label: "External",
            value: (
              <CopyableAddresses
                values={[...service.externalIps, ...service.loadBalancerIps]}
                label="External address"
              />
            ),
          },
          {
            label: "Selector",
            value: list(
              Object.entries(service.selector).map(
                ([key, value]) => `${key}=${value}`
              ),
              "none — endpoints are managed by hand"
            ),
            mono: true,
          },
        ],
      },
    ],
  })),

  Ingress: source(commands.getIngress, (ingress, target) => ({
    createdAt: ingress.createdAt,
    groups: [
      {
        title: "Routing",
        items: [
          { label: "Class", value: ingress.className || "cluster default" },
          {
            label: "Address",
            // The empty state keeps its own tone, so it stays plain text
            // rather than the component's faint fallback.
            value: ingress.loadBalancerIps.length ? (
              <CopyableAddresses
                values={ingress.loadBalancerIps}
                label="Ingress address"
              />
            ) : (
              "not assigned yet"
            ),
            tone: ingress.loadBalancerIps.length ? undefined : "warn",
          },
          {
            label: "TLS hosts",
            value: list(ingress.tlsHosts, "none"),
            mono: true,
          },
        ],
      },
      {
        title: "Rules",
        count: ingress.rules.length || undefined,
        items: [
          ...ingress.rules.flatMap((rule) =>
            rule.paths.map((path) => ({
              label: `${rule.host || "*"}${path.path}`,
              // The path is the label; the value is where it goes, and where
              // it goes is a Service in this ingress's own namespace.
              value: path.backendService ? (
                <>
                  {ref("Service", path.backendService, target.namespace)}
                  <span className="font-mono text-fg-fnt">
                    :{path.backendPort}
                  </span>
                </>
              ) : (
                "no backend"
              ),
            }))
          ),
          // The fallback is a rule too — for a rules-less Ingress it is the
          // whole object, and "No rules" over it was the peek calling a
          // working edge dead.
          ...(ingress.defaultBackend?.backendService
            ? [
                {
                  label: "anything unmatched",
                  value: (
                    <>
                      {ref(
                        "Service",
                        ingress.defaultBackend.backendService,
                        target.namespace
                      )}
                      <span className="font-mono text-fg-fnt">
                        :{ingress.defaultBackend.backendPort}
                      </span>
                    </>
                  ),
                },
              ]
            : []),
        ],
        emptyMessage: "No rules and no default backend",
      },
    ],
  })),

  Endpoints: source(commands.getEndpoints, (endpoints, target) => {
    const addresses = endpoints.subsets.flatMap((subset) => subset.addresses);
    const notReady = endpoints.subsets.flatMap(
      (subset) => subset.notReadyAddresses
    );
    return {
      status: addresses.length ? "Ready" : "Unavailable",
      createdAt: endpoints.createdAt,
      groups: [
        {
          title: "Backends",
          items: [
            { label: "Ready", value: addresses.length, mono: true },
            {
              label: "Not ready",
              value: notReady.length,
              mono: true,
              tone: notReady.length ? "warn" : undefined,
            },
            {
              label: "Ports",
              value: list(
                endpoints.subsets.flatMap((subset) =>
                  subset.ports.map((port) => `${port.port}/${port.protocol}`)
                )
              ),
              mono: true,
            },
          ],
        },
        {
          title: "Pods",
          count: addresses.length,
          items: addresses.slice(0, 8).map((address) => ({
            label: <CopyableAddress value={address.ip} label="Address" />,
            value: address.targetRef
              ? ref(
                  address.targetRef.kind,
                  address.targetRef.name,
                  target.namespace
                )
              : (address.hostname ?? "—"),
          })),
          emptyMessage: "Nothing is backing this service",
        },
      ],
    };
  }),

  PersistentVolumeClaim: source(commands.getPersistentVolumeClaim, (claim) => ({
    status: claim.status,
    age: claim.age,
    groups: [
      {
        title: "Storage",
        items: [
          {
            label: "Capacity",
            value: claim.capacity || "not provisioned yet",
            mono: !!claim.capacity,
            tone: claim.capacity ? undefined : "warn",
          },
          {
            label: "Volume",
            value: claim.volume
              ? ref("PersistentVolume", claim.volume)
              : "not bound",
            tone: claim.volume ? undefined : "warn",
          },
          {
            label: "Storage class",
            value: claim.storageClass
              ? ref("StorageClass", claim.storageClass)
              : "cluster default",
          },
          {
            label: "Access modes",
            value: list(claim.accessModes),
            mono: true,
          },
        ],
      },
    ],
  })),

  PersistentVolume: source(
    (name) => commands.getPersistentVolume(name),
    (volume) => ({
      status: volume.status,
      age: volume.age,
      groups: [
        {
          title: "Storage",
          items: [
            { label: "Capacity", value: volume.capacity, mono: true },
            {
              label: "Claim",
              // The detail page and the list have used `ClaimRef` here since
              // it existed; the peek was printing the same `ns/name` as text,
              // so the same fact carried a glyph on two screens and neither
              // on the third.
              value: volume.claim ? (
                <ClaimRef claim={volume.claim} />
              ) : (
                "unbound"
              ),
            },
            {
              label: "Storage class",
              value: volume.storageClass
                ? ref("StorageClass", volume.storageClass)
                : "none",
            },
            { label: "Reclaim policy", value: volume.reclaimPolicy },
            {
              label: "Access modes",
              value: list(volume.accessModes),
              mono: true,
            },
            ...(volume.reason
              ? [
                  {
                    label: "Reason",
                    value: volume.reason,
                    tone: "err" as const,
                  },
                ]
              : []),
          ],
        },
      ],
    })
  ),

  StorageClass: source(
    (name) => commands.getStorageClass(name),
    (storageClass) => ({
      age: storageClass.age,
      groups: [
        {
          title: "Provisioning",
          items: [
            {
              label: "Provisioner",
              value: storageClass.provisioner,
              mono: true,
            },
            { label: "Reclaim policy", value: storageClass.reclaimPolicy },
            { label: "Binding mode", value: storageClass.volumeBindingMode },
            {
              label: "Expansion",
              value: storageClass.allowVolumeExpansion
                ? "allowed"
                : "not allowed",
            },
            {
              label: "Default",
              value: storageClass.isDefault ? "yes" : "no",
            },
          ],
        },
      ],
    })
  ),

  Node: source(
    (name) => commands.getNode(name),
    (node) => ({
      status: node.status.ready ? "Ready" : "NotReady",
      createdAt: node.createdAt,
      groups: [
        {
          title: "Machine",
          items: [
            { label: "Roles", value: list(node.roles, "worker") },
            { label: "Kubelet", value: node.version, mono: true },
            { label: "Platform", value: `${node.os}/${node.arch}`, mono: true },
            { label: "Runtime", value: node.containerRuntime, mono: true },
            {
              label: "Internal IP",
              value: (
                <CopyableAddress
                  value={
                    node.status.addresses.find(
                      (address) => address.type === "InternalIP"
                    )?.address
                  }
                  label="Internal IP"
                />
              ),
            },
          ],
        },
        ...placement(node),
        {
          title: "Capacity",
          items: [
            { label: "CPU", value: node.allocatable.cpu ?? "—", mono: true },
            {
              label: "Memory",
              value: node.allocatable.memory ?? "—",
              mono: true,
            },
            { label: "Pods", value: node.allocatable.pods ?? "—", mono: true },
            {
              label: "Taints",
              value: node.taints.length
                ? list(node.taints.map((taint) => taint.key))
                : "none",
              mono: node.taints.length > 0,
              tone: node.taints.length ? "warn" : undefined,
            },
          ],
        },
      ],
    })
  ),

  CustomResourceDefinition: source(
    (name) => commands.getCrd(name),
    (crd) => ({
      createdAt: crd.createdAt,
      groups: [
        {
          title: "Definition",
          items: [
            { label: "Group", value: crd.group, mono: true },
            { label: "Kind", value: crd.kind, mono: true },
            { label: "Scope", value: crd.scope },
            {
              label: "Versions",
              value: list(
                crd.versions
                  .filter((version) => version.served)
                  .map((version) =>
                    version.storage ? `${version.name} (stored)` : version.name
                  )
              ),
              mono: true,
            },
            { label: "Short names", value: list(crd.shortNames, "none") },
          ],
        },
      ],
    })
  ),
};

export function resolveSource(target: PeekTarget): PeekSource {
  // A custom resource first, and never by kind: two CRDs may declare the same
  // kind in different groups, and the object being looked at is the one whose
  // CRD the reference named.
  if (target.crd) return customResourceSource(target.crd);
  const resolved = toKind(target.kind);
  const known = resolved ? SOURCES[resolved] : undefined;
  return known ?? manifestSource(resolved ?? target.kind);
}

/**
 * A custom resource, read through the CRD that defines it.
 *
 * The reason this is not {@link manifestSource} with a different argument:
 * `getManifest` is given an `apiVersion`, and the only one available for a
 * kind outside the registry is `getApiVersion`'s fallback of `v1`. That asks
 * the core API for an Argo Application and gets a 404 — the peek would have
 * been an error panel for every custom resource in the cluster. The backend
 * already resolves a CRD's real group and version from its name, which is
 * what the detail page has always used.
 *
 * `spec` and `status` are drawn the same way an unrecognised manifest's are:
 * scalars, dotted, capped. Nothing here reads a field by name, because the
 * whole population of this source is kinds this app has no schema for — and a
 * peek that understood Argo's `status.health` would be vendor knowledge in
 * the core, which is what the integrations seam exists to prevent.
 */
function customResourceSource(crdName: string): PeekSource {
  // A kind the vendor tree owns gets the vendor's own reading — the same
  // parser its routing page trusts — in place of the flattened spec. The
  // shell rows stay core either way: what controls it, and its labels.
  const vendor = vendorPeek(crdName);
  return source(
    (name, namespace) => commands.getCustomResource(crdName, name, namespace),
    (resource: CustomResourceDetailInfo) => {
      const status = resource.status as Record<string, unknown> | null;
      const body = vendor?.(resource);
      return {
        status: body?.status ?? customResourceState(status),
        createdAt: resource.createdAt,
        groups: [
          ...controlledBy(resource.ownerReferences, resource.namespace),
          ...(body?.groups ?? [
            {
              title: "Status",
              items: flatten(status, MANIFEST_ROW_LIMIT),
              emptyMessage: "Nothing reported yet",
            },
            {
              title: "Spec",
              items: flatten(resource.spec, MANIFEST_ROW_LIMIT),
              emptyMessage: "No spec",
            },
          ]),
          {
            title: "Labels",
            count: Object.keys(resource.labels).length || undefined,
            items: Object.entries(resource.labels)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([label, value]) => ({ label, value, mono: true })),
            emptyMessage: "No labels",
          },
        ],
      };
    }
  );
}

/**
 * The one word for the header badge, from the two places an operator is
 * likely to have put one.
 *
 * `phase` and `state` are the conventional free-form fields; `conditions` is
 * the upstream `metav1.Condition` shape, and a `Ready` condition is the
 * nearest thing to a universal verdict a custom resource has. Anything else
 * is left unsaid rather than guessed — an operator that reports health under
 * a name of its own gets no badge, and the flattened status underneath is
 * where the reader finds it.
 */
function customResourceState(
  status: Record<string, unknown> | null
): string | undefined {
  if (!status) return undefined;
  const said = asText(status.phase) ?? asText(status.state);
  if (said) return said;

  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const ready = conditions.find(
    (condition): condition is { type: string; status: string } =>
      typeof condition === "object" &&
      condition !== null &&
      (condition as { type?: unknown }).type === "Ready"
  );
  if (!ready) return undefined;
  return ready.status === "True" ? "Ready" : "Not ready";
}

/**
 * The fallback every kind answers. The manifest arrives as YAML, and pasting
 * it into the panel would just be the YAML tab in a narrower column — so the
 * scalars under `status` and `spec` become rows, which is the part of a
 * manifest a reader actually scans for.
 */
function manifestSource(kind: string): PeekSource {
  return source(
    (name, namespace) =>
      commands.getManifest(kind, getApiVersion(kind), name, namespace),
    (text) => summariseManifest(text)
  );
}

const MANIFEST_ROW_LIMIT = 12;

function summariseManifest(text: string): PeekSummary {
  const manifest = parseYaml(text);
  if (!manifest || typeof manifest !== "object") {
    return {
      groups: [{ title: "Manifest", items: [], emptyMessage: "Empty" }],
    };
  }
  const record = manifest as Record<string, unknown>;
  const metadata = (record.metadata ?? {}) as Record<string, unknown>;
  const status = record.status as unknown;
  const labels = (metadata.labels ?? {}) as Record<string, string>;

  return {
    status:
      typeof status === "object" && status !== null
        ? (asText((status as Record<string, unknown>).phase) ??
          asText((status as Record<string, unknown>).state))
        : undefined,
    createdAt: asText(metadata.creationTimestamp) ?? null,
    groups: [
      {
        title: "Status",
        items: flatten(status, MANIFEST_ROW_LIMIT),
        emptyMessage: "Nothing reported yet",
      },
      {
        title: "Spec",
        items: flatten(record.spec, MANIFEST_ROW_LIMIT),
        emptyMessage: "No spec",
      },
      {
        title: "Labels",
        count: Object.keys(labels).length || undefined,
        items: Object.entries(labels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([label, value]) => ({ label, value, mono: true })),
        emptyMessage: "No labels",
      },
    ],
  };
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Scalar leaves, dotted, so a nested `status.conditions` does not explode. */
export function flatten(value: unknown, limit: number): KeyValue[] {
  const rows: KeyValue[] = [];
  walk(value, "", rows, limit);
  return rows;
}

/** The one shape the whole API machinery shares — enough to read as one. */
function isConditionList(
  path: string,
  value: unknown[]
): value is Array<Record<string, unknown>> {
  return (
    /(^|\.)conditions$/i.test(path) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).type === "string" &&
        typeof (entry as Record<string, unknown>).status === "string"
    )
  );
}

/** The five roles, folded to the tones a key-value row can carry —
 *  `neutral` deliberately stays uncoloured, and `pending` reads as info. */
const ROLE_TONE: Partial<Record<StatusRole, KeyValueTone>> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  pending: "info",
};

function walk(
  value: unknown,
  path: string,
  rows: KeyValue[],
  limit: number
): void {
  if (rows.length >= limit || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    const scalars = value.filter((entry) => typeof entry !== "object");
    if (scalars.length === value.length) {
      rows.push({ label: path, value: scalars.join(" · "), mono: true });
      return;
    }
    // A conditions array is verdicts, not data: one row per condition, in
    // the reason-first wording and polarity-aware tone every condition row
    // in the app already carries — instead of six grey fragments per entry.
    if (isConditionList(path, value)) {
      for (const entry of value.slice(0, limit - rows.length)) {
        const condition: ConditionInfo = {
          type: String(entry.type),
          status: String(entry.status),
          reason: typeof entry.reason === "string" ? entry.reason : null,
          message: typeof entry.message === "string" ? entry.message : null,
          lastTransitionTime: null,
        };
        const role = conditionRole(condition);
        const spoken = [
          condition.status,
          condition.reason && condition.reason !== condition.type
            ? condition.reason
            : null,
        ]
          .filter(Boolean)
          .join(" — ");
        rows.push({
          label: `${path}.${condition.type}`,
          value:
            role !== "ok" && condition.message
              ? `${spoken}: ${condition.message}`
              : spoken,
          mono: true,
          tone: ROLE_TONE[role],
        });
      }
      return;
    }
    // An array of objects is where a custom resource keeps the part anybody
    // opens it for — an IngressRoute's `routes` holds the match rule, the
    // service, the priority. Printed as "1 entries" the peek said nothing;
    // descended with indexed paths it says the thing itself, and the row
    // limit still caps how far that goes.
    value.forEach((child, index) => {
      walk(child, path ? `${path}.${index}` : String(index), rows, limit);
    });
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, rows, limit);
    }
    return;
  }
  rows.push({ label: path, value: String(value), mono: true });
}
