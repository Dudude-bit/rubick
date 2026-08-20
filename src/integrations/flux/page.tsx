/**
 * Flux's page: two tabs, because Flux has two kinds of object.
 *
 * A `GitRepository` fetches and a `Kustomization` applies, and several
 * appliers share one source. Drawing them as one list would need a source
 * column that is the same value on six rows and a "revision" that means
 * something different on each — and it would lose the only thing worth
 * knowing, which is that one broken fetch freezes everything under it.
 *
 * There is no vendor UI to hand anything to. Flux ships no dashboard, so
 * unlike Argo's page this one has no "and the rest is over there": every fact
 * a reader can have about a Flux install is on this screen or in a controller
 * log, and both are linked from here.
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Box, GitBranch, Layers } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { DetailTabs } from "@/components/resources/DetailTabs";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  countMark,
  severityMark,
  viewGlyph,
  type DetailTab,
  type DetailTabMark,
} from "@/components/resources/detail-tab";
import { formatAge } from "@/lib/utils";
import { gitRepoLink } from "../gitops";
import {
  Chain,
  Cell,
  Column,
  FilterBox,
  Finding,
  OutLink,
  TroubleRow,
} from "../page-kit";
import {
  HELM_RELEASES_CRD,
  KUSTOMIZATIONS_CRD,
  SOURCE_KINDS,
  useControllers,
  usePicture,
  type FluxController,
} from "./data";
import {
  reconcilerState,
  revisionText,
  sourceState,
  type FluxFinding,
  type FluxReconciler,
  type FluxSource,
} from "./model";
import { useT } from "@/i18n/useT";

/** Past this many broken reconcilers, nothing opens itself. */
const AUTO_OPEN = 8;

const crdOf = (kind: string): string | null =>
  kind === "Kustomization"
    ? KUSTOMIZATIONS_CRD
    : kind === "HelmRelease"
      ? HELM_RELEASES_CRD
      : (SOURCE_KINDS.find(([name]) => name === kind)?.[1] ?? null);

export default function FluxPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "reconcilers";

  const picture = usePicture();
  const controllers = useControllers();

  const reconcilers = picture.data?.reconcilers ?? [];
  const sources = picture.data?.sources ?? [];

  if (picture.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("empty", "couldNotReadFlux")}
        </h2>
        <p className="text-xs text-fg-mut">
          {t("empty", "couldNotReadFluxBody")}
        </p>
        <p className="text-[11px] text-fg-fnt">{picture.error.message}</p>
      </Section>
    );
  }

  const tabs: DetailTab[] = [
    {
      id: "reconcilers",
      label: t("nav", "reconcilers"),
      glyph: viewGlyph(Layers),
      mark: markFor(
        reconcilers.map((entry) => entry.worst),
        t
      ),
      content: (
        <ReconcilersTab reconcilers={reconcilers} loading={picture.isPending} />
      ),
    },
    {
      id: "sources",
      label: t("nav", "sources"),
      glyph: viewGlyph(GitBranch),
      mark: markFor(
        sources.map((entry) => entry.worst),
        t
      ),
      content: <SourcesTab sources={sources} loading={picture.isPending} />,
    },
    {
      id: "controllers",
      label: t("nav", "controllers"),
      glyph: viewGlyph(Box),
      mark:
        controllers.data && controllers.data.length > 0
          ? countMark(controllers.data.length)
          : undefined,
      content: <ControllersTab controllers={controllers.data} />,
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="Flux"
        count={
          picture.isPending
            ? undefined
            : t("count", "reconcilersFromSources", {
                n: reconcilers.length,
                sources: t("count", "sources", { n: sources.length }),
              })
        }
        description={t("empty", "fluxPageDescription")}
      />
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

function markFor(
  worsts: Array<"err" | "warn" | null>,
  t: ReturnType<typeof useT>
): DetailTabMark | undefined {
  if (worsts.length === 0) return undefined;
  const troubled = worsts.filter((worst) => worst !== null).length;
  if (troubled === 0) return countMark(worsts.length);
  return severityMark(
    worsts.includes("err") ? "err" : "warn",
    t("count", "needAttentionOfTotal", { n: troubled, total: worsts.length })
  );
}

// --- reconcilers --------------------------------------------------------

function ReconcilersTab({
  reconcilers,
  loading,
}: {
  reconcilers: FluxReconciler[];
  loading: boolean;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return reconcilers;
    return reconcilers.filter(
      (reconciler) =>
        reconciler.name.toLowerCase().includes(needle) ||
        reconciler.namespace.toLowerCase().includes(needle) ||
        reconciler.unit.toLowerCase().includes(needle) ||
        (reconciler.sourceRef?.name ?? "").toLowerCase().includes(needle)
    );
  }, [reconcilers, filter]);

  if (loading) {
    return (
      <p className="text-xs text-fg-fnt">
        {t("empty", "readingWhatFluxApplies")}
      </p>
    );
  }

  if (reconcilers.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          {t("empty", "fluxApplyingNothing")}
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          {t("empty", "fluxNoReconcilers")}
        </p>
      </div>
    );
  }

  const broken = reconcilers.filter(
    (reconciler) => reconciler.worst === "err"
  ).length;
  const worthALook = reconcilers.filter(
    (reconciler) => reconciler.worst === "warn"
  ).length;

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center gap-3">
        <FilterBox
          value={filter}
          onChange={setFilter}
          placeholder={t("action", "filterReconcilersPlaceholder")}
          label={t("action", "filterReconcilers")}
        />
        <span className="text-[11px] text-fg-fnt">
          {filter.trim() !== ""
            ? t("count", "shownOfTotal", {
                n: shown.length,
                total: reconcilers.length,
              })
            : broken > 0
              ? `${t("count", "notReconcilingAndFirst", { n: broken, total: reconcilers.length })}${
                  worthALook > 0
                    ? ` · ${t("count", "worthALook", { n: worthALook })}`
                    : ""
                }`
              : worthALook > 0
                ? `${t("empty", "nothingFailing")} · ${t("count", "worthALookOfTotal", { n: worthALook, total: reconcilers.length })}`
                : t("count", "reconcilersAllApplied", {
                    n: reconcilers.length,
                  })}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-xs text-fg-fnt">
          {t("empty", "noReconcilerMatches")}
        </p>
      ) : (
        shown.map((reconciler, index) => (
          <ReconcilerRow
            key={`${reconciler.kind}/${reconciler.key}`}
            reconciler={reconciler}
            openByDefault={reconciler.worst === "err" && broken <= AUTO_OPEN}
            last={index === shown.length - 1}
          />
        ))
      )}
    </div>
  );
}

function ReconcilerRow({
  reconciler,
  openByDefault,
  last,
}: {
  reconciler: FluxReconciler;
  openByDefault: boolean;
  last: boolean;
}) {
  const t = useT();
  const state = reconcilerState(reconciler);
  const source = reconciler.source;

  return (
    <TroubleRow
      title={reconciler.name}
      meta={
        <>
          {reconciler.kind} · {reconciler.namespace}
          {reconciler.kind === "HelmRelease"
            ? ` · chart ${reconciler.unit}`
            : ` · ${reconciler.unit}`}
          {reconciler.interval && ` · every ${reconciler.interval}`}
        </>
      }
      state={state}
      openByDefault={openByDefault}
      last={last}
      brief={
        reconciler.findings.length > 0 ? (
          <Findings reconciler={reconciler} brief />
        ) : undefined
      }
    >
      <Chain>
        <Column label={t("columns", "source")}>
          {reconciler.sourceRef ? (
            <Cell
              bad={source?.ready === false || !source}
              under={
                !source
                  ? t("empty", "notInThisCluster")
                  : source.ready === false
                    ? t("empty", "fetchFailingLower")
                    : (source.ref ?? t("empty", "fetchedLower"))
              }
            >
              {reconciler.sourceRef.kind} {reconciler.sourceRef.name}
            </Cell>
          ) : (
            <Cell bad under={t("empty", "nothingToApplyFrom")}>
              {t("empty", "noneLower")}
            </Cell>
          )}
        </Column>
        <Column label={t("columns", "revision")}>
          <Cell
            under={
              // Only a Kustomization's revision is comparable to its source's:
              // a HelmRepository's artifact is a digest of the chart index and
              // says nothing about which chart version is installed.
              reconciler.kind === "Kustomization" &&
              reconciler.applied &&
              source?.artifact?.revision?.commit &&
              source.artifact.revision.commit !== reconciler.applied.commit
                ? t("empty", "sourceHasRevision", {
                    revision: revisionText(source.artifact.revision),
                  })
                : reconciler.lastReconciledAt
                  ? t("action", "agoSuffix", {
                      age: formatAge(reconciler.lastReconciledAt),
                    })
                  : t("empty", "neverApplied")
            }
          >
            {reconciler.applied
              ? t("empty", "appliedRevision", {
                  revision: revisionText(reconciler.applied),
                })
              : t("empty", "nothingApplied")}
          </Cell>
        </Column>
        <Column label={reconciler.kind}>
          <Cell
            bad={state.tone === "err"}
            under={
              reconciler.suspended
                ? t("empty", "suspendedLower")
                : reconciler.unit
            }
          >
            {reconciler.name}
          </Cell>
        </Column>
        <Column label={t("columns", "objects")}>
          <Cell
            under={
              reconciler.kind === "HelmRelease"
                ? t("empty", "heldInHelmStorage")
                : reconciler.applied
                  ? t("empty", "fromRevision", {
                      revision: revisionText(reconciler.applied),
                    })
                  : t("empty", "nothingAppliedYet")
            }
          >
            {reconciler.kind === "HelmRelease"
              ? t("empty", "aHelmRelease")
              : t("count", "objects", { n: reconciler.objects ?? 0 })}
          </Cell>
        </Column>
      </Chain>
      <ObjectLinks reconciler={reconciler} />
      <Findings reconciler={reconciler} />
    </TroubleRow>
  );
}

function ObjectLinks({ reconciler }: { reconciler: FluxReconciler }) {
  const t = useT();
  const crd = crdOf(reconciler.kind);
  const sourceCrd = reconciler.sourceRef
    ? crdOf(reconciler.sourceRef.kind)
    : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 text-[11px] text-fg-fnt">
      {crd && (
        <ResourceRef
          kind={reconciler.kind}
          name={reconciler.name}
          namespace={reconciler.namespace}
          crd={crd}
        />
      )}
      {sourceCrd && reconciler.sourceRef && (
        <ResourceRef
          kind={reconciler.sourceRef.kind}
          name={reconciler.sourceRef.name}
          namespace={reconciler.sourceRef.namespace}
          crd={sourceCrd}
        />
      )}
      {reconciler.dependsOn.length > 0 && (
        <span>
          {t("empty", "dependsOn", {
            list: reconciler.dependsOn.map((entry) => entry.name).join(", "),
          })}
        </span>
      )}
    </div>
  );
}

function Findings({
  reconciler,
  brief,
}: {
  reconciler: FluxReconciler;
  brief?: boolean;
}) {
  const t = useT();
  if (reconciler.findings.length === 0) return null;
  const shown = brief ? reconciler.findings.slice(0, 1) : reconciler.findings;
  const hidden = brief ? reconciler.findings.length - 1 : 0;

  return (
    <div className="flex flex-col gap-2">
      {shown.map((finding, index) => (
        <ReconcilerFinding
          key={index}
          reconciler={reconciler}
          finding={finding}
          brief={brief}
        />
      ))}
      {hidden > 0 && (
        <span className="text-[11px] text-fg-fnt">
          {t("empty", "andMoreOpenRow", { n: hidden })}
        </span>
      )}
    </div>
  );
}

function ReconcilerFinding({
  reconciler,
  finding,
  brief,
}: {
  reconciler: FluxReconciler;
  finding: FluxFinding;
  brief?: boolean;
}) {
  const t = useT();
  const said = describe(reconciler, finding, t);
  return (
    <Finding
      tone={finding.severity}
      title={said.title}
      verbatim={brief ? null : said.verbatim}
    >
      {!brief && said.note}
    </Finding>
  );
}

function describe(
  reconciler: FluxReconciler,
  finding: FluxFinding,
  t: ReturnType<typeof useT>
): { title: string; verbatim?: string | null; note?: React.ReactNode } {
  switch (finding.kind) {
    case "suspended":
      return {
        title: finding.at
          ? t("empty", "fluxSuspendedTitleAgo", { age: formatAge(finding.at) })
          : t("empty", "fluxSuspendedTitle"),
        note: finding.wasReady
          ? t("empty", "fluxSuspendedWasReady", {
              kind: reconciler.kind,
              revision: revisionText(finding.applied),
            })
          : t("empty", "fluxSuspendedNeverRan"),
      };
    case "frozen":
      return {
        title: t("empty", "fluxFrozenTitle", {
          revision: revisionText(finding.applied),
        }),
        verbatim: finding.message,
        note: (
          <>
            {reconciler.kind === "HelmRelease"
              ? t("empty", "fluxFrozenHelm")
              : t("empty", "fluxFrozenObjects", {
                  n: reconciler.objects ?? 0,
                })}{" "}
            {t("empty", "fluxFrozenExceptPre")}{" "}
            <span className="font-mono">{finding.source.name}</span>
            {t("empty", "fluxFrozenExceptPost")}
          </>
        ),
      };
    case "noSource":
      return {
        title: !finding.source
          ? t("empty", "fluxSourceMissing")
          : finding.everFetched
            ? t("empty", "fluxSourceStoppedNeverApplied")
            : t("empty", "fluxSourceNeverFetched"),
        verbatim: finding.message,
      };
    case "notReady":
      return {
        title: finding.reason
          ? t("empty", "fluxNotReconcilingReason", { reason: finding.reason })
          : t("empty", "fluxNotReconciling"),
        verbatim: finding.message,
      };
    case "stalled":
      return {
        title: t("empty", "fluxStalledTitle"),
        verbatim: finding.message,
        note: t("empty", "fluxStalledNote"),
      };
    case "blocking":
      return {
        title: t("empty", "fluxBlockingTitle", {
          n: finding.blocked.length,
          list: finding.blocked.join(` ${t("empty", "listAnd")} `),
        }),
        note: (
          <>
            {finding.blocked.map((name, index) => (
              <span key={name}>
                {index > 0 && ", "}
                <span className="font-mono text-fg-mid">{name}</span>
              </span>
            ))}{" "}
            {t("empty", "fluxBlockingDeclares", { n: finding.blocked.length })}{" "}
            <span className="font-mono">dependsOn: {reconciler.name}</span>
            {t("empty", "fluxBlockingTail", { n: finding.blocked.length })}
          </>
        ),
      };
    case "waiting":
      return {
        title: t("empty", "fluxWaitingOn", { name: finding.on }),
        note: finding.because ? (
          <>
            <span className="font-mono text-fg-mid">{finding.on}</span>{" "}
            {t("empty", "fluxWaitingSays")}{" "}
            <span className="font-mono">{finding.because}</span>{" "}
            {t("empty", "fluxWaitingTail")}
          </>
        ) : (
          t("empty", "fluxWaitingQueue")
        ),
      };
    case "unused":
    case "fetchFailing":
      return { title: "", verbatim: null };
  }
}

// --- sources ------------------------------------------------------------

function SourcesTab({
  sources,
  loading,
}: {
  sources: FluxSource[];
  loading: boolean;
}) {
  const t = useT();
  if (loading) {
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingSources")}</p>
    );
  }
  if (sources.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        {t("empty", "fluxNoSources")}
      </p>
    );
  }

  const broken = sources.filter((source) => source.worst === "err").length;

  return (
    <div className="flex flex-col">
      <p className="mb-1 max-w-[92ch] text-[11px] text-fg-fnt">
        {t("empty", "fluxSourcesDescription")}
      </p>
      {sources.map((source, index) => (
        <SourceRow
          key={`${source.kind}/${source.namespace}/${source.name}`}
          source={source}
          openByDefault={source.worst === "err" && broken <= AUTO_OPEN}
          last={index === sources.length - 1}
        />
      ))}
    </div>
  );
}

function SourceRow({
  source,
  openByDefault,
  last,
}: {
  source: FluxSource;
  openByDefault: boolean;
  last: boolean;
}) {
  const t = useT();
  const state = sourceState(source);
  const link = source.url ? gitRepoLink(source.url) : null;
  const crd = crdOf(source.kind);
  const failing = source.findings.find(
    (finding) => finding.kind === "fetchFailing"
  );

  return (
    <TroubleRow
      title={source.name}
      meta={
        <>
          {source.kind} · {source.namespace}
          {source.ref && ` · ${source.ref}`}
          {source.interval && ` · every ${source.interval}`}
        </>
      }
      state={state}
      openByDefault={openByDefault}
      last={last}
      brief={
        failing && failing.kind === "fetchFailing" ? (
          <Finding tone="err" title={fetchTitle(failing.everFetched, t)} />
        ) : undefined
      }
    >
      <div className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] items-baseline gap-x-3 text-[11.5px] text-fg-mut">
        <span className="font-mono text-fg-mid">{t("empty", "mountFrom")}</span>
        <span className="min-w-0 break-all">
          {source.url ? (
            link ? (
              <OutLink href={link.url} site={link.site} className="font-mono">
                {source.url.replace(/^https:\/\//, "")}
              </OutLink>
            ) : (
              <span className="font-mono text-fg-mid">{source.url}</span>
            )
          ) : (
            <span className="text-fg-fnt">{t("empty", "noUrlDeclared")}</span>
          )}
        </span>
        <span className="font-mono text-fg-mid">
          {t("columns", "lastFetched")}
        </span>
        <span className="min-w-0 truncate">
          {source.artifact
            ? `${revisionText(source.artifact.revision)}${source.artifact.at ? ` · ${t("action", "agoSuffix", { age: formatAge(source.artifact.at) })}` : ""}`
            : t("action", "never")}
        </span>
        <span className="font-mono text-fg-mid">
          {t("columns", "appliedBy")}
        </span>
        <span className="min-w-0 truncate">
          {source.usedBy.length === 0
            ? t("empty", "nothingLower")
            : source.usedBy
                .map((key) => key.split("/").slice(1).join("/"))
                .join(", ")}
        </span>
      </div>
      {crd && (
        <ResourceRef
          kind={source.kind}
          name={source.name}
          namespace={source.namespace}
          crd={crd}
        />
      )}
      {source.findings.map((finding, index) => (
        <SourceFinding key={index} source={source} finding={finding} />
      ))}
    </TroubleRow>
  );
}

const fetchTitle = (everFetched: boolean, t: ReturnType<typeof useT>) =>
  everFetched ? t("empty", "fluxFetchStopped") : t("empty", "fluxFetchNever");

function SourceFinding({
  source,
  finding,
}: {
  source: FluxSource;
  finding: FluxFinding;
}) {
  const t = useT();
  if (finding.kind === "unused") {
    return (
      <Finding tone="warn" title={t("empty", "fluxSourceUnusedTitle")}>
        {t("empty", "fluxSourceUnusedBody")}
      </Finding>
    );
  }
  if (finding.kind !== "fetchFailing") return null;
  return (
    <Finding
      tone="err"
      title={fetchTitle(finding.everFetched, t)}
      verbatim={finding.message}
    >
      {finding.frozen.length > 0 ? (
        <>
          {finding.frozen.map((name, index) => (
            <span key={name}>
              {index > 0 && ", "}
              <span className="font-mono text-fg-mid">{name}</span>
            </span>
          ))}{" "}
          {finding.everFetched
            ? t("empty", "fluxFrozenStillApplying", {
                n: finding.frozen.length,
                revision: revisionText(source.artifact?.revision ?? null),
                fetched: source.artifact?.at
                  ? t("empty", "fluxFetchedAgo", {
                      age: formatAge(source.artifact.at),
                    })
                  : "",
              })
            : t("empty", "fluxFrozenNothingToApply", {
                n: finding.frozen.length,
              })}
        </>
      ) : (
        t("empty", "fluxSourceUnaffected")
      )}
    </Finding>
  );
}

// --- controllers --------------------------------------------------------

function ControllersTab({
  controllers,
}: {
  controllers: FluxController[] | undefined;
}) {
  const t = useT();
  if (!controllers) {
    return (
      <p className="text-xs text-fg-fnt">
        {t("empty", "readingFluxWorkloads")}
      </p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title={t("empty", "fluxWorkloadsTitle")}
        count={controllers.length || undefined}
        description={t("empty", "fluxWorkloadsDescription")}
      />
      {controllers.length === 0 ? (
        <p className="max-w-[64ch] text-[11px] text-fg-fnt">
          {t("empty", "fluxNoControllersPre")}{" "}
          <span className="font-mono">app.kubernetes.io/part-of=flux</span>
          {t("empty", "fluxNoControllersPost")}
        </p>
      ) : (
        <div className="flex flex-col">
          {controllers.map((controller) => (
            <div
              key={`${controller.namespace}/${controller.name}`}
              className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-hair py-1.5 text-[11.5px]"
            >
              <span className="truncate">
                <ResourceRef
                  kind="Deployment"
                  name={controller.name}
                  namespace={controller.namespace}
                  showKind={false}
                />
              </span>
              <span className="truncate font-mono text-[11px] text-fg-fnt">
                {controller.image ?? ""}
              </span>
              <span
                className={
                  controller.ready < controller.desired
                    ? "text-[11px] text-err"
                    : "text-[11px] text-fg-fnt"
                }
              >
                {t("count", "ofTotalReady", {
                  n: controller.ready,
                  total: controller.desired,
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
