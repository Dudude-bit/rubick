import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Box, HardDrive, Layers } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Section, SectionHeader } from "@/components/ui/section";
import { useToast } from "@/components/ui/use-toast";
import { DetailTabs } from "@/components/resources/DetailTabs";
import {
  countMark,
  severityMark,
  viewGlyph,
  type DetailTab,
  type DetailTabMark,
} from "@/components/resources/detail-tab";
import { useNow } from "@/hooks/useNow";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { agoOf } from "@/lib/usage-history";
import { cn } from "@/lib/utils";
import { Cell, Finding, TroubleRow } from "../page-kit";
import { actionsFor, perform, type ScyllaAction } from "./actions";
import {
  CLUSTERS_CRD,
  useClusters,
  useNodeConfigs,
  useOperator,
  type Controller,
  type OperatorInfo,
} from "./data";
import {
  byTrouble,
  readNodeConfig,
  readScyllaCluster,
  type ScyllaCluster,
  type ScyllaFinding,
} from "./model";
import { useT, type T } from "@/i18n/useT";

export default function ScyllaPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "clusters";
  const clustersQuery = useClusters();
  const operator = useOperator();
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

  if (clustersQuery.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("operators", "couldNotReadScyllaClusters")}
        </h2>
        <p className="text-[11px] text-fg-fnt">{clustersQuery.error.message}</p>
      </Section>
    );
  }

  const troubled = clusters.filter((c) => c.worst !== null);
  const tabs: DetailTab[] = [
    {
      id: "clusters",
      label: t("operators", "clustersTab"),
      glyph: viewGlyph(Layers),
      mark: clustersMark(t, clusters, troubled.length),
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
        onTabChange={(next) => {
          const updated = new URLSearchParams(params);
          updated.set("tab", next);
          setParams(updated, { replace: true });
        }}
      />
    </div>
  );
}

function clustersMark(
  t: T,
  clusters: ScyllaCluster[],
  troubled: number
): DetailTabMark | undefined {
  if (clusters.length === 0) return undefined;
  if (troubled === 0) return countMark(clusters.length);
  const worst = clusters.some((c) => c.worst === "err") ? "err" : "warn";
  return severityMark(
    worst,
    t("operators", "clustersNeedAttention", { n: troubled })
  );
}

function ControllerLine({
  controller,
  missing,
}: {
  controller: Controller | null;
  missing: string;
}) {
  const t = useT();
  if (!controller) return <span className="text-warn">{missing}</span>;
  return (
    <>
      <Link
        to={getResourceDetailUrl(
          ResourceType.Deployment,
          controller.name,
          controller.namespace
        )}
        className={cn(
          "font-mono hover:underline",
          controller.ready < controller.desired ? "text-err" : "text-fg"
        )}
      >
        {controller.name} {controller.ready}/{controller.desired}
      </Link>
      <span className="ml-2 text-fg-fnt">
        {t("operators", "inNamespace", { namespace: controller.namespace })}
      </span>
    </>
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
  const yesNo = (allowed: boolean | null) =>
    allowed === null
      ? t("operators", "couldNotTell")
      : allowed
        ? t("operators", "allowed")
        : t("operators", "refused");
  return (
    <div className="grid gap-x-8 gap-y-2 text-xs md:grid-cols-2">
      <Fact label={t("operators", "controllerFact")}>
        <ControllerLine
          controller={operator.operator}
          missing={t("operators", "scyllaOperatorNotFound")}
        />
      </Fact>
      <Fact label={t("columns", "version")}>
        {operator.version ? (
          <span className="font-mono">{operator.version}</span>
        ) : (
          <span className="text-fg-fnt">
            {t("operators", "versionUnknown")}
          </span>
        )}
      </Fact>
      <Fact label="ScyllaDB Manager">
        {operator.manager ? (
          <>
            <ControllerLine controller={operator.manager} missing="" />
            <span className="ml-2 text-fg-fnt">
              {t("operators", "managerPresent")}
            </span>
          </>
        ) : (
          <span className="text-warn">{t("operators", "managerAbsent")}</span>
        )}
      </Fact>
      <Fact label={t("operators", "canActFact")}>
        {t("operators", "canPatchScyllaClusters")}:{" "}
        {yesNo(operator.canPatchClusters)}
        <span className="ml-2 text-fg-fnt">
          {t("operators", "checkedAgo", {
            ago: agoOf(operator.checkedAt, now),
          })}
        </span>
      </Fact>
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-28 flex-none text-[11px] text-fg-fnt">{label}</span>
      <span className="min-w-0">{children}</span>
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
  const actions = actionsFor(cluster, operator?.canPatchClusters ?? null);
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
      toast({
        title: t("operators", "actionFailed", {
          action: t("operators", action.label),
          cluster: cluster.name,
        }),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
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
                : t("operators", "readyOfDeclared", {
                    ready: cluster.readyMembers,
                    declared:
                      cluster.members ??
                      cluster.racks.reduce((n, r) => n + r.members, 0),
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
                    rack.ready < rack.members && !cluster.silent && "text-warn"
                  )}
                >
                  {t("operators", "readyOfDeclared", {
                    ready: rack.ready,
                    declared: rack.members,
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
              <ActionButton
                key={`${action.id}:${i}`}
                action={action}
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

function ActionButton({
  action,
  busy,
  onPick,
}: {
  action: ScyllaAction;
  busy: boolean;
  onPick: (action: ScyllaAction) => void;
}) {
  const t = useT();
  const label =
    action.input?.kind === "members"
      ? `${t("operators", action.label)} ${action.input.rack}…`
      : action.id === "upgrade"
        ? `${t("operators", action.label)}…`
        : t("operators", action.label);
  return (
    <button
      type="button"
      disabled={busy || action.reason !== null}
      onClick={() => onPick(action)}
      title={
        action.reason
          ? t("operators", action.reason)
          : t("operators", action.explains)
      }
      className={cn(
        "rounded border border-hair px-1.5 py-0.5 transition-colors",
        action.danger
          ? "text-err hover:bg-err/10"
          : "text-fg-mut hover:bg-hover hover:text-fg",
        (busy || action.reason !== null) && "cursor-not-allowed opacity-50"
      )}
    >
      {label}
      {action.reason && (
        <span className="ml-1 text-fg-fnt">
          · {t("operators", action.reason)}
        </span>
      )}
    </button>
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
  } as const;
  return (
    <Finding
      tone={finding.severity}
      title={t("operators", key[finding.kind])}
      verbatim={finding.detail}
    />
  );
}

function NodeConfigsTab({
  read,
}: {
  read: ReturnType<typeof useNodeConfigs>["data"];
}) {
  const t = useT();
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
            {t("operators", "nodesSetUp", {
              tuned: setup.tuned,
              nodes: setup.nodes,
            })}
          </span>
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
        <p className="text-warn">{t("operators", "scyllaOperatorNotFound")}</p>
      )}
    </div>
  );
}
