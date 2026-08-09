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
import { Link, useSearchParams } from "react-router-dom";
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
import { crdObjectPath, plural } from "../kit";
import { gitRepoLink } from "../gitops";
import {
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

/** Past this many broken reconcilers, nothing opens itself. */
const AUTO_OPEN = 8;

const crdOf = (kind: string): string | null =>
  kind === "Kustomization"
    ? KUSTOMIZATIONS_CRD
    : kind === "HelmRelease"
      ? HELM_RELEASES_CRD
      : (SOURCE_KINDS.find(([name]) => name === kind)?.[1] ?? null);

export default function FluxPage() {
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
          Could not read what Flux is reconciling
        </h2>
        <p className="text-xs text-fg-mut">
          Everything on this page comes from Flux&rsquo;s own objects in this
          API server, and that request failed — so a list here would be a guess
          rather than an answer.
        </p>
        <p className="text-[11px] text-fg-fnt">{picture.error.message}</p>
      </Section>
    );
  }

  const tabs: DetailTab[] = [
    {
      id: "reconcilers",
      label: "Reconcilers",
      glyph: viewGlyph(Layers),
      mark: markFor(reconcilers.map((entry) => entry.worst)),
      content: (
        <ReconcilersTab reconcilers={reconcilers} loading={picture.isPending} />
      ),
    },
    {
      id: "sources",
      label: "Sources",
      glyph: viewGlyph(GitBranch),
      mark: markFor(sources.map((entry) => entry.worst)),
      content: <SourcesTab sources={sources} loading={picture.isPending} />,
    },
    {
      id: "controllers",
      label: "Controllers",
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
            : `${plural(reconcilers.length, "reconciler")} from ${plural(sources.length, "source")}`
        }
        description="What Flux is applying, what it is applying from, and where the two have come apart."
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
  worsts: Array<"err" | "warn" | null>
): DetailTabMark | undefined {
  if (worsts.length === 0) return undefined;
  const troubled = worsts.filter((worst) => worst !== null).length;
  if (troubled === 0) return countMark(worsts.length);
  return severityMark(
    worsts.includes("err") ? "err" : "warn",
    `${troubled} of ${worsts.length} need attention`
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
    return <p className="text-xs text-fg-fnt">Reading what Flux applies…</p>;
  }

  if (reconcilers.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          Flux is installed here and applying nothing.
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          No Kustomization and no HelmRelease exists in this cluster. The
          controllers are running and waiting to be given something.
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
          placeholder="Filter by name, path, chart or source"
          label="Filter reconcilers"
        />
        <span className="text-[11px] text-fg-fnt">
          {filter.trim() !== ""
            ? `${shown.length} of ${reconcilers.length}`
            : broken > 0
              ? `${broken} of ${reconcilers.length} not reconciling, and first${worthALook > 0 ? ` · ${worthALook} worth a look` : ""}`
              : worthALook > 0
                ? `nothing failing · ${worthALook} of ${reconcilers.length} worth a look`
                : `${plural(reconcilers.length, "reconciler")}, all applied`}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-xs text-fg-fnt">
          No reconciler here matches that.
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
      <div className="grid grid-cols-4">
        <Column label="Source">
          {reconciler.sourceRef ? (
            <Cell
              bad={source?.ready === false || !source}
              under={
                !source
                  ? "not in this cluster"
                  : source.ready === false
                    ? "fetch failing"
                    : (source.ref ?? "fetched")
              }
            >
              {reconciler.sourceRef.kind} {reconciler.sourceRef.name}
            </Cell>
          ) : (
            <Cell bad under="nothing to apply from">
              none
            </Cell>
          )}
        </Column>
        <Column label="Revision">
          <Cell
            under={
              // Only a Kustomization's revision is comparable to its source's:
              // a HelmRepository's artifact is a digest of the chart index and
              // says nothing about which chart version is installed.
              reconciler.kind === "Kustomization" &&
              reconciler.applied &&
              source?.artifact?.revision?.commit &&
              source.artifact.revision.commit !== reconciler.applied.commit
                ? `the source has ${revisionText(source.artifact.revision)}`
                : reconciler.lastReconciledAt
                  ? `${formatAge(reconciler.lastReconciledAt)} ago`
                  : "never applied"
            }
          >
            {reconciler.applied
              ? `applied ${revisionText(reconciler.applied)}`
              : "nothing applied"}
          </Cell>
        </Column>
        <Column label={reconciler.kind}>
          <Cell
            bad={state.tone === "err"}
            under={reconciler.suspended ? "suspended" : reconciler.unit}
          >
            {reconciler.name}
          </Cell>
        </Column>
        <Column label="Objects">
          <Cell
            under={
              reconciler.kind === "HelmRelease"
                ? "held in Helm's own storage"
                : reconciler.applied
                  ? `from ${revisionText(reconciler.applied)}`
                  : "nothing applied yet"
            }
          >
            {reconciler.kind === "HelmRelease"
              ? "a Helm release"
              : plural(reconciler.objects ?? 0, "object")}
          </Cell>
        </Column>
      </div>
      <ObjectLinks reconciler={reconciler} />
      <Findings reconciler={reconciler} />
    </TroubleRow>
  );
}

function ObjectLinks({ reconciler }: { reconciler: FluxReconciler }) {
  const crd = crdOf(reconciler.kind);
  const sourceCrd = reconciler.sourceRef
    ? crdOf(reconciler.sourceRef.kind)
    : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 text-[11px] text-fg-fnt">
      {crd && (
        <Link
          to={crdObjectPath(crd, reconciler.namespace, reconciler.name)}
          className="font-mono text-info hover:underline"
        >
          {reconciler.kind.toLowerCase()}/{reconciler.name}
        </Link>
      )}
      {sourceCrd && reconciler.sourceRef && (
        <Link
          to={crdObjectPath(
            sourceCrd,
            reconciler.sourceRef.namespace,
            reconciler.sourceRef.name
          )}
          className="font-mono text-info hover:underline"
        >
          {reconciler.sourceRef.kind.toLowerCase()}/{reconciler.sourceRef.name}
        </Link>
      )}
      {reconciler.dependsOn.length > 0 && (
        <span>
          depends on{" "}
          {reconciler.dependsOn.map((entry) => entry.name).join(", ")}
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
          and {hidden} more — open the row
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
  const said = describe(reconciler, finding);
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
  finding: FluxFinding
): { title: string; verbatim?: string | null; note?: React.ReactNode } {
  switch (finding.kind) {
    case "suspended":
      return {
        title: `Suspended${finding.at ? ` — ${formatAge(finding.at)} ago` : ""}: it is not reconciling and it is not failing`,
        note: finding.wasReady
          ? `A suspended ${reconciler.kind} keeps the Ready condition from the last time it ran, so it reads as healthy in every list — Flux's own included. It last applied ${revisionText(finding.applied)}; whatever has been committed since is not here.`
          : "It was suspended before it ever reconciled, so nothing it describes has been applied at all.",
      };
    case "frozen":
      return {
        title: `Its source stopped fetching; everything below it is frozen at ${revisionText(finding.applied)}`,
        verbatim: finding.message,
        note: (
          <>
            {reconciler.kind === "HelmRelease"
              ? "The release is installed and healthy — from a chart version the source can no longer refresh. "
              : `The ${reconciler.objects ?? 0} objects are applied and healthy — from a revision the source can no longer refresh. `}
            Nothing here says &ldquo;failed&rdquo; except{" "}
            <span className="font-mono">{finding.source.name}</span>, and every
            reconciler under it looks fine.
          </>
        ),
      };
    case "noSource":
      return {
        title: !finding.source
          ? "The source it names is not in this cluster"
          : finding.everFetched
            ? "Its source has stopped fetching, and this has never applied anything"
            : "Its source has never fetched, so this has never applied anything",
        verbatim: finding.message,
      };
    case "notReady":
      return {
        title: `Not reconciling${finding.reason ? ` — ${finding.reason}` : ""}`,
        verbatim: finding.message,
      };
    case "stalled":
      return {
        title:
          "Stalled: it has stopped retrying and will not try again on its own",
        verbatim: finding.message,
        note: "Flux gives up after its retry budget. Nothing changes until the spec does.",
      };
    case "blocking":
      return {
        title: `${finding.blocked.join(" and ")} ${finding.blocked.length === 1 ? "is" : "are"} waiting on this one`,
        note: (
          <>
            {finding.blocked.map((name, index) => (
              <span key={name}>
                {index > 0 && ", "}
                <span className="font-mono text-fg-mid">{name}</span>
              </span>
            ))}{" "}
            {finding.blocked.length === 1 ? "declares" : "both declare"}{" "}
            <span className="font-mono">dependsOn: {reconciler.name}</span>, so{" "}
            {finding.blocked.length === 1 ? "it has" : "neither has"} reconciled
            either. Fixing this one releases{" "}
            {finding.blocked.length === 1 ? "it" : "them"}.
          </>
        ),
      };
    case "waiting":
      return {
        title: `Waiting on ${finding.on}, which is not ready`,
        note: finding.because ? (
          <>
            <span className="font-mono text-fg-mid">{finding.on}</span> says:{" "}
            <span className="font-mono">{finding.because}</span> — nothing here
            is wrong, and nothing here will move until that does.
          </>
        ) : (
          "Nothing here is wrong; it is in the queue behind something that is."
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
  if (loading) {
    return <p className="text-xs text-fg-fnt">Reading the sources…</p>;
  }
  if (sources.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        No source objects. Nothing is being fetched, so nothing can be applied.
      </p>
    );
  }

  const broken = sources.filter((source) => source.worst === "err").length;

  return (
    <div className="flex flex-col">
      <p className="mb-1 max-w-[92ch] text-[11px] text-fg-fnt">
        A source is fetched once and applied by everything that names it. This
        is the half of Flux that fails quietly: a source that stops fetching
        leaves every reconciler under it reporting the last revision it managed
        to apply.
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
          <Finding tone="err" title={fetchTitle(failing.everFetched)} />
        ) : undefined
      }
    >
      <div className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] items-baseline gap-x-3 text-[11.5px] text-fg-mut">
        <span className="font-mono text-fg-mid">from</span>
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
            <span className="text-fg-fnt">no URL declared</span>
          )}
        </span>
        <span className="font-mono text-fg-mid">last fetched</span>
        <span className="min-w-0 truncate">
          {source.artifact
            ? `${revisionText(source.artifact.revision)}${source.artifact.at ? ` · ${formatAge(source.artifact.at)} ago` : ""}`
            : "never"}
        </span>
        <span className="font-mono text-fg-mid">applied by</span>
        <span className="min-w-0 truncate">
          {source.usedBy.length === 0
            ? "nothing"
            : source.usedBy
                .map((key) => key.split("/").slice(1).join("/"))
                .join(", ")}
        </span>
      </div>
      {crd && (
        <Link
          to={crdObjectPath(crd, source.namespace, source.name)}
          className="font-mono text-[11px] text-info hover:underline"
        >
          {source.kind.toLowerCase()}/{source.name}
        </Link>
      )}
      {source.findings.map((finding, index) => (
        <SourceFinding key={index} source={source} finding={finding} />
      ))}
    </TroubleRow>
  );
}

const fetchTitle = (everFetched: boolean) =>
  everFetched
    ? "It stopped fetching, and what it fetched before is what is running"
    : "It has never fetched, so nothing under it has ever been applied";

function SourceFinding({
  source,
  finding,
}: {
  source: FluxSource;
  finding: FluxFinding;
}) {
  if (finding.kind === "unused") {
    return (
      <Finding tone="warn" title="Nothing applies this source">
        It is fetched on its schedule and no Kustomization or HelmRelease names
        it, so it is configuration doing nothing. Nowhere else in this app could
        tell you that.
      </Finding>
    );
  }
  if (finding.kind !== "fetchFailing") return null;
  return (
    <Finding
      tone="err"
      title={fetchTitle(finding.everFetched)}
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
            ? `${finding.frozen.length === 1 ? "is" : "are"} still applying ${revisionText(source.artifact?.revision ?? null)}${source.artifact?.at ? `, fetched ${formatAge(source.artifact.at)} ago` : ""}, and ${finding.frozen.length === 1 ? "reports" : "report"} Ready while doing it.`
            : `${finding.frozen.length === 1 ? "has" : "have"} nothing to apply.`}
        </>
      ) : (
        "Nothing names this source, so nothing is affected."
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
  if (!controllers) {
    return (
      <p className="text-xs text-fg-fnt">Reading Flux&rsquo;s own workloads…</p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title="Flux's own workloads"
        count={controllers.length || undefined}
        description="One controller per kind of object, each with its own logs — which is where a Flux problem this page cannot see is actually diagnosed. Flux ships no dashboard, so there is nowhere else to go."
      />
      {controllers.length === 0 ? (
        <p className="max-w-[64ch] text-[11px] text-fg-fnt">
          Nothing in this cluster carries{" "}
          <span className="font-mono">app.kubernetes.io/part-of=flux</span>, so
          Flux&rsquo;s own workloads could not be found. Its objects are still
          read from the API server — but with no controller running, none of
          them is being acted on.
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
                {controller.ready} of {controller.desired} ready
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
