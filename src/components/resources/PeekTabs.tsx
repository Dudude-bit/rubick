import { useCallback, type ReactNode } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Copy, RefreshCw } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { Skeleton, TextSkeleton } from "@/components/ui/skeleton";
import { YamlEditor } from "@/components/yaml";
import { LogViewer } from "@/components/logs/LogViewer";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { fetchResourceYaml } from "@/hooks/useResourceYaml";
import { commands } from "@/lib/commands";
import { STALE_TIMES } from "@/lib/refresh";
import { toKind } from "@/lib/resource-registry";
import type { PeekTarget } from "@/hooks/usePeek";
import { podContainers } from "@/lib/container-sequence";
import { ContainerRows } from "./container-rows";
import { DataSection } from "./data-rows";
import { DetailAction } from "./detail-blocks";
import { JobRows } from "./child-rows";
import { PodListCard } from "./PodListCard";
import type { PeekTabId } from "./peek-tabs";
import { RelatedPanel } from "./RelatedPanel";
import { useRelatedObjects } from "@/hooks/useRelatedObjects";
import type {
  ConfigMapInfo,
  CustomResourceDetailInfo,
  DaemonSetDetailInfo,
  JobInfo,
  PodInfo,
  ConfigData,
  SecretInfo,
} from "@/generated/types";
import { useT } from "@/i18n/useT";

/**
 * The peek's work surfaces.
 *
 * Every one of these is mounted only while its tab is selected — Radix drops
 * an inactive tab's children — so opening a peek costs the Overview fetch and
 * nothing else. No log stream is started, no manifest is read, until someone
 * asks for it. The cost of that choice is that leaving Logs stops the stream,
 * which is the right trade for a panel opened dozens of times an hour.
 */

export interface PeekTabBodyProps {
  tab: PeekTabId;
  target: PeekTarget;
  /**
   * The object the Overview query already fetched. Typed per kind by
   * `peek-sources`, erased on the way out; each tab knows which kind it
   * belongs to and narrows it back.
   */
  detail: unknown;
  isDetailLoading: boolean;
}

export function PeekTabBody({
  tab,
  target,
  detail,
  isDetailLoading,
}: PeekTabBodyProps) {
  switch (tab) {
    case "logs":
      return (
        <PeekLogsTab
          target={target}
          pod={detail as PodInfo | undefined}
          isLoading={isDetailLoading}
        />
      );
    case "containers":
      return (
        <PeekContainersTab
          pod={detail as PodInfo | undefined}
          isLoading={isDetailLoading}
        />
      );
    case "data":
      return <PeekDataTab target={target} detail={detail} />;
    case "children":
      return toKind(target.kind) === "CronJob" ? (
        <PeekJobsTab target={target} />
      ) : (
        <PeekPodsTab target={target} detail={detail} />
      );
    case "connections":
      return (
        <PeekRelatedTab
          target={target}
          detail={detail as CustomResourceDetailInfo | undefined}
        />
      );
    case "yaml":
      return <PeekYamlTab target={target} />;
    default:
      return null;
  }
}

/* ---------- shared states ---------- */

/** A panel-wide message, used for every "there is nothing here, and why". */
function TabNote({
  title,
  detail,
  tone,
}: {
  title: string;
  detail?: string | null;
  tone?: "warn";
}) {
  return (
    <div className="px-3.5 py-4">
      <p className={tone === "warn" ? "text-xs text-warn" : "text-xs text-fg"}>
        {title}
      </p>
      {detail && (
        <p className="mt-1 wrap-break-word text-[11px] text-fg-mut">{detail}</p>
      )}
    </div>
  );
}

function TabError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: Error;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="px-3.5 py-4">
      <p className="text-xs text-warn">Could not read {what}.</p>
      <p className="mt-1 wrap-break-word text-[11px] text-fg-mut">
        {error.message}
      </p>
      <div className="mt-2">
        <DetailAction
          label={t("action", "retry")}
          icon={RefreshCw}
          onClick={onRetry}
        />
      </div>
    </div>
  );
}

/**
 * Shown while a tab that already has content is re-reading it. The content
 * itself stays on screen: blanking a panel on a two-second poll is the single
 * most common way a live view reads as broken.
 */
function Refreshing({ busy }: { busy: boolean }) {
  if (!busy) return null;
  return <span className="text-[11px] text-fg-fnt">updating…</span>;
}

function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="px-3.5 py-3"
      aria-hidden="true"
      data-testid="peek-rows-skeleton"
    >
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-2.5 border-b border-hair py-[7px]"
        >
          <Skeleton className="h-[7px] w-[7px] rounded-full" />
          <Skeleton className="h-2.5 flex-1" />
          <Skeleton className="h-2.5 w-10" />
        </div>
      ))}
    </div>
  );
}

/* ---------- Logs ---------- */

/**
 * A container that has never started has no log to read, and kubelet answers
 * the request with an error rather than an empty body. Saying so is the
 * difference between "this pod cannot be scheduled" and "the log pane is
 * broken" — the two look identical in an empty black box.
 */
function describeSilence(
  pod: PodInfo
): { title: string; detail: string } | null {
  // Init containers count. A pod in `Init:CrashLoopBackOff` has no app
  // container that has ever started and one init container that has
  // started nine times — declaring it silent hid the only log in the pod
  // that says anything at all.
  const started = podContainers(pod).some(
    (container) =>
      container.state.type === "running" ||
      container.state.type === "terminated" ||
      container.restartCount > 0
  );
  if (started) return null;

  const waiting = podContainers(pod).find(
    (container) => container.state.type === "waiting"
  );
  const reason =
    waiting?.state.type === "waiting" ? waiting.state.reason : null;
  const explanation =
    pod.status.message ||
    pod.status.reason ||
    (reason ? `${waiting?.name} is waiting · ${reason}` : null) ||
    "The scheduler has not placed it on a node yet.";

  return {
    title: `No container has started — this pod is ${pod.status.display}.`,
    detail: `${explanation} Recent events on the Overview tab say more.`,
  };
}

function PeekLogsTab({
  target,
  pod,
  isLoading,
}: {
  target: PeekTarget;
  pod: PodInfo | undefined;
  isLoading: boolean;
}) {
  if (isLoading || !pod) {
    return <RowsSkeleton rows={8} />;
  }

  const silence = describeSilence(pod);
  if (silence) {
    return (
      <TabNote title={silence.title} detail={silence.detail} tone="warn" />
    );
  }

  return (
    <LogViewer
      key={`${target.namespace}/${target.name}`}
      podName={pod.name}
      namespace={pod.namespace}
      containers={podContainers(pod)}
    />
  );
}

/* ---------- Containers ---------- */

function PeekContainersTab({
  pod,
  isLoading,
}: {
  pod: PodInfo | undefined;
  isLoading: boolean;
}) {
  if (isLoading || !pod) return <RowsSkeleton rows={5} />;
  if (podContainers(pod).length === 0) {
    return (
      <TabNote
        title="This pod declares no containers."
        detail="Nothing to inspect until its spec is fixed."
      />
    );
  }
  return (
    <div className="h-full overflow-y-auto scrollbar-thin px-3.5 py-3">
      <ContainerRows pod={pod} namespace={pod.namespace} />
    </div>
  );
}

/* ---------- Data ---------- */

function PeekDataTab({
  target,
  detail,
}: {
  target: PeekTarget;
  detail: unknown;
}) {
  const t = useT();
  const kind = toKind(target.kind);
  const namespace = target.namespace ?? null;
  const isSecret = kind === "Secret";
  const keys =
    (detail as ConfigMapInfo | SecretInfo | undefined)?.dataKeys ?? [];

  const { data, error, isPending, isFetching, refetch } = useQuery({
    // Both kinds come back in the same three parts now — the values, the
    // keys the backend refuses to hand over, and the ones that are not text
    // — so the peek panel draws a Secret and a ConfigMap the same way
    // without normalising anything on the way in.
    queryKey: ["peek-data", kind, namespace, target.name],
    queryFn: (): Promise<ConfigData> =>
      isSecret
        ? commands.getSecretData(target.name, namespace)
        : commands.getConfigmapData(target.name, namespace),
    staleTime: STALE_TIMES.resourceDetail,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (error) {
    return (
      <TabError
        what={`this ${target.kind}'s data`}
        error={error}
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin px-3.5 py-3">
      <DataSection
        data={data?.values ?? {}}
        withheld={data?.withheld}
        binary={data?.binary}
        keys={keys}
        sensitive={isSecret}
        isLoading={isPending || (isFetching && !data)}
        emptyMessage={t("empty", "kindHoldsNoKeys", { kind: target.kind })}
      />
    </div>
  );
}

/* ---------- Children ---------- */

const NO_POD_FILTERS = {
  labelSelector: null,
  fieldSelector: null,
  limit: null,
  statusFilter: null,
  selector: null,
  nodeName: null,
};

/**
 * The pods a controller owns. Each kind links to its pods differently and the
 * detail pages already worked out how; this is the same resolution in one
 * place rather than five.
 */
function fetchOwnedPods(
  target: PeekTarget,
  namespace: string,
  detail: unknown
): Promise<PodInfo[]> {
  switch (toKind(target.kind)) {
    case "Deployment":
      return commands.getDeploymentPods(target.name, namespace);
    case "Job":
      return commands.listPods({
        ...NO_POD_FILTERS,
        namespace,
        labelSelector: `job-name=${target.name}`,
      });
    case "DaemonSet":
      return commands.listPods({
        ...NO_POD_FILTERS,
        namespace,
        labelSelector:
          (detail as DaemonSetDetailInfo | undefined)?.selector || null,
      });
    default:
      // StatefulSet: the API does not expose its match labels, but it does
      // guarantee the pod names — `<set>-0`, `<set>-1`, and so on.
      return commands
        .listPods({ ...NO_POD_FILTERS, namespace })
        .then((pods) =>
          pods.filter(
            (pod) =>
              pod.name.startsWith(`${target.name}-`) &&
              /^\d+$/.test(pod.name.slice(target.name.length + 1))
          )
        );
  }
}

function PeekPodsTab({
  target,
  detail,
}: {
  target: PeekTarget;
  detail: unknown;
}) {
  const t = useT();
  const namespace = target.namespace ?? null;
  const kind = toKind(target.kind);
  const selector =
    kind === "DaemonSet"
      ? (detail as DaemonSetDetailInfo | undefined)?.selector
      : undefined;

  const { data, error, isPending, isFetching, refetch } = useLiveQuery({
    queryKey: ["peek-pods", kind, namespace, target.name, selector],
    queryFn: () => fetchOwnedPods(target, namespace!, detail),
    // A DaemonSet's selector arrives with the Overview fetch; asking before
    // it lands would list the whole namespace.
    enabled: !!namespace && (kind !== "DaemonSet" || !!selector),
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (error) {
    return (
      <TabError what="this workload's pods" error={error} onRetry={refetch} />
    );
  }
  if (isPending || !data) return <RowsSkeleton />;

  return (
    <ChildrenSection
      title="Pods"
      count={data.length}
      busy={isFetching}
      empty={data.length === 0}
    >
      <PodListCard
        pods={data}
        emptyMessage={t("empty", "kindHasNoPods", { kind: target.kind })}
      />
    </ChildrenSection>
  );
}

function PeekJobsTab({ target }: { target: PeekTarget }) {
  const t = useT();
  const namespace = target.namespace ?? null;

  const { data, error, isPending, isFetching, refetch } = useLiveQuery({
    queryKey: ["peek-jobs", namespace, target.name],
    queryFn: async () => {
      const jobs = await commands.listJobs({
        namespace,
        labelSelector: null,
        fieldSelector: null,
        limit: null,
      });
      // The list command carries no owner references, so the naming
      // convention the controller uses is the only link available.
      return jobs.filter((job: JobInfo) =>
        job.name.startsWith(`${target.name}-`)
      );
    },
    enabled: !!namespace,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (error) {
    return (
      <TabError what="this CronJob's runs" error={error} onRetry={refetch} />
    );
  }
  if (isPending || !data) return <RowsSkeleton />;

  return (
    <ChildrenSection
      title="Jobs"
      count={data.length}
      busy={isFetching}
      empty={data.length === 0}
    >
      <JobRows jobs={data} emptyMessage={t("empty", "cronJobNotRunYet")} />
    </ChildrenSection>
  );
}

function ChildrenSection({
  title,
  count,
  busy,
  empty,
  children,
}: {
  title: string;
  count: number;
  busy: boolean;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin px-2 py-3">
      <Section>
        <SectionHeader
          className="px-1.5"
          title={title}
          count={empty ? undefined : count}
          actions={<Refreshing busy={busy} />}
        />
        {children}
      </Section>
    </div>
  );
}

/* ---------- Connections ---------- */

/**
 * Only ever reached for a custom resource — see `peekTabsFor`. The subject's
 * group comes off the CRD name it was addressed by rather than off the
 * object's `apiVersion`, so the tab can ask before the object has landed.
 */
function PeekRelatedTab({
  target,
  detail,
}: {
  target: PeekTarget;
  detail: CustomResourceDetailInfo | undefined;
}) {
  const related = useRelatedObjects(
    target.crd
      ? {
          // `<plural>.<group>` — everything after the first dot.
          group: target.crd.slice(target.crd.indexOf(".") + 1),
          kind: target.kind,
          namespace: target.namespace ?? null,
          name: target.name,
        }
      : null,
    detail
  );

  return (
    <div className="h-full overflow-y-auto scrollbar-thin px-3.5 py-3">
      <RelatedPanel query={related} kind={target.kind} />
    </div>
  );
}

/* ---------- YAML ---------- */

function PeekYamlTab({ target }: { target: PeekTarget }) {
  const t = useT();
  const copy = useCopyToClipboard();
  const namespace = target.namespace ?? null;

  const { data, error, isPending, isFetching, refetch } = useLiveQuery({
    queryKey: [
      "peek-yaml",
      target.crd ?? null,
      target.kind,
      namespace,
      target.name,
    ],
    queryFn: () =>
      // `fetchResourceYaml` resolves the apiVersion from the registry, which
      // has never heard of this kind and answers `v1` — so a custom resource
      // goes through the CRD instead, exactly as its detail page does.
      target.crd
        ? commands.getCustomResourceYaml(target.crd, target.name, namespace)
        : fetchResourceYaml(target.kind, target.name, namespace),
    staleTime: STALE_TIMES.resourceDetail,
    // Slower than the summary above it: a manifest is read to compare against
    // something, and a column that reflows under the reader is unusable.
    refresh: "slow",
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const handleCopy = useCallback(() => {
    if (data) copy(data, `${target.name} manifest copied`);
  }, [copy, data, target.name]);

  if (error) {
    return (
      <TabError
        what={`this ${target.kind}'s manifest`}
        error={error}
        onRetry={() => refetch()}
      />
    );
  }

  if (isPending || data === undefined) {
    return (
      <div className="px-3.5 py-3">
        <TextSkeleton lines={20} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center gap-2 px-2 py-1">
        <span className="text-[11px] text-fg-mut">{target.kind} manifest</span>
        <Refreshing busy={isFetching} />
        <div className="ml-auto">
          <DetailAction
            label={t("action", "copy")}
            icon={Copy}
            onClick={handleCopy}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden border-t border-hair">
        <YamlEditor value={data} readOnly height="100%" showFoldGutter />
      </div>
    </div>
  );
}
