import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Box, Database, Network } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SectionHeader } from "@/components/ui/section";
import { useToast } from "@/components/ui/use-toast";
import { DetailTabs } from "@/components/resources/DetailTabs";
import {
  countMark,
  viewGlyph,
  type DetailTab,
} from "@/components/resources/detail-tab";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { errorToShow } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { TONE_TEXT } from "@/lib/tone";
import { cn, formatAge, formatSince } from "@/lib/utils";
import type { CustomResourceInfo } from "@/generated/types";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, refOf } from "@/lib/report-parts";
import {
  crdObjectPath,
  crdObjectsPath,
  getValueByPath,
  troubleMark,
  allowedWord,
} from "../kit";
import { Cell, Finding, TroubleRow, VendorReadFailure } from "../page-kit";
import { BACKUP_REFUSED, actionsFor, perform, type PgAction } from "./actions";
import { backupsSection } from "./share";
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
import { useSearchParam } from "@/hooks/useSearchParam";
import { useT, type T } from "@/i18n/useT";
import { ControllerLine, Fact, OperatorActionButton } from "../operator-kit";

/**
 * The words for a failed action. Two of them are this module's own sentinels
 * — thrown where a write would have overwritten something we had not read —
 * and they become catalogue sentences here rather than reaching the toast in
 * English, which no scanner in this project would have seen.
 */
function sentenceFor(error: unknown, t: ReturnType<typeof useT>): string {
  const said = error instanceof Error ? error.message : "";
  if (said === BACKUP_REFUSED) return t("operators", "backupNotCreated");
  if (said.startsWith("the fenced-instances annotation was not read"))
    return t("operators", "fencingUnknown");
  if (said.startsWith("the whole cluster is fenced"))
    return t("operators", "fencedAllOne");
  return errorToShow(error);
}

export default function CloudNativePgPage() {
  const t = useT();
  const [tab, setTab] = useSearchParam("tab", "clusters");
  const clustersQuery = useClusters();
  const companions = useCompanions();

  const clusters = useMemo(
    () => byTrouble((clustersQuery.data ?? []).map(readCluster)),
    [clustersQuery.data]
  );
  // The verbs are asked where the Clusters actually are: a reader granted
  // `patch clusters` in one namespace answers "no" to the cluster-wide
  // question, and every button on their own cluster went dead.
  const namespaces = useMemo(
    () => [...new Set(clusters.map((c) => c.namespace))].sort(),
    [clusters]
  );
  const operator = useOperator(namespaces);

  if (clustersQuery.error) {
    return (
      <VendorReadFailure
        title={t("operators", "couldNotReadClusters")}
        error={clustersQuery.error}
        onRetry={() => void clustersQuery.refetch()}
      />
    );
  }

  const tabs: DetailTab[] = [
    {
      id: "clusters",
      label: t("operators", "clustersTab"),
      glyph: viewGlyph(Database),
      mark: troubleMark(
        clusters.map((cluster) => cluster.worst),
        (n) => t("operators", "clustersNeedAttention", { n })
      ),
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
      content: (
        <OperatorTab operator={operator.data} pending={operator.isPending} />
      ),
    },
  ];

  const activeTab = tabs.find((entry) => entry.id === tab) ?? tabs[0];
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
        onTabChange={setTab}
        actions={
          <ShareScreenAction
            screen={{
              title: `CloudNativePG · ${activeTab?.label ?? ""}`,
              icon:
                activeTab?.id === "clusters"
                  ? Database
                  : activeTab?.id === "backups"
                    ? Archive
                    : activeTab?.id === "poolers"
                      ? Network
                      : Box,
            }}
          />
        }
      />
    </div>
  );
}

/**
 * The operator itself, before its clusters: whether it is running, which
 * version, and whether the reader may act. Each a checked fact, and each
 * with the word "unknown" where the check did not answer.
 */
export function OperatorStrip({
  operator,
  pending,
}: {
  operator: OperatorInfo | undefined;
  pending: boolean;
}) {
  const t = useT();
  const now = useNow();
  return (
    <div className="grid gap-x-8 gap-y-2 text-xs md:grid-cols-2">
      <Fact label={t("operators", "controllerFact")}>
        {operator ? (
          <ControllerLine
            controller={operator.controller}
            missing={t("operators", "controllerNotFound")}
            known={operator.controllerKnown}
            reason={operator.controllerReason}
          />
        ) : pending ? (
          <span className="text-fg-fnt">{t("action", "readingInline")}</span>
        ) : (
          // The read that would say whether a controller runs did not
          // answer; "no Deployment carries the label" would be a claim
          // about a list nobody got.
          <span className={TONE_TEXT.unknown}>
            {t("operators", "deploymentsUnreadable")}
          </span>
        )}
      </Fact>
      <Fact label={t("columns", "version")}>
        {operator?.version ? (
          <span className="font-mono">{operator.version}</span>
        ) : (
          <span className="text-fg-fnt">
            {operator && !operator.controllerKnown
              ? t("operators", "deploymentsUnreadable")
              : t("operators", "versionUnknown")}
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
              {allowedWord(operator.canPatchClusters, t)}
            </span>
            <span className="mx-2 text-fg-fnt">·</span>
            <span>
              {t("operators", "canCreateBackups")}:{" "}
              {allowedWord(operator.canCreateBackups, t)}
            </span>
            <span className="ml-2 text-fg-fnt">
              {t("operators", "checkedAgo", {
                ago: formatSince(operator.checkedAt, now),
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

/** The words behind a finding, from fields the kind actually carries; never invented prose. */
function pgFindingDetail(finding: PgFinding): string | null {
  switch (finding.kind) {
    case "switchover":
    case "failover":
      return finding.reason;
    case "notReady":
    case "archivingFailing":
      return finding.message;
    case "phase":
      return finding.reason ?? finding.phase;
    case "failedInstances":
    case "fenced":
      return finding.names.join(", ");
    default:
      return null;
  }
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
  useShareSection("cloudnativepg-clusters", () => {
    const found = clusters.flatMap((cluster) => {
      if (cluster.worst === null) return [];
      const worst =
        cluster.findings.find((f) => f.severity === cluster.worst) ??
        cluster.findings[0];
      return [
        {
          title: cluster.name,
          detail: worst ? pgFindingDetail(worst) : cluster.phase,
          role: cluster.worst,
          ref: refOf({
            kind: "Cluster",
            name: cluster.name,
            namespace: cluster.namespace,
          }),
        },
      ];
    });
    if (found.length === 0) return null;
    return {
      id: "cloudnativepg-clusters",
      order: ORDER.own,
      title: t("operators", "clustersTab"),
      icon: iconSvg(Database),
      count: found.length,
      body: { type: "findings" as const, items: found },
    };
  });
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
    // The answer for this cluster's own namespace, falling back to the
    // cluster-wide one only when there is no per-namespace answer.
    patchClusters:
      operator?.patchIn.get(cluster.namespace) ??
      operator?.canPatchClusters ??
      null,
    createBackups:
      operator?.createIn.get(cluster.namespace) ??
      operator?.canCreateBackups ??
      null,
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
      // One predicate, which matches whatever the context key happens to
      // be. The `[undefined, "cloudnativepg"]` key above it matched nothing:
      // every key in this vendor starts with the real context.
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("cloudnativepg"),
      });
    } catch (error) {
      toast({
        title: t("operators", "actionFailed", {
          action: t("operators", action.label),
          cluster: cluster.name,
        }),
        description: sentenceFor(error, t),
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
              {/* `n` is what the plural resolver reads, and the noun it
               *  governs is the declared count, not the ready one. */}
              {t("operators", "readyOfDeclared", {
                ready: cluster.ready,
                n: cluster.declared,
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
                    ` · ${formatSince(new Date(cluster.archiving.since).getTime(), now)}`}
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
                  warn={instance.fenced !== false}
                  under={[
                    instance.role === "primary"
                      ? "primary"
                      : instance.role === "replica"
                        ? "replica"
                        : null,
                    instance.health === "unknown" ? null : instance.health,
                    instance.fenced === true
                      ? t("operators", "fencedWord")
                      : instance.fenced === null
                        ? t("operators", "fencedUnknownWord")
                        : null,
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
                <OperatorActionButton
                  key={action.id}
                  action={action}
                  label={pgActionLabel(action, t)}
                  busy={busy}
                  onPick={setPending}
                />
              ))}
            {actions
              .filter((a) => a.id === "fence" || a.id === "unfence")
              .map((action) => (
                <OperatorActionButton
                  key={`${action.id}:${action.instance}`}
                  action={action}
                  label={pgActionLabel(action, t)}
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
              ? formatSince(new Date(finding.since).getTime(), now)
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
    case "fencedUnknown":
      return (
        <Finding tone="warn" title={t("operators", "findingFencedUnknown")}>
          {t("operators", "fencingUnknown")}
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
    case "failover":
      return (
        <Finding
          tone="err"
          title={t("operators", "findingFailover", {
            from: cluster.primary ?? "?",
          })}
          verbatim={finding.reason}
        >
          {t("operators", "failoverExplained")}
        </Finding>
      );
    case "phaseUnwritten":
      return (
        <Finding tone="warn" title={t("operators", "findingPhaseUnwritten")}>
          {t("operators", "phaseUnwrittenExplained")}
        </Finding>
      );
    default:
      // The switch is the whole map from finding to words. A kind with no
      // arm used to render nothing at all, silently — this makes the
      // compiler refuse a new one until it has been given words.
      return exhausted(finding);
  }
}

/** A `never` the compiler checks; unreachable, so it says nothing on screen. */
function exhausted(_: never): null {
  return null;
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
              ago: formatSince(
                new Date(backups.lastCompletedAt).getTime(),
                now
              ),
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
  useShareSection("cloudnativepg-backups", () => backupsSection(companions, t));
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

function OperatorTab({
  operator,
  pending,
}: {
  operator: OperatorInfo | undefined;
  /** The read has not answered yet, which is not the same as answering no. */
  pending: boolean;
}) {
  const t = useT();
  useShareSection("cloudnativepg-operator", () => {
    const found = [
      ...(operator?.controller &&
      operator.controller.ready < operator.controller.desired
        ? [
            {
              title: operator.controller.name,
              detail: t("count", "ofTotalReady", {
                n: operator.controller.ready,
                total: operator.controller.desired,
              }),
              role: "err" as const,
              ref: refOf({
                kind: "Deployment",
                name: operator.controller.name,
                namespace: operator.controller.namespace,
              }),
            },
          ]
        : []),
      ...(operator && !operator.controllerKnown
        ? [
            {
              title: t("operators", "deploymentsUnreadable"),
              detail: operator.controllerReason,
              role: "warn" as const,
            },
          ]
        : operator && !operator.controller
          ? [
              {
                title: t("operators", "controllerNotFound"),
                detail: null,
                role: "warn" as const,
              },
            ]
          : []),
    ];
    if (found.length === 0) return null;
    return {
      id: "cloudnativepg-operator",
      order: ORDER.own,
      title: t("operators", "operatorTab"),
      icon: iconSvg(Box),
      count: found.length,
      body: { type: "findings" as const, items: found },
    };
  });
  return (
    <div className="flex max-w-[64ch] flex-col gap-3 text-xs text-fg-mut">
      <p>{t("operators", "cnpgOperatorExplained")}</p>
      {pending ? (
        <p className="text-fg-fnt">{t("action", "readingInline")}</p>
      ) : operator?.controller ? (
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
      ) : operator && !operator.controllerKnown ? (
        <p
          className={TONE_TEXT.unknown}
          title={operator.controllerReason ?? undefined}
        >
          {t("operators", "deploymentsUnreadable")}
        </p>
      ) : (
        <p className="text-warn">{t("operators", "controllerNotFound")}</p>
      )}
    </div>
  );
}

function pgActionLabel(action: PgAction, t: T): string {
  return action.instance
    ? `${t("operators", action.label)} ${action.instance}`
    : t("operators", action.label);
}
