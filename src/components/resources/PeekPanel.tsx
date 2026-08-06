import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { load as parseYaml } from "js-yaml";
import { ExternalLink, Copy } from "lucide-react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Kbd } from "@/components/ui/kbd";
import {
  CopyableAddress,
  CopyableAddresses,
} from "@/components/ui/copyable-value";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { usePeek, type PeekTarget } from "@/hooks/usePeek";
import { commands } from "@/lib/commands";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { formatDate } from "@/lib/utils";
import {
  getApiVersion,
  toKind,
  type ResourceKind,
} from "@/lib/resource-registry";
import { DetailAction, EventRows } from "./detail-blocks";
import { KeyValueList } from "./detail-kv";
import { isRoutableKind, ResourceRef } from "./ResourceRef";
import type { KeyValue } from "./key-values";
import type { OwnerReference } from "@/generated/types";

/**
 * The right-hand drawer a reference opens.
 *
 * It answers "what is this object" without spending the page the reader is
 * already on. Mounted once at the shell; everything it needs is in `?peek=`,
 * so a nested reference just rewrites that parameter and browser back walks
 * out of the peeks it opened.
 */
export function PeekPanel() {
  const { target, close } = usePeek();
  // Radix animates the close, and a panel that empties halfway through the
  // slide reads as a bug. Keep the last target on screen until it is gone.
  const [previous, setPrevious] = useState<PeekTarget | null>(target);
  if (target && target !== previous) setPrevious(target);
  const shown = target ?? previous;

  return (
    <Sheet open={!!target} onOpenChange={(next) => !next && close()}>
      {shown && (
        <PeekContent
          key={`${shown.kind}/${shown.namespace ?? ""}/${shown.name}`}
          target={shown}
        />
      )}
    </Sheet>
  );
}

function PeekContent({ target }: { target: PeekTarget }) {
  const navigate = useNavigate();
  const copy = useCopyToClipboard();
  const contentRef = useRef<HTMLDivElement>(null);
  const namespace = target.namespace ?? null;

  const source = useMemo(() => resolveSource(target.kind), [target.kind]);

  const { data, error, isLoading } = useQuery({
    queryKey: ["peek", target.kind, namespace, target.name],
    queryFn: () => source.fetch(target.name, namespace),
    staleTime: STALE_TIMES.resourceDetail,
    refetchInterval: REFRESH_INTERVALS.resourceDetail,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const summary = useMemo(
    () => (data === undefined ? null : source.summarise(data, target)),
    [data, source, target]
  );

  const age = useRealtimeAge(summary?.createdAt ?? null);
  const routable = isRoutableKind(target.kind, namespace);
  const openFullPage = () =>
    navigate(getResourceDetailUrl(target.kind, target.name, namespace));

  // Enter is the panel's shortcut, not the focused control's — once the
  // reader has tabbed onto a button, that button owns the key.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || !routable) return;
    if (event.target !== contentRef.current) return;
    event.preventDefault();
    openFullPage();
  };

  return (
    <SheetContent
      ref={contentRef}
      side="right"
      onKeyDown={handleKeyDown}
      // Focus the panel itself rather than its close button, so Enter opens
      // the page and Escape closes without the reader aiming first.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        contentRef.current?.focus();
      }}
      aria-describedby={undefined}
      className="flex w-[440px] flex-col gap-0 p-0 sm:max-w-[440px]"
    >
      <header className="flex-none border-b border-hair px-3.5 pb-2.5 pt-3 pr-9">
        <SheetTitle className="flex min-w-0 items-center">
          <ResourceRef
            kind={target.kind}
            name={target.name}
            namespace={namespace}
            showKind={false}
            className="text-[13px] font-semibold"
          />
        </SheetTitle>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-mut">
          {summary?.status && <StatusBadge status={summary.status} />}
          <span>{target.kind}</span>
          {namespace && (
            <>
              <span className="text-fg-fnt">·</span>
              <span>{namespace}</span>
            </>
          )}
          {(summary?.createdAt || summary?.age) && (
            <>
              <span className="text-fg-fnt">·</span>
              <span>{summary.createdAt ? `${age} old` : summary.age}</span>
            </>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {routable && (
            <>
              <DetailAction
                label="Open full page"
                icon={ExternalLink}
                onClick={openFullPage}
              />
              <Kbd shortcut="enter" />
            </>
          )}
          <DetailAction
            label="Copy name"
            icon={Copy}
            onClick={() => copy(target.name, `${target.name} copied`)}
          />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3.5 pb-5">
        {error ? (
          <p className="pt-4 text-xs text-warn">
            Could not read this {target.kind.toLowerCase()}: {error.message}
          </p>
        ) : isLoading || !summary ? (
          <PeekSkeleton />
        ) : (
          summary.groups.map((group) => (
            <div key={group.title}>
              <PeekHeading title={group.title} count={group.count} />
              <KeyValueList
                items={group.items}
                emptyMessage={group.emptyMessage ?? "None"}
              />
            </div>
          ))
        )}
        <PeekEvents target={target} />
      </div>
    </SheetContent>
  );
}

function PeekHeading({ title, count }: { title: string; count?: ReactNode }) {
  return (
    <h3 className="flex items-baseline gap-1.5 pb-1 pt-4 text-[11px] font-semibold text-fg">
      {title}
      {count != null && (
        <span className="font-normal text-fg-fnt">{count}</span>
      )}
    </h3>
  );
}

function PeekSkeleton() {
  return (
    <div aria-hidden="true" data-testid="peek-skeleton">
      <PeekHeading title="Loading" />
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,132px)_minmax(0,1fr)] items-baseline gap-3 border-b border-hair py-[7px]"
        >
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="h-2.5 w-full" />
        </div>
      ))}
    </div>
  );
}

function PeekEvents({ target }: { target: PeekTarget }) {
  const { data: events, error } = useQuery({
    queryKey: [
      "peek-events",
      target.kind,
      target.namespace ?? null,
      target.name,
    ],
    queryFn: () =>
      commands.listEvents({
        namespace: target.namespace ?? null,
        involved_object_name: target.name,
        involved_object_kind: target.kind,
        event_type: null,
        field_selector: null,
        limit: 20,
      }),
    staleTime: STALE_TIMES.fast,
    refetchInterval: REFRESH_INTERVALS.overview,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <>
      <PeekHeading title="Recent events" count={events?.length || undefined} />
      {error ? (
        <p className="py-1 text-xs text-warn">Could not read events.</p>
      ) : !events ? (
        <Skeleton className="h-3 w-2/3" />
      ) : (
        <EventRows
          events={events}
          emptyMessage="No events for this object"
          compact
        />
      )}
    </>
  );
}

/* ---------- what each kind says about itself ---------- */

interface PeekGroup {
  title: string;
  count?: ReactNode;
  items: KeyValue[];
  emptyMessage?: string;
}

interface PeekSummary {
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

const ref = (kind: string, name: string, namespace?: string | null) => (
  <ResourceRef kind={kind} name={name} namespace={namespace} showKind={false} />
);

function controlledBy(
  owners: OwnerReference[] | undefined,
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

function images(containers: { name: string; image: string }[]): PeekGroup[] {
  if (!containers.length) return [];
  return [
    {
      title: "Images",
      count: containers.length > 1 ? containers.length : undefined,
      items: containers.map((container) => ({
        label: container.name,
        value: container.image,
        mono: true,
      })),
    },
  ];
}

const list = (values: string[], empty = "—") =>
  values.length ? values.join(" · ") : empty;

const workloadStatus = (ready: number, desired: number) =>
  desired > 0 && ready >= desired ? "Ready" : "Progressing";

/**
 * Kind to the command its detail page already uses, plus the handful of rows
 * that page leads with. Anything missing here falls back to the raw manifest,
 * which every kind answers.
 */
const SOURCES: Partial<Record<ResourceKind, PeekSource>> = {
  Pod: source(commands.getPod, (pod) => ({
    status: pod.status.phase,
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
            value: pod.restartCount,
            mono: true,
            tone: pod.restartCount > 0 ? "warn" : undefined,
          },
          {
            label: "Containers",
            value: `${pod.containers.filter((c) => c.ready).length} of ${pod.containers.length} ready`,
            tone: pod.containers.some((c) => !c.ready) ? "warn" : undefined,
          },
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
      ...images(pod.containers),
      {
        title: "Requests and limits",
        items: [
          {
            label: "CPU",
            value: `${pod.cpuRequests || "—"} → ${pod.cpuLimits || "unlimited"}`,
            mono: true,
          },
          {
            label: "Memory",
            value: `${pod.memoryRequests || "—"} → ${pod.memoryLimits || "unlimited"}`,
            mono: true,
          },
        ],
      },
    ],
  })),

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
      ...images(deployment.containers),
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
      ...images(set.containers),
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
      ...images(set.containers),
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
      ...images(job.containers),
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
      ...images(cron.containers),
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

  Ingress: source(commands.getIngress, (ingress) => ({
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
        count: ingress.rules.length,
        items: ingress.rules.flatMap((rule) =>
          rule.paths.map((path) => ({
            label: `${rule.host || "*"}${path.path}`,
            value: `${path.backendService}:${path.backendPort}`,
            mono: true,
          }))
        ),
        emptyMessage: "No rules",
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
            { label: "Claim", value: volume.claim || "unbound", mono: true },
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

function resolveSource(kind: string): PeekSource {
  const resolved = toKind(kind);
  const known = resolved ? SOURCES[resolved] : undefined;
  return known ?? manifestSource(resolved ?? kind);
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
function flatten(value: unknown, limit: number): KeyValue[] {
  const rows: KeyValue[] = [];
  walk(value, "", rows, limit);
  return rows;
}

function walk(
  value: unknown,
  path: string,
  rows: KeyValue[],
  limit: number
): void {
  if (rows.length >= limit || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    const scalars = value.filter((entry) => typeof entry !== "object");
    rows.push({
      label: path,
      value:
        scalars.length === value.length
          ? scalars.join(" · ")
          : `${value.length} entries`,
      mono: true,
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
