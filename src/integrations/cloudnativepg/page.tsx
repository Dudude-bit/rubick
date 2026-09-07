import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Box, Database, Network } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { formatAge } from "@/lib/utils";
import { agoOf } from "@/lib/usage-history";
import { cn } from "@/lib/utils";
import type { CustomResourceInfo } from "@/generated/types";
import { crdObjectPath, crdObjectsPath, getValueByPath } from "../kit";
import { Cell, Finding, TroubleRow } from "../page-kit";
import { actionsFor, perform, type PgAction } from "./actions";
import {
  BACKUPS_CRD,
  CLUSTERS_CRD,
  POOLERS_CRD,
  useClusters,
  useCompanions,
  useOperator,
  type Companions,
  type OperatorInfo,
} from "./data";
import {
  backupsOf,
  byTrouble,
  readCluster,
  readPooler,
  schedulesOf,
  type PgCluster,
  type PgFinding,
} from "./model";
import { useNow } from "@/hooks/useNow";
import { useT, type T } from "@/i18n/useT";

export default function CloudNativePgPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "clusters";
  const clustersQuery = useClusters();
  const companions = useCompanions();
  const operator = useOperator();

  const clusters = useMemo(
    () => byTrouble((clustersQuery.data ?? []).map(readCluster)),
    [clustersQuery.data]
  );

  if (clustersQuery.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("operators", "couldNotReadClusters")}
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
      glyph: viewGlyph(Database),
      mark: clustersMark(t, clusters, troubled.length),
      content: (
        <ClustersTab
          clusters={clusters}
          loading={clustersQuery.isPending}
          companions={companions.data}
          operator={operator.data}
        />
      ),
    },
    {
      id: "backups",
      label: t("operators", "backupsTab"),
      glyph: viewGlyph(Archive),
      mark:
        companions.data?.backups.ok && companions.data.backups.items.length > 0
          ? countMark(companions.data.backups.items.length)
          : undefined,
      content: <BackupsTab companions={companions.data} />,
    },
    {
      id: "poolers",
      label: t("operators", "poolersTab"),
      glyph: viewGlyph(Network),
      mark:
        companions.data?.poolers.ok && companions.data.poolers.items.length > 0
          ? countMark(companions.data.poolers.items.length)
          : undefined,
      content: <PoolersTab companions={companions.data} />,
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
        title="CloudNativePG"
        count={
          clustersQuery.isPending
            ? undefined
            : t("empty", "acrossEveryNamespace", {
                count: t("readings", "kindCount", {
                  n: clusters.length,
                  kind: "Cluster",
                }),
              })
        }
        description={t("operators", "cnpgPageDescription")}
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
  clusters: PgCluster[],
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

/**
 * The operator itself, before its clusters: whether it is running, which
 * version, and whether the reader may act. Each a checked fact, and each
 * with the word "unknown" where the check did not answer.
 */
function OperatorStrip({
  operator,
  pending,
}: {
  operator: OperatorInfo | undefined;
  pending: boolean;
}) {
  const t = useT();
  const now = useNow();
  const yesNo = (allowed: boolean | null) =>
    allowed === null
      ? t("operators", "couldNotTell")
      : allowed
        ? t("operators", "allowed")
        : t("operators", "refused");
  return (
    <div className="grid gap-x-8 gap-y-2 text-xs md:grid-cols-2">
      <Fact label={t("operators", "controllerFact")}>
        {pending ? (
          <span className="text-fg-fnt">{t("action", "readingInline")}</span>
        ) : operator?.controller ? (
          <Link
            to={getResourceDetailUrl(
              ResourceType.Deployment,
              operator.controller.name,
              operator.controller.namespace
            )}
            className={cn(
              "font-mono hover:underline",
              operator.controller.ready < operator.controller.desired
                ? "text-err"
                : "text-fg"
            )}
          >
            {operator.controller.name} {operator.controller.ready}/
            {operator.controller.desired}
          </Link>
        ) : (
          <span className="text-warn">
            {t("operators", "controllerNotFound")}
          </span>
        )}
        {operator?.controller && (
          <span className="ml-2 text-fg-fnt">
            {t("operators", "inNamespace", {
              namespace: operator.controller.namespace,
            })}
          </span>
        )}
      </Fact>
      <Fact label={t("columns", "version")}>
        {operator?.version ? (
          <span className="font-mono">{operator.version}</span>
        ) : (
          <span className="text-fg-fnt">
            {t("operators", "versionUnknown")}
          </span>
        )}
        {operator?.version && (
          <span className="ml-2 text-fg-fnt">
            {t("operators", "fromImage")}
          </span>
        )}
      </Fact>
      <Fact label={t("operators", "canActFact")}>
        {operator ? (
          <>
            <span>
              {t("operators", "canPatchClusters")}:{" "}
              {yesNo(operator.canPatchClusters)}
            </span>
            <span className="mx-2 text-fg-fnt">·</span>
            <span>
              {t("operators", "canCreateBackups")}:{" "}
              {yesNo(operator.canCreateBackups)}
            </span>
            <span className="ml-2 text-fg-fnt">
              {t("operators", "checkedAgo", {
                ago: agoOf(operator.checkedAt, now),
              })}
            </span>
          </>
        ) : (
          <span className="text-fg-fnt">{t("action", "readingInline")}</span>
        )}
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
  companions,
  operator,
}: {
  clusters: PgCluster[];
  loading: boolean;
  companions: Companions | undefined;
  operator: OperatorInfo | undefined;
}) {
  const t = useT();
  if (loading) {
    return (
      <p className="text-xs text-fg-fnt">{t("action", "readingInline")}</p>
    );
  }
  if (clusters.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        {t("operators", "noClusters")}
      </p>
    );
  }
  return (
    <div>
      {clusters.map((cluster, index) => (
        <ClusterRow
          key={cluster.uid}
          cluster={cluster}
          companions={companions}
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
  companions,
  operator,
  openByDefault,
  last,
}: {
  cluster: PgCluster;
  companions: Companions | undefined;
  operator: OperatorInfo | undefined;
  openByDefault: boolean;
  last: boolean;
}) {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PgAction | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const backups = companions ? backupsOf(cluster, companions.backups) : null;
  const schedules = companions
    ? schedulesOf(cluster, companions.scheduled)
    : null;
  const actions = actionsFor(cluster, {
    patchClusters: operator?.canPatchClusters ?? null,
    createBackups: operator?.canCreateBackups ?? null,
  });

  const run = async (action: PgAction) => {
    setBusy(true);
    try {
      await perform(action, cluster);
      toast({
        title: t("operators", "actionDone", {
          action: t("operators", action.label),
          cluster: cluster.name,
        }),
      });
      await queryClient.invalidateQueries({
        queryKey: [undefined, "cloudnativepg"],
      });
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("cloudnativepg"),
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

  return (
    <>
      <TroubleRow
        title={cluster.name}
        reference={{
          kind: "Cluster",
          name: cluster.name,
          namespace: cluster.namespace,
          crd: CLUSTERS_CRD,
        }}
        meta={
          <span className="text-fg-fnt">
            {cluster.namespace}
            {cluster.postgresVersion &&
              ` · PostgreSQL ${cluster.postgresVersion}`}
          </span>
        }
        state={{
          text: cluster.phase ?? t("operators", "phaseUnknown"),
          tone: TONE_OF[cluster.worst ?? "none"],
        }}
        openByDefault={openByDefault}
        last={last}
      >
        <div className="flex flex-col gap-3">
          {cluster.findings.length > 0 && (
            <div className="flex flex-col gap-2">
              {cluster.findings.map((finding, i) => (
                <FindingLine
                  key={i}
                  finding={finding}
                  cluster={cluster}
                  now={now}
                />
              ))}
            </div>
          )}
          <div className="grid gap-x-6 gap-y-1.5 text-xs md:grid-cols-2">
            <Fact label={t("operators", "primaryFact")}>
              <span className="font-mono">{cluster.primary ?? "–"}</span>
              {cluster.switchingOver && (
                <span className="ml-2 font-mono text-warn">
                  → {cluster.targetPrimary}
                </span>
              )}
            </Fact>
            <Fact label={t("operators", "readyFact")}>
              {t("operators", "readyOfDeclared", {
                ready: cluster.ready,
                declared: cluster.declared,
              })}
              {cluster.readyCondition.status === "False" && (
                <span className="ml-2 text-err">
                  {t("operators", "readyConditionFalse")}
                </span>
              )}
            </Fact>
            <Fact label={t("operators", "archivingFact")}>
              {cluster.archiving.status === null ? (
                <span className="text-fg-fnt">
                  {t("operators", "archivingNotDeclared")}
                </span>
              ) : (
                <span
                  className={
                    cluster.archiving.status === "False" ? "text-err" : ""
                  }
                >
                  ContinuousArchiving {cluster.archiving.status}
                  {cluster.archiving.reason && ` · ${cluster.archiving.reason}`}
                  {cluster.archiving.since &&
                    ` · ${agoOf(new Date(cluster.archiving.since).getTime(), now)}`}
                </span>
              )}
            </Fact>
            <Fact label={t("operators", "backupsFact")}>
              <BackupsLine backups={backups} schedules={schedules} now={now} />
            </Fact>
            <Fact label={t("nav", "storage")}>
              {cluster.pvcCount !== null ? `${cluster.pvcCount} × ` : ""}
              {cluster.storage.size ?? "–"}
              {cluster.storage.storageClass &&
                ` ${cluster.storage.storageClass}`}
            </Fact>
            <Fact label={t("operators", "specSeenFact")}>
              <span className="text-fg-fnt">
                {t("operators", "specSeenUnknownCnpg")}
              </span>
            </Fact>
          </div>
          {cluster.instances.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {cluster.instances.map((instance) => (
                <Cell
                  key={instance.name}
                  bad={instance.health === "failed"}
                  warn={instance.fenced}
                  under={[
                    instance.role === "primary"
                      ? "primary"
                      : instance.role === "replica"
                        ? "replica"
                        : null,
                    instance.health === "unknown" ? null : instance.health,
                    instance.fenced ? t("operators", "fencedWord") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {instance.name}
                </Cell>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {actions
              .filter((a) => a.id !== "fence" && a.id !== "unfence")
              .map((action) => (
                <ActionButton
                  key={action.id}
                  action={action}
                  busy={busy}
                  onPick={setPending}
                />
              ))}
            {actions
              .filter((a) => a.id === "fence" || a.id === "unfence")
              .map((action) => (
                <ActionButton
                  key={`${action.id}:${action.instance}`}
                  action={action}
                  busy={busy}
                  onPick={setPending}
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
                target: pending.instance ?? cluster.name,
              })
            : ""
        }
        description={pending ? t("operators", pending.explains) : undefined}
        confirmLabel={pending ? t("operators", pending.label) : undefined}
        confirmVariant={pending?.danger ? "destructive" : "default"}
        confirmDisabled={busy}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        onConfirm={() => pending && void run(pending)}
      />
    </>
  );
}

function ActionButton({
  action,
  busy,
  onPick,
}: {
  action: PgAction;
  busy: boolean;
  onPick: (action: PgAction) => void;
}) {
  const t = useT();
  const label = action.instance
    ? `${t("operators", action.label)} ${action.instance}`
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

function FindingLine({
  finding,
  cluster,
  now,
}: {
  finding: PgFinding;
  cluster: PgCluster;
  now: number;
}) {
  const t = useT();
  switch (finding.kind) {
    case "notReady":
      return (
        <Finding
          tone="err"
          title={t("operators", "findingNotReady")}
          verbatim={finding.message}
        />
      );
    case "archivingFailing":
      return (
        <Finding
          tone="err"
          title={t("operators", "findingArchivingFailing", {
            ago: finding.since
              ? agoOf(new Date(finding.since).getTime(), now)
              : "?",
          })}
          verbatim={finding.message}
        />
      );
    case "failedInstances":
      return (
        <Finding
          tone="err"
          title={t("operators", "findingFailedInstances", {
            names: finding.names.join(", "),
          })}
        />
      );
    case "switchover":
      return (
        <Finding
          tone="warn"
          title={t("operators", "findingSwitchover", {
            from: cluster.primary ?? "?",
            to: cluster.targetPrimary ?? "?",
          })}
          verbatim={finding.reason}
        />
      );
    case "fenced":
      return (
        <Finding
          tone="warn"
          title={t("operators", "findingFenced", {
            names: finding.names.join(", "),
          })}
        >
          {t("operators", "fencedExplained")}
        </Finding>
      );
    case "hibernated":
      return (
        <Finding tone="warn" title={t("operators", "findingHibernated")}>
          {t("operators", "hibernatedExplained")}
        </Finding>
      );
    case "phase":
      return (
        <Finding tone="warn" title={finding.phase} verbatim={finding.reason} />
      );
  }
}

function BackupsLine({
  backups,
  schedules,
  now,
}: {
  backups: ReturnType<typeof backupsOf> | null;
  schedules: ReturnType<typeof schedulesOf> | null;
  now: number;
}) {
  const t = useT();
  if (backups === null) {
    return <span className="text-fg-fnt">{t("action", "readingInline")}</span>;
  }
  if (backups.state === "unknown") {
    return (
      <span className="text-warn" title={backups.reason ?? undefined}>
        {t("operators", "backupsUnknown")}
      </span>
    );
  }
  const schedule = schedules?.[0];
  return (
    <span>
      {backups.state === "none"
        ? t("operators", "backupsNone")
        : backups.lastCompletedAt
          ? t("operators", "backupsLastCompleted", {
              ago: agoOf(new Date(backups.lastCompletedAt).getTime(), now),
              n: backups.total,
            })
          : t("operators", "backupsNoneCompleted", { n: backups.total })}
      {backups.lastPhase === "failed" && backups.lastError && (
        <span className="ml-2 text-err">{backups.lastError}</span>
      )}
      {schedule && (
        <span className="ml-2 text-fg-fnt">
          · {schedule.name} {schedule.schedule ?? ""}
          {schedule.suspended ? ` (${t("operators", "suspendedWord")})` : ""}
        </span>
      )}
      {schedules === null && (
        <span className="ml-2 text-warn">
          {t("operators", "schedulesUnknown")}
        </span>
      )}
    </span>
  );
}

function BackupsTab({ companions }: { companions: Companions | undefined }) {
  const t = useT();
  if (!companions) {
    return (
      <p className="text-xs text-fg-fnt">{t("action", "readingInline")}</p>
    );
  }
  if (!companions.backups.ok) {
    return (
      <Finding
        tone="warn"
        title={t("operators", "backupsUnknown")}
        verbatim={companions.backups.reason}
      />
    );
  }
  const backups = [...companions.backups.items].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
  );
  return (
    <div className="flex flex-col gap-3">
      {backups.length === 0 ? (
        <p className="text-xs text-fg-mut">
          {t("operators", "noBackupObjects")}
        </p>
      ) : (
        <ul className="divide-y divide-hair text-xs">
          {backups.map((backup) => (
            <BackupLine key={backup.uid} backup={backup} />
          ))}
        </ul>
      )}
      <p className="text-[11px] text-fg-fnt">
        <Link
          to={crdObjectsPath(BACKUPS_CRD)}
          className="text-info hover:underline"
        >
          {t("operators", "allBackupObjects")}
        </Link>
      </p>
    </div>
  );
}

function BackupLine({ backup }: { backup: CustomResourceInfo }) {
  const t = useT();
  const phase = String(getValueByPath(backup, "status.phase") ?? "–");
  const error = getValueByPath(backup, "status.error");
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 py-1.5">
      <Link
        to={crdObjectPath(BACKUPS_CRD, backup.namespace, backup.name)}
        className="font-mono text-fg hover:underline"
      >
        {backup.name}
      </Link>
      <span className="text-fg-fnt">
        {String(getValueByPath(backup, "spec.cluster.name") ?? "")}
      </span>
      <span className={cn(phase === "failed" && "text-err")}>{phase}</span>
      <span className="text-fg-fnt">{formatAge(backup.createdAt, t)}</span>
      {typeof error === "string" && error && (
        <span className="font-mono text-[11px] text-err">{error}</span>
      )}
    </li>
  );
}

function PoolersTab({ companions }: { companions: Companions | undefined }) {
  const t = useT();
  if (!companions) {
    return (
      <p className="text-xs text-fg-fnt">{t("action", "readingInline")}</p>
    );
  }
  if (!companions.poolers.ok) {
    return (
      <Finding
        tone="warn"
        title={t("operators", "poolersUnknown")}
        verbatim={companions.poolers.reason}
      />
    );
  }
  const poolers = companions.poolers.items.map(readPooler);
  if (poolers.length === 0) {
    return <p className="text-xs text-fg-mut">{t("operators", "noPoolers")}</p>;
  }
  return (
    <ul className="divide-y divide-hair text-xs">
      {poolers.map((pooler) => (
        <li
          key={`${pooler.namespace}/${pooler.name}`}
          className="flex flex-wrap items-baseline gap-x-3 py-1.5"
        >
          <Link
            to={crdObjectPath(POOLERS_CRD, pooler.namespace, pooler.name)}
            className="font-mono text-fg hover:underline"
          >
            {pooler.name}
          </Link>
          <span className="text-fg-fnt">
            {pooler.namespace} · {pooler.cluster}
          </span>
          <span>
            {pooler.type ?? "–"}
            {pooler.poolMode && ` · pgbouncer ${pooler.poolMode}`}
            {pooler.instances !== null && ` · ${pooler.instances}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function OperatorTab({ operator }: { operator: OperatorInfo | undefined }) {
  const t = useT();
  return (
    <div className="flex max-w-[64ch] flex-col gap-3 text-xs text-fg-mut">
      <p>{t("operators", "cnpgOperatorExplained")}</p>
      {operator?.controller ? (
        <p>
          <Link
            to={`${getResourceDetailUrl(
              ResourceType.Deployment,
              operator.controller.name,
              operator.controller.namespace
            )}?tab=logs`}
            className="text-info hover:underline"
          >
            {t("operators", "operatorLogs")}
          </Link>
        </p>
      ) : (
        <p className="text-warn">{t("operators", "controllerNotFound")}</p>
      )}
    </div>
  );
}
