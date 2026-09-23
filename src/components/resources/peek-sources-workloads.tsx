import { workloadStatus } from "@/lib/workload-status";

import { CopyableAddress } from "@/components/ui/copyable-value";
import { commands } from "@/lib/commands";
import {
  declaredContainers,
  podReadiness,
  PHASE_LABEL,
  type ContainerLists,
} from "@/lib/container-sequence";
import { parseCPU, parseMemory, parseQuantity } from "@/lib/k8s-quantity";
import { formatQuantity } from "@/lib/metric-format";
import { describeRestarts } from "@/lib/pod-status";
import { formatDate } from "@/lib/utils";
import { ImageRef } from "./ImageRef";
import type { T as Translate } from "@/i18n/useT";
import type { ContainerPhase } from "@/generated/types";
import {
  controlledBy,
  ref,
  source,
  type PeekGroup,
  type PeekSources,
} from "./peek-sources-kit";

/**
 * Every image the thing runs, in run order, each row saying which kind of
 * container it belongs to.
 *
 * Given the lists rather than an array: `images(x.containers, t)` is precisely
 * how this group came to leave out a mesh proxy on all five workload kinds.
 * There is no room for the sequence UI in a peek row, so the phase arrives as
 * the word beside the name that the pod's Containers tab prints, without which
 * a reader counting three images cannot tell which one their pod is serving
 * from.
 */
function images(
  lists: ContainerLists<{ name: string; image: string; phase: ContainerPhase }>,
  t: Translate
): PeekGroup[] {
  const containers = declaredContainers(lists);
  if (!containers.length) return [];
  return [
    {
      title: t("columns", "images"),
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

export const WORKLOAD_SOURCES: PeekSources = {
  Pod: source(commands.getPod, (pod, _target, t) => {
    const readiness = podReadiness(pod);
    return {
      status: pod.status.display,
      statusFrom: pod.nodeName,
      createdAt: pod.createdAt,
      groups: [
        {
          title: t("columns", "placement"),
          items: [
            {
              label: t("columns", "node"),
              value: pod.nodeName ? ref("Node", pod.nodeName) : "unscheduled",
              tone: pod.nodeName ? undefined : "warn",
            },
            {
              label: t("columns", "podIp"),
              value: (
                <CopyableAddress
                  value={pod.podIp}
                  label={t("columns", "podIp")}
                />
              ),
            },
            {
              label: t("columns", "restarts"),
              value: describeRestarts(pod, t),
              tone: pod.restartCount > 0 ? "warn" : undefined,
            },
            {
              label: t("columns", "containers"),
              value: t("count", "readyOfTotal", {
                ready: readiness.ready,
                total: readiness.total,
              }),
              tone: readiness.allReady ? undefined : "warn",
            },
            // Only when it disagrees with the badge above. `Phase Running`
            // under a `Running` badge is the same word twice; `Phase
            // Running` under `CrashLoopBackOff` is the fact an SRE came for.
            ...(pod.status.phase !== pod.status.display
              ? [
                  {
                    label: t("columns", "phase"),
                    value: pod.status.phase,
                    mono: true,
                  },
                ]
              : []),
            ...(pod.status.message || pod.status.reason
              ? [
                  {
                    label: t("columns", "reason"),
                    value: pod.status.message || pod.status.reason || "",
                    tone: "err" as const,
                  },
                ]
              : []),
          ],
        },
        ...controlledBy(pod.ownerReferences, pod.namespace, t),
        // Every image, init and sidecar included: "which proxy build was
        // injected into this pod" is a question asked of this row, and the
        // app container's image never answers it.
        ...images(pod, t),
        {
          title: t("columns", "requestsAndLimits"),
          items: [
            {
              label: "CPU",
              value: `${prettyQuantity(pod.cpuRequests, "cpu") ?? "—"} → ${prettyQuantity(pod.cpuLimits, "cpu") ?? t("empty", "unlimited")}`,
              mono: true,
            },
            {
              label: t("columns", "memory"),
              value: `${prettyQuantity(pod.memoryRequests, "memory") ?? "—"} → ${prettyQuantity(pod.memoryLimits, "memory") ?? t("empty", "unlimited")}`,
              mono: true,
            },
          ],
        },
      ],
    };
  }),

  Deployment: source(commands.getDeployment, (deployment, _target, t) => ({
    status: workloadStatus(deployment.replicas),
    createdAt: deployment.createdAt,
    groups: [
      {
        title: t("columns", "rollout"),
        items: [
          {
            label: t("columns", "replicas"),
            value: t("count", "readyOfTotal", {
              ready: deployment.replicas.ready,
              total: deployment.replicas.desired,
            }),
            tone:
              deployment.replicas.ready < deployment.replicas.desired
                ? "warn"
                : undefined,
          },
          {
            label: t("columns", "updated"),
            value: deployment.replicas.updated,
            mono: true,
          },
          {
            label: t("settings", "available"),
            value: deployment.replicas.available,
            mono: true,
          },
          {
            label: t("columns", "strategy"),
            value: deployment.strategy || "—",
          },
        ],
      },
      ...controlledBy(deployment.ownerReferences, deployment.namespace, t),
      ...images(deployment, t),
    ],
  })),

  StatefulSet: source(commands.getStatefulset, (set, _target, t) => ({
    status: workloadStatus(set.replicas),
    createdAt: set.createdAt,
    groups: [
      {
        title: t("columns", "replicas"),
        items: [
          {
            label: t("columns", "ready"),
            value: t("count", "nOfTotal", {
              n: set.replicas.ready,
              total: set.replicas.desired,
            }),
            tone:
              set.replicas.ready < set.replicas.desired ? "warn" : undefined,
          },
          {
            label: t("columns", "current"),
            value: set.replicas.current,
            mono: true,
          },
          {
            label: t("settings", "serviceLabel"),
            value: set.serviceName
              ? ref("Service", set.serviceName, set.namespace)
              : "—",
          },
          {
            label: t("columns", "updateStrategy"),
            value: set.updateStrategy || "—",
          },
        ],
      },
      ...images(set, t),
    ],
  })),

  DaemonSet: source(commands.getDaemonset, (set, _target, t) => ({
    status: workloadStatus(set),
    createdAt: set.createdAt,
    groups: [
      {
        title: t("columns", "scheduling"),
        items: [
          {
            label: t("columns", "ready"),
            value: t("readings", "readyOfNodes", {
              ready: set.ready,
              desired: set.desired,
            }),
            tone: set.ready < set.desired ? "warn" : undefined,
          },
          { label: t("columns", "current"), value: set.current, mono: true },
          {
            label: t("columns", "upToDateCount"),
            value: set.upToDate,
            mono: true,
          },
          {
            label: t("settings", "available"),
            value: set.available,
            mono: true,
          },
          {
            label: t("columns", "updateStrategy"),
            value: set.updateStrategy || "—",
          },
        ],
      },
      ...images(set, t),
    ],
  })),

  Job: source(commands.getJob, (job, _target, t) => ({
    status: job.status,
    createdAt: job.createdAt,
    groups: [
      {
        title: t("columns", "progress"),
        items: [
          {
            label: t("columns", "succeeded"),
            value: t("count", "nOfTotal", {
              n: job.succeeded,
              total: job.completions ?? 1,
            }),
          },
          {
            label: t("settings", "failed"),
            value: job.failed,
            mono: true,
            tone: job.failed > 0 ? "err" : undefined,
          },
          { label: t("columns", "active"), value: job.active, mono: true },
          {
            label: t("columns", "backoffLimit"),
            value: job.backoffLimit ?? "—",
            mono: true,
          },
          {
            label: t("action", "started"),
            value: formatDate(job.startTime) ?? "—",
          },
          {
            label: t("columns", "completed"),
            value: formatDate(job.completionTime) ?? "—",
          },
        ],
      },
      ...controlledBy(job.ownerReferences, job.namespace, t),
      ...images(job, t),
    ],
  })),

  CronJob: source(commands.getCronjob, (cron, _target, t) => ({
    status: cron.suspend ? "Suspended" : "Active",
    createdAt: cron.createdAt,
    groups: [
      {
        title: t("columns", "schedule"),
        items: [
          { label: t("columns", "schedule"), value: cron.schedule, mono: true },
          {
            label: t("columns", "timeZone"),
            value: cron.timezone || t("empty", "clusterLocal"),
          },
          {
            label: t("columns", "lastRun"),
            value: formatDate(cron.lastSchedule) ?? "never",
          },
          {
            label: t("columns", "lastSuccess"),
            value: formatDate(cron.lastSuccessfulTime) ?? "never",
          },
          { label: t("columns", "activeJobs"), value: cron.active, mono: true },
          {
            label: t("action", "concurrency"),
            value: cron.concurrencyPolicy || "Allow",
          },
        ],
      },
      ...images(cron, t),
    ],
  })),
};
