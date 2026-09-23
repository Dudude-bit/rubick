/**
 * Argo CD's page: is what is running what git says should be running.
 *
 * Ordered by trouble, never by name. The reader has one application that is
 * not converging and eleven that are, and the alphabet puts the answer
 * wherever the alphabet happens to put it.
 *
 * Where each link goes is the whole point. A resource row goes to **that
 * object's page in this app** — the reason to read Argo here rather than in
 * Argo is that this app knows what a `Deployment` is and can show you its
 * pods. The repository and the revision go **out** to the git host, and only
 * where the address falls out of the remote mechanically; `gitRepoLink` owns
 * that judgement and an `ssh://` remote simply gets no link. "Open in Argo
 * CD" goes out to Argo, because the line-by-line diff is the one thing Argo
 * does better than this app could without a credential — and it only appears
 * where the cluster says, in an object, how Argo's UI is actually reached: an
 * `Ingress` is read directly, and anything else routing `argocd-server` — a
 * Traefik `IngressRoute`, and every cluster whose edge is entirely CRDs —
 * answers through the `service.routes` capability.
 */

import { useCallback, useMemo } from "react";
import { Box, GitBranch, Layers, Shield } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { DetailTabs } from "@/components/resources/DetailTabs";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { useCrdIndex, type CrdLookup } from "@/hooks/useCrdIndex";
import { Link } from "react-router-dom";
import {
  countMark,
  viewGlyph,
  type DetailTab,
} from "@/components/resources/detail-tab";
import type { CustomResourceInfo } from "@/generated/types";
import { formatAge } from "@/lib/utils";
import {
  conditionsOf,
  crdObjectsPath,
  getValueByPath,
  troubleMark,
} from "../kit";
import { gitRepoLink, gitRevisionLink, shortRevision } from "../gitops";
import {
  Chain,
  Cell,
  Column,
  Finding,
  OutLink,
  TroubleList,
  TroubleRow,
  VendorReadFailure,
  FindingList,
} from "../page-kit";
import { useServiceRoutes, type ServiceRoutes } from "@/hooks/useServiceRoutes";
import {
  APPLICATIONS_CRD,
  APPLICATIONSETS_CRD,
  PROJECTS_CRD,
  SERVER_SERVICE,
  applicationUrl,
  uiFromRoutes,
  useApplicationSets,
  useApplications,
  useController,
  useProjects,
  type ControllerInfo,
  type RoutedUi,
} from "./data";
import {
  appState,
  byKind,
  byTrouble,
  destinationOf,
  differing,
  resourceTone,
  type ArgoApp,
  type ArgoFinding,
  type ArgoResource,
  type ArgoSource,
} from "./model";
import { useSearchParam } from "@/hooks/useSearchParam";
import { errorToShow } from "@/lib/error-utils";
import { useT } from "@/i18n/useT";
import { sayWords } from "@/i18n/say";
import { parts } from "@/i18n/parts";

/** Past this many broken applications, nothing opens itself. */
const AUTO_OPEN = 8;

export default function ArgoCdPage() {
  const t = useT();
  const [tab, setTab] = useSearchParam("tab", "applications");

  const applications = useApplications();
  const sets = useApplicationSets();
  const projects = useProjects();
  const controller = useController();

  const apps = useMemo(
    () => byTrouble(applications.data ?? []),
    [applications.data]
  );

  // An Ingress is not the only thing that can put Argo's UI on a hostname —
  // on a Traefik cluster nothing does. The core reading stays first; this is
  // asked only when it found nothing.
  const routed = useServiceRoutes(
    controller.data
      ? { namespace: controller.data.namespace, name: SERVER_SERVICE }
      : null
  );
  const viaRoutes = useMemo(() => uiFromRoutes(routed.routes), [routed.routes]);
  const ui = controller.data?.ui ?? viaRoutes.url;

  if (applications.error) {
    return (
      <VendorReadFailure
        title={t("empty", "couldNotReadApplications")}
        body={
          <>
            {parts(t("empty", "applicationsUnreadableBody"), {
              kind: <span className="font-mono">Application</span>,
            })}
          </>
        }
        error={applications.error}
        onRetry={() => void applications.refetch()}
      />
    );
  }

  const tabs: DetailTab[] = [
    {
      id: "applications",
      label: "Applications",
      glyph: viewGlyph(GitBranch),
      mark: troubleMark(
        apps.map((app) => app.worst),
        (n, total) => t("count", "applicationsNeedAttention", { n, total })
      ),
      content: (
        <ApplicationsTab apps={apps} loading={applications.isPending} ui={ui} />
      ),
    },
    {
      id: "appsets",
      label: t("nav", "appSets"),
      glyph: viewGlyph(Layers),
      mark:
        sets.data && sets.data.length > 0
          ? countMark(sets.data.length)
          : undefined,
      content: <AppSetsTab sets={sets.data ?? []} apps={apps} />,
    },
    {
      id: "projects",
      label: t("nav", "projects"),
      glyph: viewGlyph(Shield),
      mark:
        projects.data && projects.data.length > 0
          ? countMark(projects.data.length)
          : undefined,
      content: <ProjectsTab projects={projects.data ?? []} apps={apps} />,
    },
    {
      id: "controller",
      label: t("nav", "controller"),
      glyph: viewGlyph(Box),
      content: (
        <ControllerTab
          controller={controller.data}
          ui={ui}
          routed={viaRoutes}
          routes={routed}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="Argo CD"
        count={
          applications.isPending
            ? undefined
            : t("empty", "acrossEveryNamespace", {
                count: t("readings", "kindCount", {
                  n: apps.length,
                  kind: "Application",
                }),
              })
        }
        description={t("empty", "argoPageDescription")}
      />
      <DetailTabs tabs={tabs} activeTab={tab} onTabChange={setTab} />
    </div>
  );
}

// --- applications -------------------------------------------------------

function ApplicationsTab({
  apps,
  loading,
  ui,
}: {
  apps: ArgoApp[];
  loading: boolean;
  ui: string | null;
}) {
  const t = useT();
  // The destination is a sentence, so what matches follows the language.
  const searchable = useCallback(
    (app: ArgoApp) => [
      app.name,
      app.project,
      destinationOf(app, t),
      ...app.sources.map((source) => source.repoUrl),
      ...app.resources.map((resource) => resource.name),
    ],
    [t]
  );

  if (loading) {
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingApplications")}</p>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">{t("empty", "argoOwnsNothing")}</p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          <>
            {parts(t("empty", "argoNoApplicationsBody"), {
              kind: <span className="font-mono">Application</span>,
            })}
          </>
        </p>
      </div>
    );
  }

  return (
    <TroubleList
      items={apps}
      severityOf={severityOfApp}
      searchable={searchable}
      filter={{
        placeholder: t("action", "filterByNameProjectRepoObject"),
        label: t("action", "filterApplications"),
      }}
      autoOpen={{ when: "err", upTo: AUTO_OPEN }}
      summary={{
        brokenFirst: (n, total) => t("count", "failingAndFirst", { n, total }),
        nothingBroken: t("empty", "nothingFailing"),
        allWell: (n) =>
          t("empty", "allInSync", {
            count: t("readings", "kindCount", { n, kind: "Application" }),
          }),
      }}
      noMatch={() => t("empty", "noApplicationMatches")}
      keyOf={(app) => `${app.namespace}/${app.name}`}
      renderRow={(app, { openByDefault, last }) => (
        <AppRow app={app} ui={ui} openByDefault={openByDefault} last={last} />
      )}
    />
  );
}

const severityOfApp = (app: ArgoApp) => app.worst;

function AppRow({
  app,
  ui,
  openByDefault,
  last,
}: {
  app: ArgoApp;
  ui: string | null;
  openByDefault: boolean;
  last: boolean;
}) {
  const t = useT();
  const state = appState(app, t);
  const changed = differing(app);
  const url = applicationUrl(ui, app);

  return (
    <TroubleRow
      title={app.name}
      reference={{
        kind: "Application",
        name: app.name,
        namespace: app.namespace,
        crd: APPLICATIONS_CRD,
      }}
      meta={
        <>
          {t("empty", "argoProjectDestination", {
            project: app.project,
            destination: destinationOf(app, t),
          })}
          {app.generatedBy &&
            ` · ${t("empty", "generatedByName", {
              name: app.generatedBy.name,
            })}`}
        </>
      }
      state={state}
      openByDefault={openByDefault}
      last={last}
      brief={
        app.findings.length > 0 ? (
          <Findings app={app} url={url} brief />
        ) : undefined
      }
    >
      <SourceLine app={app} />
      <Chain>
        <Column label={t("columns", "source")}>
          {app.sources.length === 0 ? (
            <Cell under={t("empty", "noSourceDeclared")}>
              {t("empty", "noneLower")}
            </Cell>
          ) : (
            app.sources.map((source) => (
              <Cell
                key={source.repoUrl + (source.path ?? source.chart ?? "")}
                under={source.targetRevision ?? t("empty", "defaultBranch")}
              >
                {shortRevision(app.revision ?? source.targetRevision ?? "?")}
              </Cell>
            ))
          )}
        </Column>
        <Column label="Application">
          <Cell
            bad={app.worst === "err"}
            under={
              app.autoSync
                ? app.selfHeal
                  ? t("empty", "autoSyncSelfHealing")
                  : t("empty", "autoSyncOn")
                : t("empty", "autoSyncOff")
            }
          >
            {app.name}
          </Cell>
        </Column>
        <Column label={t("columns", "resources")}>
          <Cell
            bad={changed.length > 0}
            under={
              app.resources.length === 0
                ? t("empty", "nothingComparedYet")
                : t("count", "syncedOutOfSync", {
                    synced: app.resources.length - changed.length,
                    drifted: changed.length,
                  })
            }
          >
            {t("count", "objects", { n: app.resources.length })}
          </Cell>
        </Column>
        <Column label={t("columns", "health")}>
          <Cell
            bad={app.health === "Degraded" || app.health === "Missing"}
            under={
              app.lastSyncAt
                ? t("empty", "lastSyncedAgo", {
                    age: formatAge(app.lastSyncAt, t),
                  })
                : t("empty", "neverSynced")
            }
          >
            {app.health.toLowerCase()}
          </Cell>
        </Column>
      </Chain>
      <Manages app={app} />
      {app.generatedBy && <GeneratedNote app={app} />}
      <Findings app={app} url={url} />
    </TroubleRow>
  );
}

/** Where the manifests come from, and when they were last applied. */
function SourceLine({ app }: { app: ArgoApp }) {
  const t = useT();
  if (app.sources.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {app.sources.map((source) => (
        <div
          key={source.repoUrl + (source.path ?? source.chart ?? "")}
          className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)_auto] items-baseline gap-x-3 text-[11.5px] text-fg-mut"
        >
          <span className="truncate font-mono text-fg-mid">
            {t("empty", "fromGit")}
          </span>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <RepoRef source={source} />
            {(source.path || source.chart) && (
              <>
                <span className="text-fg-fnt">·</span>
                <span className="font-mono text-fg-mid">
                  {source.path ?? source.chart}
                </span>
              </>
            )}
            <span className="text-fg-fnt">·</span>
            <RevisionRef app={app} source={source} />
            <span className="text-fg-fnt">
              {app.lastSyncAt
                ? `— ${t("empty", "syncedAgo", {
                    age: formatAge(app.lastSyncAt, t),
                  })}`
                : `— ${t("empty", "neverSynced")}`}
            </span>
          </span>
          <span className="text-[11px] text-fg-fnt">
            {app.autoSync
              ? t("empty", "autoSyncOn")
              : t("empty", "autoSyncOff")}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The repository, linked only where the remote has a web address that falls
 * out of it. An `ssh://` or self-hosted remote is printed and not linked —
 * the string is still what the reader needs to find the repo themselves.
 */
function RepoRef({ source }: { source: ArgoSource }) {
  const link = gitRepoLink(source.repoUrl);
  const shown = source.repoUrl.replace(/^https:\/\//, "").replace(/\.git$/, "");
  if (!link) return <span className="font-mono text-fg-mid">{shown}</span>;
  return (
    <OutLink href={link.url} site={link.site} className="font-mono">
      {shown}
    </OutLink>
  );
}

function RevisionRef({ app, source }: { app: ArgoApp; source: ArgoSource }) {
  const revision = app.revision ?? source.targetRevision;
  if (!revision) return <span className="font-mono text-fg-fnt">unknown</span>;
  const shown = source.targetRevision
    ? `${source.targetRevision}@${shortRevision(revision)}`
    : shortRevision(revision);
  const link = gitRevisionLink(source.repoUrl, revision);
  if (!link) return <span className="font-mono text-fg-mid">{shown}</span>;
  return (
    <OutLink href={link.url} site={link.site} className="font-mono">
      {shown}
    </OutLink>
  );
}

/**
 * Everything the Application manages, grouped by kind — the whole inventory,
 * not only what differs. *What is in this Application* is the question
 * somebody opens it with, the objects are already in `status.resources`, and
 * every one of them is a link into its own page in this app, which is the
 * whole reason to read Argo here rather than in Argo.
 *
 * Ordered by trouble inside each kind and across them, because a Helm release
 * of a hundred objects is the ordinary case and the two that are failing must
 * not be somewhere in the middle of it.
 *
 * The *why* is Argo's own sentence where it has one — `syncResult`'s message
 * is usually the API server's own refusal, quoted exactly. Which *fields*
 * differ is in Argo's API behind a token, and inventing a sentence about it
 * would be this page guessing.
 */
const SHOWN_PER_KIND = 12;

function Manages({ app }: { app: ArgoApp }) {
  const t = useT();
  const groups = byKind(app.resources);
  const { crdFor } = useCrdIndex();

  if (groups.length === 0) {
    return (
      <p className="text-[11px] text-fg-fnt">
        {t("empty", "argoNotComparedYet")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        // Trouble is never hidden: the cap is measured past the ones worth
        // looking at, and whatever it dropped is said out loud.
        const shown = group.resources.slice(
          0,
          Math.max(SHOWN_PER_KIND, group.troubled)
        );
        const hidden = group.resources.length - shown.length;
        return (
          <div key={group.kind} className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-[0.08em] text-fg-fnt">
              {group.kind}
              <span className="ml-1.5 normal-case tracking-normal">
                {group.resources.length}
                {group.troubled > 0 && (
                  <span className="text-warn">
                    {" "}
                    · {t("count", "toLookAt", { n: group.troubled })}
                  </span>
                )}
              </span>
            </span>
            {shown.map((resource) => (
              <ResourceLine
                key={`${resource.kind}/${resource.namespace}/${resource.name}`}
                resource={resource}
                crdFor={crdFor}
              />
            ))}
            {hidden > 0 && (
              <span className="text-[11px] text-fg-fnt">
                {t("count", "andMoreSynced", { n: hidden })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One managed object: where it is in this app, and what Argo says about it.
 *
 * Half of a real Application's inventory is other operators' objects — a
 * `Certificate`, an `IngressRoute`, a `ServiceMonitor` — and a reference can
 * only be made from a CRD's name, while Argo reports a group and a kind. So
 * the cluster is asked which CRD that pair belongs to; a kind it has no CRD
 * for is a core kind and needs none.
 */
function ResourceLine({
  resource,
  crdFor,
}: {
  resource: ArgoResource;
  crdFor: CrdLookup;
}) {
  const t = useT();
  const tone = resourceTone(resource);
  const said =
    resource.sync === "Missing"
      ? t("readings", "argoMissing")
      : resource.outcome === "SyncFailed"
        ? t("readings", "argoFailedToApply")
        : resource.sync !== null && resource.sync !== "Synced"
          ? t("readings", "argoOutOfSync")
          : resource.health === "Degraded"
            ? t("readings", "argoDegraded")
            : resource.health === "Progressing"
              ? t("readings", "argoProgressing")
              : null;

  return (
    <div className="grid grid-cols-[minmax(0,220px)_minmax(0,1fr)] items-baseline gap-x-3 text-[11.5px] text-fg-mut">
      <span className="truncate">
        <ResourceRef
          kind={resource.kind}
          name={resource.name}
          namespace={resource.namespace}
          crd={crdFor(resource.group, resource.kind) ?? undefined}
          showKind={false}
        />
      </span>
      <span className="min-w-0 truncate">
        {said && (
          <span className={tone === "err" ? "text-err" : "text-warn"}>
            {said}
          </span>
        )}
        {resource.message && (
          <span className="text-fg-fnt">
            {said ? " — " : ""}
            {resource.message}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * An Application a generator made. Worth a line on the row rather than a
 * footnote elsewhere: editing it is pointless — the ApplicationSet rewrites
 * it — and the reader about to do that has no other way to find out.
 */
function GeneratedNote({ app }: { app: ArgoApp }) {
  const t = useT();
  if (!app.generatedBy) return null;
  return (
    <p className="text-[11px] text-fg-fnt">
      {t("empty", "generatedByApplicationSet")}{" "}
      <ResourceRef
        kind="ApplicationSet"
        name={app.generatedBy.name}
        namespace={app.namespace}
        crd={APPLICATIONSETS_CRD}
        showKind={false}
      />
      {t("empty", "editingGeneratedAppUndone")}
    </p>
  );
}

function Findings({
  app,
  url,
  brief,
}: {
  app: ArgoApp;
  url: string | null;
  brief?: boolean;
}) {
  return (
    <FindingList
      findings={app.findings}
      brief={brief}
      render={(finding) => (
        <FindingLine app={app} finding={finding} url={url} brief={brief} />
      )}
    />
  );
}

function FindingLine({
  app,
  finding,
  url,
  brief,
}: {
  app: ArgoApp;
  finding: ArgoFinding;
  url: string | null;
  brief?: boolean;
}) {
  const t = useT();
  const said = describeFinding(t, app, finding);
  return (
    <Finding
      tone={finding.severity}
      title={said.title}
      verbatim={brief ? null : said.verbatim}
    >
      {!brief && (
        <>
          {said.note}
          {said.offerDiff && <DiffLink app={app} url={url} />}
        </>
      )}
    </Finding>
  );
}

/**
 * The tier boundary, stated where the reader meets it. Which resources differ
 * is here, from the CRD, free; which *lines* differ is in Argo's API behind a
 * token, so it is handed to Argo — but only when the cluster says where Argo
 * answers. With nothing routing `argocd-server` there is no address to guess,
 * and the sentence says that instead of offering a link into a connection
 * error.
 */
function DiffLink({ app, url }: { app: ArgoApp; url: string | null }) {
  const t = useT();
  if (!url) {
    return (
      <>
        {" "}
        <>
          {parts(t("empty", "argoDiffNoAddress"), {
            service: <span className="font-mono">{SERVER_SERVICE}</span>,
          })}
        </>
      </>
    );
  }
  return (
    <>
      {" "}
      <OutLink href={url} site="Argo CD">
        {t("action", "openInArgoCd", { name: app.name })}
      </OutLink>{" "}
      <span className="text-fg-fnt">{t("empty", "forLineByLineDiff")}</span>
    </>
  );
}

function describeFinding(
  t: ReturnType<typeof useT>,
  app: ArgoApp,
  finding: ArgoFinding
): {
  title: string;
  verbatim?: string | null;
  note?: string;
  offerDiff?: boolean;
} {
  switch (finding.kind) {
    case "syncFailing":
      return {
        title: finding.since
          ? t("empty", "syncFailingFor", { age: formatAge(finding.since, t) })
          : t("empty", "syncFailing"),
        verbatim: finding.message,
        note:
          finding.retries > 0
            ? t("count", "argoRetriesAfterAttempts", { n: finding.retries })
            : t("empty", "argoRetries"),
        offerDiff: true,
      };
    case "syncFailedOnce":
      return {
        title: finding.since
          ? t("empty", "lastSyncFailedAgo", {
              age: formatAge(finding.since, t),
            })
          : t("empty", "lastSyncFailed"),
        verbatim: finding.message,
        note: t("empty", "nothingRetryingSync"),
        offerDiff: true,
      };
    case "drifted":
      return {
        title: finding.since
          ? t("empty", "outOfSyncLastSynced", {
              age: formatAge(finding.since, t),
            })
          : t("empty", "outOfSyncNeverSynced"),
        note: t("empty", "driftedNote"),
        offerDiff: true,
      };
    case "degraded":
      return {
        title:
          finding.resources.length > 0
            ? t("count", "resourcesDegraded", {
                n: finding.resources.length,
                list: finding.resources
                  .map((resource) => resource.name)
                  .join(", "),
              })
            : t("empty", "nameIsDegraded", { name: app.name }),
        verbatim:
          finding.message ??
          finding.resources.find((resource) => resource.message)?.message ??
          null,
        note: t("empty", "degradedNote"),
      };
    case "condition":
      return {
        title: t("empty", "argoReports", { type: finding.condition.type }),
        verbatim: finding.condition.message ?? null,
      };
  }
}

// --- application sets ---------------------------------------------------

function AppSetsTab({
  sets,
  apps,
}: {
  sets: CustomResourceInfo[];
  apps: ArgoApp[];
}) {
  const t = useT();
  if (sets.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        {t("empty", "noApplicationSets")}
      </p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title={t("nav", "applicationSets")}
        count={sets.length}
        description={t("empty", "applicationSetsDescription")}
      />
      <div className="flex flex-col">
        {sets.map((set) => {
          const generated = apps.filter(
            (app) => app.generatedBy?.name === set.name
          );
          const error = conditionsOf(set).find(
            (condition) =>
              condition.type === "ErrorOccurred" && condition.status === "True"
          );
          return (
            <div
              key={`${set.namespace}/${set.name}`}
              className="border-b border-hair py-1.5"
            >
              <div className="grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] items-baseline gap-x-3 text-[11.5px]">
                <span className="min-w-0 truncate">
                  <ResourceRef
                    kind="ApplicationSet"
                    name={set.name}
                    namespace={set.namespace}
                    crd={APPLICATIONSETS_CRD}
                    showKind={false}
                  />
                </span>
                <span className="truncate text-fg-mut">
                  {generated.length === 0
                    ? t("empty", "generatedNothing")
                    : generated.map((app) => app.name).join(", ")}
                </span>
                <span className="text-[11px] text-fg-fnt">
                  {t("readings", "kindCount", {
                    n: generated.length,
                    kind: "Application",
                  })}
                </span>
              </div>
              {error && (
                <p className="mt-1 border-l-2 border-err pl-2.5 font-mono text-[11px] text-err">
                  {error.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// --- projects -----------------------------------------------------------

function ProjectsTab({
  projects,
  apps,
}: {
  projects: CustomResourceInfo[];
  apps: ArgoApp[];
}) {
  const t = useT();
  if (projects.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        <>
          {parts(t("empty", "noAppProjects"), {
            name: <span className="font-mono">default</span>,
          })}
        </>
      </p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title={t("nav", "projects")}
        count={projects.length}
        description={t("empty", "projectsDescription")}
      />
      <div className="flex flex-col">
        {projects.map((project) => {
          const members = apps.filter((app) => app.project === project.name);
          const repos = (getValueByPath(project, "spec.sourceRepos") ??
            []) as string[];
          const destinations = (getValueByPath(project, "spec.destinations") ??
            []) as Array<{ namespace?: string; server?: string }>;
          return (
            <div
              key={`${project.namespace}/${project.name}`}
              className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-hair py-1.5 text-[11.5px]"
            >
              <span className="min-w-0 truncate">
                <ResourceRef
                  kind="AppProject"
                  name={project.name}
                  namespace={project.namespace}
                  crd={PROJECTS_CRD}
                  showKind={false}
                />
              </span>
              <span className="truncate text-fg-mut">
                {repos.length === 0
                  ? t("empty", "noRepositoryAllowed")
                  : repos.includes("*")
                    ? t("empty", "anyRepository")
                    : repos.join(", ")}
              </span>
              <span className="truncate text-fg-mut">
                {destinations.length === 0
                  ? t("empty", "noDestinationAllowed")
                  : destinations
                      .map((destination) => {
                        const namespace =
                          !destination.namespace ||
                          destination.namespace === "*"
                            ? t("empty", "anyNamespace")
                            : destination.namespace;
                        const cluster =
                          !destination.server || destination.server === "*"
                            ? t("empty", "anyCluster")
                            : destination.server;
                        return t("empty", "namespaceOnCluster", {
                          namespace,
                          cluster,
                        });
                      })
                      .join(", ")}
              </span>
              <span className="text-[11px] text-fg-fnt">
                {t("readings", "kindCount", {
                  n: members.length,
                  kind: "Application",
                })}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// --- controller ---------------------------------------------------------

function ControllerTab({
  controller,
  ui,
  routed,
  routes,
}: {
  controller: ControllerInfo | undefined;
  /** The address, from an Ingress or from whatever else routes the Service. */
  ui: string | null;
  routed: RoutedUi;
  /** What the routing capability answered, for the three sentences below. */
  routes: ServiceRoutes;
}) {
  const t = useT();
  if (!controller) {
    return (
      <p className="text-xs text-fg-fnt">
        {t("empty", "readingArgoWorkloads")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <Section>
        <SectionHeader
          title={t("nav", "argoOwnWorkloads")}
          count={controller.components.length || undefined}
          description={t("empty", "argoWorkloadsDescription")}
        />
        {controller.components.length === 0 ? (
          <p className="max-w-[64ch] text-[11px] text-fg-fnt">
            {controller.problem && sayWords(controller.problem, t)}
          </p>
        ) : (
          <div className="flex flex-col">
            {controller.components.map((component) => (
              <div
                key={`${component.namespace}/${component.name}`}
                className="grid grid-cols-[minmax(0,300px)_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-hair py-1.5 text-[11.5px]"
              >
                <span className="truncate">
                  <ResourceRef
                    kind={component.kind}
                    name={component.name}
                    namespace={component.namespace}
                    showKind={false}
                  />
                </span>
                <span className="truncate font-mono text-[11px] text-fg-fnt">
                  {component.image ?? ""}
                </span>
                <span
                  className={
                    component.ready < component.desired
                      ? "text-[11px] text-err"
                      : "text-[11px] text-fg-fnt"
                  }
                >
                  {t("count", "ofTotalReady", {
                    n: component.ready,
                    total: component.desired,
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section>
        <SectionHeader
          title={t("nav", "argoOwnUi")}
          description={t("empty", "argoUiDescription")}
        />
        {ui ? (
          <p className="text-[11.5px] text-fg-mut">
            {routed.via && !controller.ui ? (
              <>
                {parts(
                  t("empty", "kindNameServes", { kind: routed.via.kind }),
                  { name: <span className="font-mono">{routed.via.name}</span> }
                )}
              </>
            ) : (
              <>{t("empty", "anIngressServes")}</>
            )}{" "}
            <span className="font-mono">{SERVER_SERVICE}</span>{" "}
            {t("action", "atInline")}{" "}
            <OutLink href={ui} site="Argo CD" className="font-mono">
              {ui}
            </OutLink>
            {t("empty", "soEveryApplicationOffersWayIn")}
          </p>
        ) : routes.isPending ? (
          <p className="text-[11.5px] text-fg-fnt">
            <>
              {parts(t("empty", "readingWhatRoutes"), {
                service: <span className="font-mono">{SERVER_SERVICE}</span>,
              })}
            </>
          </p>
        ) : routed.host ? (
          // The middle state, and the whole reason `tls` may be `null`: the
          // host is known and the scheme is not, so the host is named and the
          // link withheld rather than guessed at.
          <p className="max-w-[80ch] text-[11.5px] text-fg-mut">
            <>
              {parts(
                t("empty", "kindNameServes", {
                  kind: routed.via?.kind ?? t("empty", "somethingWord"),
                }),
                {
                  name: (
                    <span className="font-mono">{routed.via?.name ?? ""}</span>
                  ),
                }
              )}
            </>{" "}
            <span className="font-mono">{SERVER_SERVICE}</span>{" "}
            {t("action", "atInline")}{" "}
            <span className="font-mono text-fg">{routed.host}</span>
            {t("empty", "hostNotKnownTls")}
          </p>
        ) : (
          <p className="max-w-[80ch] text-[11.5px] text-fg-mut">
            {/* Says what was read, not what the cluster contains: neither
                the Ingresses nor the routing capability named a host. */}
            <>
              {parts(t("empty", "nothingRoutesServiceToHostname"), {
                service: <span className="font-mono">{SERVER_SERVICE}</span>,
              })}
            </>
            {routes.available ? "" : t("empty", "noIngressNoRoutingController")}
            <>
              {parts(t("empty", "serviceIsClusterIpNoRoute"), {
                service: <span className="font-mono">{SERVER_SERVICE}</span>,
              })}
            </>
            <>
              {parts(t("empty", "everythingReadFromObjects"), {
                kind: <span className="font-mono">Application</span>,
              })}
            </>
            {routes.error && (
              <>
                {" "}
                {t("empty", "oneRoutingControllerDidNotAnswer")}{" "}
                <span className="font-mono">{errorToShow(routes.error)}</span>
              </>
            )}
          </p>
        )}
      </Section>

      <Section>
        <SectionHeader
          title={t("nav", "itsObjects")}
          description={t("empty", "itsObjectsDescription")}
        />
        <div className="flex flex-col gap-0.5 text-[11.5px]">
          {[APPLICATIONS_CRD, APPLICATIONSETS_CRD, PROJECTS_CRD].map((crd) => (
            <Link
              key={crd}
              to={crdObjectsPath(crd)}
              className="font-mono text-info hover:underline"
            >
              {crd}
            </Link>
          ))}
        </div>
      </Section>
    </div>
  );
}
