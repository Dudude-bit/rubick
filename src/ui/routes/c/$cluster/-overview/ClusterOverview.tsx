import { LayoutDashboard, Lock, TriangleAlert } from "lucide-react";

import { ERROR_CODES, isRefusal } from "@/lib/error-utils";
import { getDisplayPlural } from "@/lib/resource-registry";
import { scopeIn, scopeLabel } from "@/lib/namespace-scope";
import { openNamespacePicker } from "@/lib/read-deadline";
import { useClusterStore } from "@/stores/clusterStore";
import { useClusterInfo } from "@/hooks";
import {
  useOverviewFollowed,
  useScopedOverview,
} from "@/hooks/useClusterOverview";
import { DataFreshness } from "@/components/ui/realtime/data-freshness";
import { useAttention } from "@/hooks/useAttention";
import { attentionFigure, unreadWhere, type Attention } from "@/lib/attention";
import { PartlyUnread } from "../-object/ResourceDetailHeader";
import { ClusterFrontDoor } from "../../../-components/ClusterFrontDoor";
import { MyServices } from "./MyServices";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { Section, SectionHeader } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { Unknown } from "@/components/ui/unknown";
import { StaleRows } from "@/components/ui/stale-rows";
import {
  AttentionPanel,
  AttentionPending,
  NodesPanel,
  OverviewSkeleton,
  SchedulerPanel,
  WarningsPanel,
  WorkloadsPanel,
} from "./health";
import { podTotal, readyBetweenCrashes } from "./health-share";
import { holdScroll } from "./scroll-anchor";
import type { ClusterOverview as ClusterOverviewData } from "@/generated/types";
import type { ReportStat } from "@/lib/report";
import { useT, type T } from "@/i18n/useT";
import { useListableIn } from "@/hooks/useListAccess";
import type { ListQuery } from "@/generated/types";

/** What reading a namespace's overview needs first: its pods. */
const PODS: ListQuery = { group: "", resource: "pods", namespaced: true };

const holdsScroll = (page: HTMLDivElement | null) =>
  page ? holdScroll(page) : undefined;

/** The kinds the page could not check, by the plural Not checked names them in. */
function uncheckedReads(
  overview: ClusterOverviewData,
  attention: Attention | null
): string[] {
  const kinds = [
    ...overview.unread.map((entry) => entry.kind),
    ...(overview.nodePodsUnread ? [overview.nodePodsUnread.kind] : []),
    ...(attention?.checks ?? [])
      .filter((check) => check.state === "unread")
      .map((check) => check.kind),
    ...(attention && attention.unconfirmed.length > 0 ? ["Pod"] : []),
  ];
  return [...new Set(kinds)].map(getDisplayPlural);
}

/** The headline numbers for Share: what is broken, and what is serving. */
function overviewStats(
  overview: ClusterOverviewData,
  attention: Attention,
  t: T
): ReportStat[] {
  const { pods } = overview;
  const podsUnread = overview.unread.filter((entry) => entry.kind === "Pod");
  const stats: ReportStat[] = [
    {
      label: t("action", "needsAttention"),
      value: attentionFigure(attention),
      role: attention.worst ?? (attention.complete ? "ok" : "neutral"),
    },
    {
      label: "Pods",
      value: pods
        ? `${pods.read.ready}/${podTotal(pods.read)}`
        : t("empty", "notReadLower"),
      note:
        podsUnread.length > 0
          ? t("cluster", "podsNotCounted", {
              where: unreadWhere(podsUnread, t),
            })
          : pods && readyBetweenCrashes(pods.read) > 0
            ? t("count", "readyBetweenCrashes", {
                n: readyBetweenCrashes(pods.read),
              })
            : null,
    },
  ];
  if (overview.nodesKnown)
    stats.push({
      label: "Nodes",
      value: `${overview.nodes.filter((n) => n.ready).length}/${overview.nodes.length}`,
    });
  return stats;
}

/**
 * The overview answers one question — "do I need to do something right
 * now?" — and the reading order answers it: what is broken, what this scope
 * is made of, how much room the scheduler has left, and what the nodes and
 * the event feed have been saying.
 *
 * The cluster identity is not repeated here: the header already carries the
 * context and namespace selectors, and a page title restating them was the
 * largest block on a screen whose first row is the point.
 */
export function ClusterOverview() {
  const t = useT();
  const { isConnected, namespaceScope } = useClusterStore();
  const { data: clusterInfo } = useClusterInfo();

  const { data: overview, error, refetch, freshness } = useScopedOverview();
  const following = useOverviewFollowed(overview);
  const attention = useAttention({ refresh: "slow" });
  // The list pages name where a refused list can be read; the page that
  // tells a reader to open a namespace names the same ones.
  const { readableIn } = useListableIn(
    namespaceScope.length === 0 && error && isRefusal(error) ? PODS : null
  );

  // Not an empty overview but a different screen: with no cluster there
  // is no scope to be empty of anything, and the one thing the reader
  // needs is the list of clusters the kubeconfig already named.
  if (!isConnected) return <ClusterFrontDoor />;

  // What somebody pinned by hand is read per object and owes nothing to the
  // cluster-wide answer below — so it stands in every state of that answer.
  // Behind the three returns it was invisible to exactly the reader it is
  // for: the one whose token may read their own workloads and not the
  // cluster, whose overview is refused and whose home page then held
  // nothing at all.
  const pinned = <MyServices />;

  // Skeleton only on the first load — a refetch keeps the previous state on
  // screen so the layout never flashes empty while polling.
  if (!overview && !error) {
    return (
      <div className="flex flex-col gap-[22px]">
        {pinned}
        <OverviewSkeleton />
      </div>
    );
  }

  if (!overview && error) {
    // A refusal is not a failure: point at the fix, since the scoped overview
    // reads each namespace on its own. Rights change, so it may be asked again.
    const refused = isRefusal(error);
    return (
      <div className="flex flex-col items-start gap-[22px]">
        {pinned}
        <Unknown
          className="w-full"
          question={
            !refused
              ? t("empty", "couldNotReadClusterState")
              : namespaceScope.length === 0
                ? readableIn.length > 0
                  ? t("empty", "noClusterOverviewAccessIn", {
                      n: readableIn.length,
                      namespaces: readableIn.join(", "),
                    })
                  : t("empty", "noClusterOverviewAccess")
                : t("empty", "noScopeOverviewAccess", {
                    scope: scopeIn(namespaceScope, t),
                  })
          }
          error={error}
          onRetry={() => void refetch()}
        />
        {refused && (
          <Button variant="outline" size="sm" onClick={openNamespacePicker}>
            {t("action", "chooseNamespace")}
          </Button>
        )}
      </div>
    );
  }

  if (!overview) return pinned;

  const scope = scopeLabel(namespaceScope, t);
  const refreshFailing = freshness.stale || !!error;
  const unchecked = uncheckedReads(overview, attention);
  const nodePods = overview.nodePodsUnread;
  const NodePodsIcon =
    nodePods?.code === ERROR_CODES.PERMISSION ? Lock : TriangleAlert;
  const screen = {
    title: t("nav", "overview"),
    icon: LayoutDashboard,
    scope: namespaceScope,
    stats: () => (attention ? overviewStats(overview, attention, t) : []),
  };

  return (
    <div ref={holdsScroll} className="flex flex-col gap-[22px]">
      <SectionHeader
        title={t("nav", "overview")}
        actions={
          <div className="flex items-center gap-3">
            {unchecked.length > 0 && !refreshFailing ? (
              <PartlyUnread
                reads={unchecked}
                note="freshPartlyUnreadChecksNote"
              />
            ) : (
              <DataFreshness
                dataUpdatedAt={freshness.dataUpdatedAt}
                live={following}
                slowed={freshness.slowed}
                stale={refreshFailing}
                slowRead={freshness.slowRead}
              />
            )}
            <ShareScreenAction screen={screen} />
          </div>
        }
      />
      {refreshFailing && (
        <StaleRows
          label={t("nav", "overview").toLowerCase()}
          shared={false}
          since={freshness.dataUpdatedAt}
          error={error}
          onRetry={() => void refetch()}
        />
      )}
      {pinned}
      {attention ? (
        <AttentionPanel
          attention={attention}
          pods={overview.pods}
          podsUnlisted={overview.podsUnlisted}
          podsUnread={overview.unread.filter((entry) => entry.kind === "Pod")}
          nodes={overview.nodes}
          nodesKnown={overview.nodesKnown}
          refreshFailing={refreshFailing}
        />
      ) : (
        <AttentionPending />
      )}
      <WorkloadsPanel overview={overview} scope={scope} />
      {overview.nodesKnown ? (
        <>
          {nodePods ? (
            // The nodes were read and the pods they hold were not: the
            // headroom is a sum over those pods, so it is unknown, not zero.
            <Section>
              <SectionHeader title={t("cluster", "schedulerHeadroom")} />
              <div
                className="flex items-center gap-2 py-1"
                data-testid="headroom-unread"
                title={nodePods.message}
              >
                <NodePodsIcon
                  className="h-4 w-4 text-fg-mut"
                  aria-hidden="true"
                />
                <p className="text-xs text-fg-mut">
                  {t("empty", "headroomNeedsReads", {
                    kinds: getDisplayPlural(nodePods.kind),
                  })}
                </p>
              </div>
            </Section>
          ) : (
            <SchedulerPanel
              scheduler={overview.scheduler}
              metricsAvailable={overview.metricsAvailable}
              scoped={namespaceScope.length > 0}
            />
          )}
          <NodesPanel
            nodes={overview.nodes}
            version={clusterInfo?.server_version}
          />
        </>
      ) : (
        // The scheduler headroom and node rows both come from the cluster-wide
        // node read, which this token was refused — one honest note in their
        // place, not two panels drawing an empty cluster.
        <Section>
          <SectionHeader title="Nodes" />
          <div className="flex items-center gap-2 py-1">
            <Lock className="h-4 w-4 text-fg-mut" aria-hidden="true" />
            <p className="text-xs text-fg-mut">{t("empty", "noNodeAccess")}</p>
          </div>
        </Section>
      )}
      <WarningsPanel
        warnings={overview.warnings}
        short={overview.warningsShort}
      />
    </div>
  );
}
