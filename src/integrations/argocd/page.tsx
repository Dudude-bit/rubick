/**
 * Argo CD's page: is what is running what git says should be running.
 *
 * Ordered by trouble, never by name. The reader has one application that is
 * not converging and eleven that are, and the alphabet puts the answer
 * wherever the alphabet happens to put it.
 *
 * ## Where each link goes, because that is the whole point
 *
 * A resource row goes to **that object's page in this app** — the reason to
 * read Argo here rather than in Argo is that this app knows what a
 * `Deployment` is and can show you its pods. The repository and the revision
 * go **out** to the git host, and only where the address falls out of the
 * remote mechanically; `gitRepoLink` owns that judgement and an `ssh://`
 * remote simply gets no link. "Open in Argo CD" goes out to Argo, because the
 * line-by-line diff is the one thing Argo does better than this app could
 * without a credential — and it only appears where the cluster says, in an
 * object, how Argo's UI is actually reached. An `Ingress` is read directly;
 * anything else routing `argocd-server` — a Traefik `IngressRoute`, and every
 * cluster whose edge is entirely CRDs — answers through the `service.routes`
 * capability rather than being invisible, which is what it used to be.
 */

import { useMemo, useState } from "react";
import { Box, GitBranch, Layers, Shield } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { DetailTabs } from "@/components/resources/DetailTabs";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { useCrdIndex, type CrdLookup } from "@/hooks/useCrdIndex";
import { useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import {
  countMark,
  severityMark,
  viewGlyph,
  type DetailTab,
  type DetailTabMark,
} from "@/components/resources/detail-tab";
import type { CustomResourceInfo } from "@/generated/types";
import { formatAge } from "@/lib/utils";
import { conditionsOf, crdObjectsPath, getValueByPath, plural } from "../kit";
import { gitRepoLink, gitRevisionLink, shortRevision } from "../gitops";
import {
  Chain,
  Cell,
  Column,
  FilterBox,
  Finding,
  OutLink,
  TroubleRow,
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

/** Past this many broken applications, nothing opens itself. */
const AUTO_OPEN = 8;

export default function ArgoCdPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "applications";

  const applications = useApplications();
  const sets = useApplicationSets();
  const projects = useProjects();
  const controller = useController();

  const apps = useMemo(
    () => byTrouble(applications.data ?? []),
    [applications.data]
  );

  // An Ingress is not the only thing that can put Argo's UI on a hostname,
  // and reading only Ingresses is what had this page telling readers of a
  // Traefik cluster that nothing served `argocd-server`. The core reading
  // stays first and unchanged; this is asked when it found nothing.
  const routed = useServiceRoutes(
    controller.data
      ? { namespace: controller.data.namespace, name: SERVER_SERVICE }
      : null
  );
  const viaRoutes = useMemo(() => uiFromRoutes(routed.routes), [routed.routes]);
  const ui = controller.data?.ui ?? viaRoutes.url;

  if (applications.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          Could not read this cluster&rsquo;s Applications
        </h2>
        <p className="text-xs text-fg-mut">
          Everything on this page comes from the <code>Application</code>{" "}
          objects in this API server, and that request failed — so a list here
          would be a guess rather than an answer.
        </p>
        <p className="text-[11px] text-fg-fnt">{applications.error.message}</p>
      </Section>
    );
  }

  const troubled = apps.filter((app) => app.worst !== null);

  const tabs: DetailTab[] = [
    {
      id: "applications",
      label: "Applications",
      glyph: viewGlyph(GitBranch),
      mark: applicationsMark(apps, troubled.length),
      content: (
        <ApplicationsTab apps={apps} loading={applications.isPending} ui={ui} />
      ),
    },
    {
      id: "appsets",
      label: "App sets",
      glyph: viewGlyph(Layers),
      mark:
        sets.data && sets.data.length > 0
          ? countMark(sets.data.length)
          : undefined,
      content: <AppSetsTab sets={sets.data ?? []} apps={apps} />,
    },
    {
      id: "projects",
      label: "Projects",
      glyph: viewGlyph(Shield),
      mark:
        projects.data && projects.data.length > 0
          ? countMark(projects.data.length)
          : undefined,
      content: <ProjectsTab projects={projects.data ?? []} apps={apps} />,
    },
    {
      id: "controller",
      label: "Controller",
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
            : `${plural(apps.length, "Application")} across every namespace`
        }
        description="Whether what is running is what git says should be running, and what is stopping it where it is not."
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

function applicationsMark(
  apps: ArgoApp[],
  troubled: number
): DetailTabMark | undefined {
  if (apps.length === 0) return undefined;
  if (troubled === 0) return countMark(apps.length);
  const worst = apps.some((app) => app.worst === "err") ? "err" : "warn";
  return severityMark(
    worst,
    `${troubled} of ${apps.length} applications need attention`
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
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return apps;
    return apps.filter(
      (app) =>
        app.name.toLowerCase().includes(needle) ||
        app.project.toLowerCase().includes(needle) ||
        destinationOf(app).toLowerCase().includes(needle) ||
        app.sources.some((source) =>
          source.repoUrl.toLowerCase().includes(needle)
        ) ||
        app.resources.some((resource) =>
          resource.name.toLowerCase().includes(needle)
        )
    );
  }, [apps, filter]);

  if (loading) {
    return <p className="text-xs text-fg-fnt">Reading the Applications…</p>;
  }

  if (apps.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          Argo CD is installed here and owns nothing yet.
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          No <code>Application</code> exists in this cluster, so nothing is
          being delivered from git. The controller is running and waiting for
          one.
        </p>
      </div>
    );
  }

  const broken = apps.filter((app) => app.worst === "err").length;
  const worthALook = apps.filter((app) => app.worst === "warn").length;

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-center gap-3">
        <FilterBox
          value={filter}
          onChange={setFilter}
          placeholder="Filter by name, project, repo or object"
          label="Filter applications"
        />
        <span className="text-[11px] text-fg-fnt">
          {filter.trim() !== ""
            ? `${shown.length} of ${apps.length}`
            : broken > 0
              ? `${broken} of ${apps.length} failing, and first${worthALook > 0 ? ` · ${worthALook} worth a look` : ""}`
              : worthALook > 0
                ? `nothing failing · ${worthALook} of ${apps.length} worth a look`
                : `${plural(apps.length, "Application")}, all in sync`}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-xs text-fg-fnt">
          No Application here matches that.
        </p>
      ) : (
        shown.map((app, index) => (
          <AppRow
            key={`${app.namespace}/${app.name}`}
            app={app}
            ui={ui}
            openByDefault={app.worst === "err" && broken <= AUTO_OPEN}
            last={index === shown.length - 1}
          />
        ))
      )}
    </div>
  );
}

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
  const state = appState(app);
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
          project {app.project} → {destinationOf(app)}
          {app.generatedBy && ` · generated by ${app.generatedBy.name}`}
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
        <Column label="Source">
          {app.sources.length === 0 ? (
            <Cell under="no source declared">none</Cell>
          ) : (
            app.sources.map((source) => (
              <Cell
                key={source.repoUrl + (source.path ?? source.chart ?? "")}
                under={source.targetRevision ?? "default branch"}
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
                  ? "auto-sync, self-healing"
                  : "auto-sync on"
                : "auto-sync off"
            }
          >
            {app.name}
          </Cell>
        </Column>
        <Column label="Resources">
          <Cell
            bad={changed.length > 0}
            under={
              app.resources.length === 0
                ? "nothing compared yet"
                : `${app.resources.length - changed.length} synced · ${changed.length} out of sync`
            }
          >
            {plural(app.resources.length, "object")}
          </Cell>
        </Column>
        <Column label="Health">
          <Cell
            bad={app.health === "Degraded" || app.health === "Missing"}
            under={
              app.lastSyncAt
                ? `last synced ${formatAge(app.lastSyncAt)} ago`
                : "never synced"
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
  if (app.sources.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {app.sources.map((source) => (
        <div
          key={source.repoUrl + (source.path ?? source.chart ?? "")}
          className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)_auto] items-baseline gap-x-3 text-[11.5px] text-fg-mut"
        >
          <span className="truncate font-mono text-fg-mid">from git</span>
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
                ? `— synced ${formatAge(app.lastSyncAt)} ago`
                : "— never synced"}
            </span>
          </span>
          <span className="text-[11px] text-fg-fnt">
            {app.autoSync ? "auto-sync on" : "auto-sync off"}
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
 * Everything the Application manages, grouped by kind.
 *
 * The row used to say "17 objects" and then list only the ones that differed,
 * so a healthy Application told the reader how many things it owned and never
 * which. That is the wrong half of the answer: *what is in this Application*
 * is the question somebody opens it with, the objects are already in
 * `status.resources`, and every one of them is a link into its own page in
 * this app — which is the whole reason to read Argo here rather than in Argo.
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
  const groups = byKind(app.resources);
  const { crdFor } = useCrdIndex();

  if (groups.length === 0) {
    return (
      <p className="text-[11px] text-fg-fnt">
        Argo has not compared this Application yet, so it lists no objects.
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
                    · {group.troubled} to look at
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
                and {hidden} more Argo reports as synced
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
 * `Certificate`, an `IngressRoute`, a `ServiceMonitor` — and those were drawn
 * as plain text, because a reference can only be made from a CRD's name and
 * Argo reports a group and a kind. The cluster is asked which CRD that pair
 * belongs to; a kind it has no CRD for is a core kind and needs none.
 */
function ResourceLine({
  resource,
  crdFor,
}: {
  resource: ArgoResource;
  crdFor: CrdLookup;
}) {
  const tone = resourceTone(resource);
  const said =
    resource.sync === "Missing"
      ? "missing"
      : resource.outcome === "SyncFailed"
        ? "failed to apply"
        : resource.sync !== null && resource.sync !== "Synced"
          ? "out of sync"
          : resource.health === "Degraded"
            ? "degraded"
            : resource.health === "Progressing"
              ? "progressing"
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
 * An Application a generator made.
 *
 * Worth a line on the row rather than a footnote elsewhere: editing it is
 * pointless — the ApplicationSet rewrites it — and the reader about to do
 * that has no other way to find out.
 */
function GeneratedNote({ app }: { app: ArgoApp }) {
  if (!app.generatedBy) return null;
  return (
    <p className="text-[11px] text-fg-fnt">
      Generated by ApplicationSet{" "}
      <ResourceRef
        kind="ApplicationSet"
        name={app.generatedBy.name}
        namespace={app.namespace}
        crd={APPLICATIONSETS_CRD}
        showKind={false}
      />
      . Editing this Application is undone the next time the generator runs —
      the file to change is the ApplicationSet.
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
  if (app.findings.length === 0) return null;
  const shown = brief ? app.findings.slice(0, 1) : app.findings;
  const hidden = brief ? app.findings.length - 1 : 0;

  return (
    <div className="flex flex-col gap-2">
      {shown.map((finding, index) => (
        <FindingLine
          key={index}
          app={app}
          finding={finding}
          url={url}
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
  const said = describeFinding(app, finding);
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
 * The tier boundary, stated where the reader meets it.
 *
 * Which resources differ is here, from the CRD, free. Which *lines* differ is
 * in Argo's API behind a token, so it is handed to Argo — but only when the
 * cluster says where Argo answers. With no Ingress in front of `argocd-server`
 * there is no address to guess, and the sentence says that instead of offering
 * a link into a connection error.
 */
function DiffLink({ app, url }: { app: ArgoApp; url: string | null }) {
  if (!url) {
    return (
      <>
        {" "}
        The line-by-line diff lives in Argo&rsquo;s own API, which needs a
        credential this app does not hold — and no Ingress in this cluster
        serves <span className="font-mono">argocd-server</span>, so there is no
        address to send you to.
      </>
    );
  }
  return (
    <>
      {" "}
      <OutLink href={url} site="Argo CD">
        Open {app.name} in Argo CD
      </OutLink>{" "}
      <span className="text-fg-fnt">
        for the line-by-line diff, which needs a credential this app does not
        hold.
      </span>
    </>
  );
}

function describeFinding(
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
        title: `Sync has been failing${finding.since ? ` for ${formatAge(finding.since)}` : ""}, and auto-sync is on`,
        verbatim: finding.message,
        note: `Argo retries and fails${finding.retries > 0 ? ` — ${finding.retries} attempts so far` : ""}; nothing will converge until the manifest changes.`,
        offerDiff: true,
      };
    case "syncFailedOnce":
      return {
        title: `The last sync failed${finding.since ? `, ${formatAge(finding.since)} ago` : ""}, and auto-sync is off`,
        verbatim: finding.message,
        note: "Nothing is retrying it. It will stay exactly as it is until somebody syncs it again.",
        offerDiff: true,
      };
    case "drifted":
      return {
        title: `Out of sync${finding.since ? ` — last synced ${formatAge(finding.since)} ago` : " and never synced"}, and auto-sync is off`,
        note: "Nothing is going to fix this on its own. Somebody either changed the cluster by hand and meant to, or changed git and nobody pressed sync.",
        offerDiff: true,
      };
    case "degraded":
      return {
        title:
          finding.resources.length > 0
            ? `${finding.resources.map((resource) => resource.name).join(", ")} ${finding.resources.length === 1 ? "is" : "are"} degraded`
            : `${app.name} is degraded`,
        verbatim:
          finding.message ??
          finding.resources.find((resource) => resource.message)?.message ??
          null,
        note: "It is applied and it is not working, which the sync status says nothing about.",
      };
    case "condition":
      return {
        title: `Argo reports ${finding.condition.type}`,
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
  if (sets.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        No ApplicationSet in this cluster. Every Application here was written by
        hand, which means editing one is a change that stays.
      </p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title="Application sets"
        count={sets.length}
        description="A generator and the Applications it made. What it generated is a template's output — editing one of those Applications is undone the next time the generator runs."
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
                    ? "generated nothing in this cluster"
                    : generated.map((app) => app.name).join(", ")}
                </span>
                <span className="text-[11px] text-fg-fnt">
                  {plural(generated.length, "Application")}
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
  if (projects.length === 0) {
    return (
      <p className="max-w-[64ch] text-xs text-fg-mut">
        This cluster has no AppProject objects — not even{" "}
        <span className="font-mono">default</span>, which Argo normally
        installs. Every Application names a project, so one of them is naming
        something that is not there.
      </p>
    );
  }

  return (
    <Section>
      <SectionHeader
        title="Projects"
        count={projects.length}
        description="What each project lets an Application do: which repositories it may deploy from, and where it may deploy to."
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
                  ? "no repository allowed"
                  : repos.includes("*")
                    ? "any repository"
                    : repos.join(", ")}
              </span>
              <span className="truncate text-fg-mut">
                {destinations.length === 0
                  ? "no destination allowed"
                  : destinations
                      .map((destination) => {
                        const namespace =
                          !destination.namespace ||
                          destination.namespace === "*"
                            ? "any namespace"
                            : destination.namespace;
                        const cluster =
                          !destination.server || destination.server === "*"
                            ? "any cluster"
                            : destination.server;
                        return `${namespace} on ${cluster}`;
                      })
                      .join(", ")}
              </span>
              <span className="text-[11px] text-fg-fnt">
                {plural(members.length, "Application")}
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
  if (!controller) {
    return (
      <p className="text-xs text-fg-fnt">Reading Argo&rsquo;s own workloads…</p>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <Section>
        <SectionHeader
          title="Argo's own workloads"
          count={controller.components.length || undefined}
          description="Where an Argo problem is actually diagnosed. A repository it cannot reach and a webhook it never received are in the repo-server's and the controller's logs, not in any Application's status."
        />
        {controller.components.length === 0 ? (
          <p className="max-w-[64ch] text-[11px] text-fg-fnt">
            {controller.problem}
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
                  {component.ready} of {component.desired} ready
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section>
        <SectionHeader
          title="Argo's own UI"
          description="Half of what Argo knows needs a credential this app does not hold — the line-by-line diff above all. Where the cluster says how to reach Argo's UI, this page hands those questions over."
        />
        {ui ? (
          <p className="text-[11.5px] text-fg-mut">
            {routed.via && !controller.ui ? (
              <>
                {routed.via.kind}{" "}
                <span className="font-mono">{routed.via.name}</span> serves
              </>
            ) : (
              <>An Ingress serves</>
            )}{" "}
            <span className="font-mono">{SERVER_SERVICE}</span> at{" "}
            <OutLink href={ui} site="Argo CD" className="font-mono">
              {ui}
            </OutLink>
            , so every Application above offers a way into it.
          </p>
        ) : routes.isPending ? (
          <p className="text-[11.5px] text-fg-fnt">
            Reading what routes{" "}
            <span className="font-mono">{SERVER_SERVICE}</span>…
          </p>
        ) : routed.host ? (
          // The middle state, and the whole reason `tls` may be `null`: the
          // host is known and the scheme is not, so the host is named and the
          // link withheld rather than guessed at.
          <p className="max-w-[80ch] text-[11.5px] text-fg-mut">
            {routed.via?.kind ?? "Something"}{" "}
            <span className="font-mono">{routed.via?.name}</span> serves{" "}
            <span className="font-mono">{SERVER_SERVICE}</span> at{" "}
            <span className="font-mono text-fg">{routed.host}</span>, but
            nothing in the API server says whether that host is served over TLS
            — the proxy&rsquo;s entry points are start-up flags and this app
            could not read them. Rather than guess a scheme and hand you a link
            that may refuse the connection, the host is stated and left to you.
          </p>
        ) : (
          <p className="max-w-[80ch] text-[11.5px] text-fg-mut">
            {/* Says what was read, not what the cluster contains: this
                sentence used to claim the whole cluster routed nothing to
                argocd-server, from a reading of Ingresses alone, on clusters
                whose entire edge is a routing CRD. */}
            Nothing this app can read routes{" "}
            <span className="font-mono">{SERVER_SERVICE}</span> to a hostname
            {routes.available
              ? ""
              : " — no Ingress, and no routing controller installed that could be asked about its own objects"}
            . <span className="font-mono">{SERVER_SERVICE}</span> is a ClusterIP
            with no route from this machine, so there is no address this app
            could construct, and a link into a connection error is worse than no
            link. Everything on this page is read from the{" "}
            <span className="font-mono">Application</span> objects themselves
            and needs no credential.
            {routes.error && (
              <>
                {" "}
                One routing controller was asked and did not answer:{" "}
                <span className="font-mono">{routes.error.message}</span>
              </>
            )}
          </p>
        )}
      </Section>

      <Section>
        <SectionHeader
          title="Its objects"
          description="The CRDs this page reads, for a reader who wants the raw thing."
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
