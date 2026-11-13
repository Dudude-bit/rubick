import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { EyeOff } from "lucide-react";

import { RESOURCE_NAME_SHELL } from "@/components/object/ResourceName";
import type { KeyValue } from "@/components/object/key-values";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useLastPassed } from "@/hooks/useNow";
import { useWarnedPods } from "@/hooks/useClusterOverview";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { listLink } from "@/lib/links";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { kindHue } from "@/lib/resource-identity";
import {
  getResourceDefinition,
  ResourceType,
  type ResourceKind,
} from "@/lib/resource-registry";
import { withKubeletWarned } from "@/lib/share/pod-status";
import { attentionOf, rowsWithStarts, startsOf } from "@/lib/workload-status";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { KeyValueList } from "./detail-kv";

/**
 * What actually lives in a namespace — the question its peek exists for.
 * Three cheap namespace-scoped lists; a count alone would hide the part
 * worth peeking for, so the pods row splits out what is not ready.
 */
export function NamespaceContents({
  namespace,
  heading,
  onOpen,
}: {
  namespace: string;
  heading: (title: string) => ReactNode;
  /** Called as a door is taken, before the list opens. */
  onOpen?: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const switchNamespace = useClusterStore((s) => s.switchNamespace);

  /** The kind's own icon and hue in the resource shell, as a door: click
   *  scopes the window to this namespace and opens the kind's list. */
  const kindDoor = (kind: ResourceKind) => {
    const definition = getResourceDefinition(kind);
    const Icon = definition.icon;
    return (
      <button
        type="button"
        onClick={() => {
          void switchNamespace(namespace);
          onOpen?.();
          navigate(listLink(kind));
        }}
        title={t("action", "openScopedTo", {
          plural: definition.displayPlural,
          namespace,
        })}
        className={cn(
          RESOURCE_NAME_SHELL,
          "hover:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
        )}
      >
        <Icon
          className="h-2.5 w-2.5 flex-none self-center"
          style={{
            color: `hsl(${kindHue(kind)} var(--kind-s) var(--kind-l))`,
          }}
          aria-hidden="true"
        />
        <span className="truncate">{definition.displayPlural}</span>
      </button>
    );
  };

  const filters = {
    namespace,
    labelSelector: null,
    fieldSelector: null,
    limit: null,
  };
  const pods = useLiveQuery({
    queryKey: queryKeys.resources(ResourceType.Pod, namespace),
    queryFn: () =>
      commands.listPods({
        ...filters,
        statusFilter: null,
        selector: null,
        nodeName: null,
      }),
    staleTime: STALE_TIMES.resourceDetail,
    refresh: "resourceDetail",
    retry: false,
  });
  const deployments = useLiveQuery({
    queryKey: ["peek-ns-deployments", namespace],
    queryFn: () => commands.listDeployments(filters),
    staleTime: STALE_TIMES.resourceDetail,
    refresh: false,
    retry: false,
  });
  const services = useLiveQuery({
    queryKey: ["peek-ns-services", namespace],
    queryFn: () => commands.listServices({ ...filters, serviceType: null }),
    staleTime: STALE_TIMES.resourceDetail,
    refresh: false,
    retry: false,
  });

  const notReady =
    pods.data?.filter(
      (pod) => !pod.status.ready && pod.status.display !== "Terminating"
    ).length ?? 0;
  const warned = useWarnedPods();
  const starts = useMemo(
    () => (pods.data ? startsOf(withKubeletWarned(pods.data, warned)) : null),
    [pods.data, warned]
  );
  const ranOut = useLastPassed(starts?.deadlines ?? []);
  const verdicts = useMemo(
    () =>
      deployments.data &&
      attentionOf(
        rowsWithStarts("Deployment", deployments.data, starts, ranOut).map(
          (deployment) => deployment.rollout
        )
      ),
    [deployments.data, starts, ranOut]
  );

  const count = (
    { data, error }: { data: unknown[] | undefined; error: Error | null },
    kind: ResourceKind,
    trouble?: string,
    unchecked?: string
  ): KeyValue => ({
    label: kindDoor(kind),
    value: error ? (
      <span className="break-words">
        {t("services", "couldNotRead")}{" "}
        <span className="text-fg-fnt">{errorToShow(error)}</span>
      </span>
    ) : data === undefined ? (
      t("action", "readingInline")
    ) : data.length === 0 ? (
      t("empty", "noneCount")
    ) : (
      <span className="inline-flex flex-wrap items-baseline gap-x-1 tabular-nums">
        {data.length}
        {trouble && <span className="text-err">({trouble})</span>}
        {unchecked && (
          <span className="inline-flex items-baseline gap-1 text-fg-mut">
            <EyeOff className="h-2.5 w-2.5 self-center" aria-hidden="true" />
            {unchecked}
          </span>
        )}
      </span>
    ),
    tone: error ? ("warn" as const) : trouble ? ("err" as const) : undefined,
  });

  return (
    <div>
      {heading(t("nav", "contents"))}
      <KeyValueList
        items={[
          count(
            pods,
            "Pod",
            notReady > 0 ? t("count", "nNotReady", { n: notReady }) : undefined
          ),
          count(
            deployments,
            "Deployment",
            verdicts && verdicts.attention > 0
              ? t("count", "needAttention", { n: verdicts.attention })
              : undefined,
            verdicts && verdicts.unconfirmed > 0
              ? t("count", "unconfirmedByPods", { n: verdicts.unconfirmed })
              : undefined
          ),
          count(services, "Service"),
        ]}
      />
    </div>
  );
}
