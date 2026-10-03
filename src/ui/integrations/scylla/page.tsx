import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Box, HardDrive, Layers } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/section";
import { useToast } from "@/components/ui/use-toast";
import { DetailTabs } from "@/components/resources/DetailTabs";
import {
  countMark,
  viewGlyph,
  type DetailTab,
} from "@/components/resources/detail-tab";
import { useNow } from "@/hooks/useNow";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { ResourceType } from "@/lib/resource-registry";
import { TONE_TEXT } from "@/lib/tone";
import { cn, formatSince } from "@/lib/utils";
import { Cell, Finding, TroubleRow, VendorReadFailure } from "../page-kit";
import { actionsFor, perform, type ScyllaAction } from "./actions";
import { nodeConfigsSection } from "./share";
import {
  CLUSTERS_CRD,
  useClusters,
  useNodeConfigs,
  useOperator,
  type OperatorInfo,
} from "./data";
import {
  byTrouble,
  readNodeConfig,
  readScyllaCluster,
  type ScyllaCluster,
  type ScyllaFinding,
} from "./model";
import { useSearchParam } from "@/hooks/useSearchParam";
import { useT, type T } from "@/i18n/useT";
import { ControllerLine, Fact, OperatorActionButton } from "../operator-kit";
import { troubleMark, allowedWord } from "../kit";
import { toastError } from "@/lib/toast-error";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, refOf } from "@/lib/report-parts";

export default function ScyllaPage() {
  const t = useT();
  const [tab, setTab] = useSearchParam("tab", "clusters");
  const clustersQuery = useClusters();
  const nodeConfigs = useNodeConfigs();

  const clusters = useMemo(
    () =>
      byTrouble(
        (clustersQuery.data ?? []).map((c) =>
          readScyllaCluster(c, c.generation)
        )
      ),
    [clustersQuery.data]
  );
  // The verb is asked where the ScyllaClusters actually are; asked with no
  // namespace it means "in every one", which a namespace-scoped grant
  // answers no to.
  const namespaces = useMemo(
    () => [...new Set(clusters.map((c) => c.namespace))].sort(),
    [clusters]
  );
  const operator = useOperator(namespaces);

  if (clustersQuery.error) {
    return (
      <VendorReadFailure
        title={t("operators", "couldNotReadScyllaClusters")}
        error={clustersQuery.error}
        onRetry={() => void clustersQuery.refetch()}
      />
    );
  }

  const tabs: DetailTab[] = [
    {
      id: "clusters",
      label: t("operators", "clustersTab"),
      glyph: viewGlyph(Layers),
      mark: troubleMark(
        clusters.map((cluster) => cluster.worst),
        (n) => t("operators", "clustersNeedAttention", { n })
      ),
      content: (
        <ClustersTab
          clusters={clusters}
          loading={clustersQuery.isPending}
          operator={operator.data}
        />
      ),
    },
    {
      id: "nodes",
      label: t("operators", "nodeConfigsTab"),
      glyph: viewGlyph(HardDrive),
      mark:
        nodeConfigs.data?.ok && nodeConfigs.data.items.length > 0
          ? countMark(nodeConfigs.data.items.length)
          : undefined,
      content: <NodeConfigsTab read={nodeConfigs.data} />,
    },
    {
      id: "operator",
      label: t("operators", "operatorTab"),
      glyph: viewGlyph(Box),
      content: <OperatorTab operator={operator.data} />,
    },
  ];

  const activeTab = tabs.find((entry) => entry.id === tab) ?? tabs[0];
  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="Scylla"
        count={
          clustersQuery.isPending
            ? undefined
            : t("empty", "acrossEveryNamespace", {
                count: t("readings", "kindCount", {
                  n: clusters.length,
                  kind: "ScyllaCluster",
                }),
              })
        }
        description={t("operators", "scyllaPageDescription")}
      />
      <OperatorStrip operator={operator.data} pending={operator.isPending} />
      <DetailTabs
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
        actions={
          <ShareScreenAction
            screen={{
              title: `Scylla · ${activeTab?.label ?? ""}`,
              icon:
                activeTab?.id === "clusters"
                  ? Layers
                  : activeTab?.id === "nodes"
                    ? HardDrive
                    : Box,
            }}
          />
        }
      />
    </div>
  );
}

function OperatorStrip({
  operator,
  pending,
}: {
  operator: OperatorInfo | undefined;
  pending: boolean;
}) {
  const t = useT();
  const now = useNow();
  if (pending || !operator) {
    return (
      <p className="text-xs text-fg-fnt">{t("action", "readingInline")}</p>
    );
  }
  return (
    <div className="grid gap-x-8 gap-y-2 text-xs md:grid-cols-2">
      <Fact label={t("operators", "controllerFact")}>
        <ControllerLine
          controller={operator.operator}
          missing={t("operators", "scyllaOperatorNotFound")}
          known={operator.operatorKnown}
          reason={operator.operatorReason}
        />
      </Fact>
      <Fact label={t("columns", "version")}>
        {operator.version ? (
          <span className="font-mono">{operator.version}</span>
        ) : (
          <span className="text-fg-fnt">
            {t(
              "operators",
              operator.operatorKnown
                ? "versionUnknown"
                : "deploymentsUnreadable"
            )}
          </span>
        )}
      </Fact>
      <Fact label="ScyllaDB Manager">
        {operator.manager ? (
          <>
            <ControllerLine
              controller={operator.manager}
              missing=""
              known={operator.managerKnown}
            />
            <span className="ml-2 text-fg-fnt">
              {t("operators", "managerPresent")}
            </span>
          </>
        ) : (
          <span
            className={operator.managerKnown ? "text-warn" : TONE_TEXT.unknown}
            title={operator.managerReason ?? undefined}
          >
            {t(
              "operators",
              operator.managerKnown ? "managerAbsent" : "deploymentsUnreadable"
            )}
          </span>
        )}
      </Fact>
      <Fact label={t("operators", "canActFact")}>
        {t("operators", "canPatchScyllaClusters")}:{" "}
        {allowedWord(operator.canPatchClusters, t)}
        <span className="ml-2 text-fg-fnt">
          {t("operators", "checkedAgo", {
            ago: formatSince(operator.checkedAt, now),
          })}
        </span>
      </Fact>
    </div>
  );
}

function ClustersTab({
  clusters,
  loading,
  operator,
}: {
  clusters: ScyllaCluster[];
  loading: boolean;
  operator: OperatorInfo | undefined;
}) {
  const t = useT();
  useShareSection("scylla-clusters", () => {
    const found = clusters.flatMap((cluster) => {
      if (cluster.worst === null) return [];
      const worst =
        cluster.findings.find((f) => f.severity === cluster.worst) ??
        cluster.findings[0];
      return [
        {
          title: cluster.name,
          detail: worst?.detail ?? null,
          role: cluster.worst,
          ref: refOf({
            kind: "ScyllaCluster",
            name: cluster.name,
            namespace: cluster.namespace,
          }),
        },
      ];
    });
    if (found.length === 0) return null;
    return {
      id: "scylla-clusters",
      order: ORDER.own,
      title: t("operators", "clustersTab"),
      icon: iconSvg(Layers),
      count: found.length,
      body: { type: "findings" as const, items: found },
    };
  });
  if (loading)
    return (
      <p className="text-xs text-fg-fnt">{t("action", "readingInline")}</p>
    );
  if (clusters.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        {t("operators", "noScyllaClusters")}
      </p>
    );
  }
  return (
    <div>
      {clusters.map((cluster, index) => (
        <ClusterRow
          key={cluster.uid}
          cluster={cluster}
          operator={operator}
          openByDefault={cluster.worst !== null && index < 3}
          last={index === clusters.length - 1}
        />
      ))}
    </div>
  );
}

const TONE_OF: Record<"err" | "warn" | "none", "err" | "warn" | "ok"> = {
  err: "err",
  warn: "warn",
  none: "ok",
};

function ClusterRow({
  cluster,
  operator,
  openByDefault,
  last,
}: {
  cluster: ScyllaCluster;
  operator: OperatorInfo | undefined;
  openByDefault: boolean;
  last: boolean;
}) {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ScyllaAction | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const actions = actionsFor(
    cluster,
    operator?.patchIn.get(cluster.namespace) ??
      operator?.canPatchClusters ??
      null
  );
  const stateText = cluster.silent
    ? t("operators", "noStatusYet")
    : cluster.upgrade
      ? t("operators", "upgradingWord")
      : cluster.conditions.degraded === "True"
        ? "Degraded"
        : cluster.conditions.available === "False"
          ? "Unavailable"
          : cluster.conditions.progressing === "True"
            ? "Progressing"
            : // "Rolled out" is a verdict off the three conditions. Without
              // them there is no verdict, and the label said one anyway —
              // contradicting the finding printed directly underneath it.
              cluster.findings.some((f) => f.kind === "conditionsUnwritten")
              ? t("operators", "conditionsNotWritten")
              : cluster.findings.some((f) => f.kind === "conditionsUnknown")
                ? t("operators", "conditionsUnsure")
                : t("operators", "rolledOut");

  const run = async (action: ScyllaAction) => {
    setBusy(true);
    try {
      await perform(action, cluster, value);
      toast({
        title: t("operators", "actionDone", {
          action: t("operators", action.label),
          cluster: cluster.name,
        }),
      });
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("scylla"),
      });
    } catch (error) {
      toastError(
        t("operators", "actionFailed", {
          action: t("operators", action.label),
          cluster: cluster.name,
        }),
        error
      );
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const pick = (action: ScyllaAction) => {
    setValue(
      action.input?.kind === "members"
        ? String(action.input.current)
        : action.input?.kind === "version"
          ? (action.input.current ?? "")
          : ""
    );
    setPending(action);
  };

  return (
    <>
      <TroubleRow
        title={cluster.name}
        reference={{
          kind: "ScyllaCluster",
          name: cluster.name,
          namespace: cluster.namespace,
          crd: CLUSTERS_CRD,
        }}
        meta={
          <span className="text-fg-fnt">
            {cluster.namespace}
            {cluster.version && ` · ScyllaDB ${cluster.version}`}
          </span>
        }
        state={{ text: stateText, tone: TONE_OF[cluster.worst ?? "none"] }}
        openByDefault={openByDefault}
        last={last}
      >
        <div className="flex flex-col gap-3">
          {cluster.findings.length > 0 && (
            <div className="flex flex-col gap-2">
              {cluster.findings.map((finding, i) => (
                <FindingLine key={i} finding={finding} />
              ))}
            </div>
          )}
          <div className="grid gap-x-6 gap-y-1.5 text-xs md:grid-cols-2">
            <Fact label={t("operators", "conditionsFact")}>
              <span className="font-mono text-[11px]">
                Available {cluster.conditions.available ?? "?"} · Progressing{" "}
                {cluster.conditions.progressing ?? "?"} · Degraded{" "}
                {cluster.conditions.degraded ?? "?"}
              </span>
            </Fact>
            <Fact label={t("operators", "membersFact")}>
              {cluster.readyMembers === null
                ? t("operators", "notWritten")
                : t("operators", "readyMembersOfDeclared", {
                    ready: cluster.readyMembers,
                    n:
                      cluster.members ??
                      cluster.racks.reduce((sum, r) => sum + r.members, 0),
                  })}
            </Fact>
            <Fact label={t("operators", "specSeenFact")}>
              {cluster.specSeen.observed === null ||
              cluster.specSeen.generation === null ? (
                <span className="text-fg-fnt">
                  {t("operators", "specSeenUnknownScylla")}
                </span>
              ) : cluster.specSeen.observed === cluster.specSeen.generation ? (
                t("operators", "specSeenYes", {
                  n: cluster.specSeen.generation,
                })
              ) : (
                <span className="text-warn">
                  {t("operators", "specSeenBehind", {
                    observed: cluster.specSeen.observed,
                    generation: cluster.specSeen.generation,
                  })}
                </span>
              )}
            </Fact>
            <Fact label={t("operators", "repairFact")}>
              <TaskLine
                tasks={cluster.repairs}
                managed={cluster.managerId !== null}
              />
            </Fact>
            <Fact label={t("operators", "backupFact")}>
              <TaskLine
                tasks={cluster.backups}
                managed={cluster.managerId !== null}
              />
            </Fact>
            <Fact label={t("nav", "storage")}>
              {cluster.racks.length > 0 && cluster.racks[0].capacity
                ? `${cluster.racks.reduce((n, r) => n + r.members, 0)} × ${cluster.racks[0].capacity}`
                : t("operators", "notDeclared")}
            </Fact>
          </div>
          <div className="flex flex-col gap-1.5">
            {cluster.racks.map((rack) => (
              <div
                key={rack.name}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <span className="w-24 font-mono text-fg">{rack.name}</span>
                <span
                  className={cn(
                    rack.ready !== null &&
                      rack.ready < rack.members &&
                      !cluster.silent &&
                      "text-warn",
                    // Unknown is its own tone: not the green of a full rack
                    // and not the warn of a short one.
                    rack.ready === null && "text-fg-fnt"
                  )}
                >
                  {rack.ready === null
                    ? t("operators", "membersNotWritten", { n: rack.members })
                    : t("operators", "readyMembersOfDeclared", {
                        ready: rack.ready,
                        n: rack.members,
                      })}
                </span>
                {rack.version && (
                  <span className="text-fg-fnt">
                    {rack.updated !== null && rack.updated < rack.members
                      ? t("operators", "rackUpdated", {
                          updated: rack.updated,
                          members: rack.members,
                          version: cluster.version ?? "?",
                        })
                      : `${rack.version}`}
                  </span>
                )}
                {rack.stale && <Cell warn>{t("operators", "staleWord")}</Cell>}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {actions.map((action, i) => (
              <OperatorActionButton
                key={`${action.id}:${i}`}
                action={action}
                label={scyllaActionLabel(action, t)}
                busy={busy}
                onPick={pick}
              />
            ))}
          </div>
        </div>
      </TroubleRow>
      <ConfirmDialog
        open={pending !== null}
        title={
          pending
            ? t("operators", "confirmTitle", {
                action: t("operators", pending.label),
                target:
                  pending.input?.kind === "members"
                    ? pending.input.rack
                    : cluster.name,
              })
            : ""
        }
        description={
          pending
            ? pending.id === "restart"
              ? t("operators", "rollingRestartConfirm", {
                  cluster: cluster.name,
                  members: cluster.racks.reduce((n, r) => n + r.members, 0),
                })
              : t("operators", pending.explains)
            : undefined
        }
        confirmLabel={pending ? t("operators", pending.label) : undefined}
        confirmVariant={pending?.danger ? "destructive" : "default"}
        confirmDisabled={
          busy || (pending?.input !== undefined && value.trim() === "")
        }
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        onConfirm={() => pending && void run(pending)}
      >
        {pending?.input && (
          <div className="py-2">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono"
              inputMode={pending.input.kind === "members" ? "numeric" : "text"}
              aria-label={
                pending.input.kind === "members"
                  ? t("operators", "membersInput", { rack: pending.input.rack })
                  : t("operators", "versionInput")
              }
            />
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

function TaskLine({
  tasks,
  managed,
}: {
  tasks: ReturnType<typeof readScyllaCluster>["repairs"];
  managed: boolean;
}) {
  const t = useT();
  if (tasks.length === 0)
    return (
      <span className="text-fg-fnt">{t("operators", "noneDeclared")}</span>
    );
  return (
    <span>
      {tasks
        .map((task) =>
          [
            task.name,
            task.interval,
            task.location[0],
            task.retention !== null ? `retention ${task.retention}` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        )
        .join("; ")}
      <span className={cn("ml-2", managed ? "text-fg-fnt" : "text-warn")}>
        {managed
          ? t("operators", "taskInManager")
          : t("operators", "taskNoManager")}
      </span>
    </span>
  );
}

function FindingLine({ finding }: { finding: ScyllaFinding }) {
  const t = useT();
  const key = {
    degraded: "findingDegraded",
    unavailable: "findingUnavailable",
    progressing: "findingProgressing",
    upgrading: "findingUpgrading",
    stale: "findingStale",
    membersMissing: "findingMembersMissing",
    tasksWithoutManager: "findingTasksWithoutManager",
    noStatus: "findingNoStatus",
    conditionsUnwritten: "findingConditionsUnwritten",
    conditionsUnknown: "findingConditionsUnknown",
  } as const;
  // The upgrade's parts become the reader's words here; the model used to
  // join them into English prose and hand it to `verbatim`, which is
  // contracted to carry the controller's own words and nothing else.
  const title =
    finding.kind === "upgrading" && finding.upgrade
      ? t("operators", "findingUpgradingFromTo", {
          from: finding.upgrade.fromVersion ?? "?",
          to: finding.upgrade.toVersion ?? "?",
        })
      : t("operators", key[finding.kind]);
  const where =
    finding.kind === "upgrading" && finding.upgrade?.currentRack
      ? t("operators", "upgradeAtRack", {
          rack: finding.upgrade.currentRack,
          node: finding.upgrade.currentNode ?? "?",
        })
      : null;
  return (
    <Finding tone={finding.severity} title={title} verbatim={finding.detail}>
      {where}
    </Finding>
  );
}

function NodeConfigsTab({
  read,
}: {
  read: ReturnType<typeof useNodeConfigs>["data"];
}) {
  const t = useT();
  useShareSection("scylla-node-configs", () => nodeConfigsSection(read, t));
  if (!read)
    return (
      <p className="text-xs text-fg-fnt">{t("action", "readingInline")}</p>
    );
  if (!read.ok) {
    return (
      <Finding
        tone="warn"
        title={t("operators", "nodeConfigsUnknown")}
        verbatim={read.reason}
      />
    );
  }
  const setups = read.items.map(readNodeConfig);
  if (setups.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        {t("operators", "noNodeConfigs")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 text-xs">
      {setups.map((setup) => (
        <li key={setup.name}>
          <span className="font-mono text-fg">{setup.name}</span>
          <span className="ml-2 text-fg-mut">
            {setup.nodes === null || setup.tuned === null
              ? t("operators", "nodeStatusesNotWritten")
              : t("operators", "nodesSetUp", {
                  tuned: setup.tuned,
                  of: t("count", "ofNodes", { n: setup.nodes }),
                })}
          </span>
          {setup.unsure.length > 0 && (
            <div className="mt-1">
              <Finding
                tone="warn"
                title={t("operators", "findingConditionsUnknown")}
                verbatim={setup.unsure.join(", ")}
              />
            </div>
          )}
          {setup.problems.map((problem) => (
            <div key={problem.type} className="mt-1">
              <Finding
                tone="warn"
                title={problem.type}
                verbatim={problem.message}
              />
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

function OperatorTab({ operator }: { operator: OperatorInfo | undefined }) {
  const t = useT();
  useShareSection("scylla-operator", () => {
    const found = [
      ...(operator?.operator &&
      operator.operator.ready < operator.operator.desired
        ? [
            {
              title: operator.operator.name,
              detail: t("count", "ofTotalReady", {
                n: operator.operator.ready,
                total: operator.operator.desired,
              }),
              role: "err" as const,
              ref: refOf({
                kind: "Deployment",
                name: operator.operator.name,
                namespace: operator.operator.namespace,
              }),
            },
          ]
        : []),
      ...(operator && !operator.operatorKnown
        ? [
            {
              title: t("operators", "deploymentsUnreadable"),
              detail: operator.operatorReason,
              role: "warn" as const,
            },
          ]
        : operator && !operator.operator
          ? [
              {
                title: t("operators", "scyllaOperatorNotFound"),
                detail: null,
                role: "warn" as const,
              },
            ]
          : []),
      ...(operator?.manager && operator.manager.ready < operator.manager.desired
        ? [
            {
              title: operator.manager.name,
              detail: t("count", "ofTotalReady", {
                n: operator.manager.ready,
                total: operator.manager.desired,
              }),
              role: "err" as const,
              ref: refOf({
                kind: "Deployment",
                name: operator.manager.name,
                namespace: operator.manager.namespace,
              }),
            },
          ]
        : []),
    ];
    if (found.length === 0) return null;
    return {
      id: "scylla-operator",
      order: ORDER.own,
      title: t("operators", "operatorTab"),
      icon: iconSvg(Box),
      count: found.length,
      body: { type: "findings" as const, items: found },
    };
  });
  return (
    <div className="flex max-w-[64ch] flex-col gap-3 text-xs text-fg-mut">
      <p>{t("operators", "scyllaOperatorExplained")}</p>
      {operator?.operator ? (
        <p>
          <Link
            to={`${getResourceDetailUrl(ResourceType.Deployment, operator.operator.name, operator.operator.namespace)}?tab=logs`}
            className="text-info hover:underline"
          >
            {t("operators", "operatorLogs")}
          </Link>
        </p>
      ) : (
        <p
          className={
            operator?.operatorKnown === false ? TONE_TEXT.unknown : "text-warn"
          }
        >
          {t(
            "operators",
            operator?.operatorKnown === false
              ? "deploymentsUnreadable"
              : "scyllaOperatorNotFound"
          )}
        </p>
      )}
    </div>
  );
}

function scyllaActionLabel(action: ScyllaAction, t: T): string {
  return action.input?.kind === "members"
    ? `${t("operators", action.label)} ${action.input.rack}…`
    : action.id === "upgrade"
      ? `${t("operators", action.label)}…`
      : t("operators", action.label);
}
