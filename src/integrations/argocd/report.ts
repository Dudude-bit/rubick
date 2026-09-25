/**
 * What Argo CD's own kinds say about one object, reusing the same
 * `readApplication` the page walks, against a fake `CustomResourceInfo` built
 * from the bare `spec`/`status` `object.report` is handed, since the reader
 * is the same either way.
 */

import { GitBranch } from "lucide-react";

import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { iconSvg } from "@/lib/icon-svg";
import { refOf } from "@/lib/report-parts";
import type { ReportSection, ReportValue } from "@/lib/report";
import { statusRole } from "@/lib/status-role";
import {
  appState,
  byKind,
  destinationOf,
  projectDestinationsWords,
  projectReposWords,
  readApplication,
} from "./model";

const GROUP = "argoproj.io";
/** A report is read, not scrolled: past this the app is the place. */
const MAX_ROWS = 100;

function fakeResource(object: {
  namespace: string | null;
  name: string;
  kind: string;
  spec: unknown;
  status: unknown;
}): CustomResourceInfo {
  return {
    name: object.name,
    namespace: object.namespace,
    uid: "",
    apiVersion: `${GROUP}/v1alpha1`,
    kind: object.kind,
    spec: object.spec,
    status: object.status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
}

function sourceText(
  app: ReturnType<typeof readApplication>["sources"][number]
): string {
  return [app.repoUrl, app.path ?? app.chart, app.targetRevision]
    .filter(Boolean)
    .join(" · ");
}

function applicationSections(
  object: {
    namespace: string | null;
    name: string;
    kind: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] {
  const app = readApplication(fakeResource(object));
  const state = appState(app, t);

  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [{ text: state.text, role: state.tone }],
    },
    {
      label: t("share", "argoDestination"),
      values: [{ text: destinationOf(app, t) }],
    },
  ];
  if (app.sources.length > 0) {
    rows.push({
      label: t("share", "argoSource"),
      values: app.sources.map((source) => ({
        text: sourceText(source),
        mono: true,
      })),
    });
  }
  if (app.generatedBy) {
    rows.push({
      label: t("share", "argoGeneratedBy"),
      values: [
        {
          text: app.generatedBy.name,
          ref: refOf({
            kind: app.generatedBy.kind,
            name: app.generatedBy.name,
            namespace: object.namespace,
          }),
        },
      ],
    });
  }

  const kinds = byKind(app.resources);
  const flat = kinds.flatMap((group) => group.resources);
  const kept = flat.slice(0, MAX_ROWS);

  return [
    {
      id: "argocd-application",
      title: "Application",
      icon: iconSvg(GitBranch),
      body: { type: "facts", rows },
    },
    {
      id: "argocd-resources",
      title: t("share", "argoResources"),
      icon: iconSvg(GitBranch),
      count: flat.length,
      body: {
        type: "table",
        columns: [
          t("columns", "kind"),
          t("columns", "name"),
          t("share", "argoSync"),
          t("share", "argoHealth"),
        ],
        rows: kept.map((resource) => ({
          cells: [
            { text: resource.kind },
            {
              text: resource.name,
              ref: refOf({
                kind: resource.kind,
                name: resource.name,
                namespace: resource.namespace,
              }),
            },
            resource.sync
              ? {
                  text: resource.sync,
                  role: resource.sync === "Synced" ? "ok" : "warn",
                }
              : { text: t("share", "notWrittenYet"), quiet: true },
            resource.health
              ? { text: resource.health, role: statusRole(resource.health) }
              : { text: t("share", "notWrittenYet"), quiet: true },
          ],
        })),
        more:
          flat.length > kept.length
            ? t("share", "rowsMore", { n: flat.length - kept.length })
            : null,
      },
    },
  ];
}

function appProjectSections(spec: unknown, t: T): ReportSection[] {
  const fields = (spec ?? {}) as {
    sourceRepos?: string[];
    destinations?: Array<{ namespace?: string; server?: string }>;
    roles?: unknown[];
  };
  return [
    {
      id: "argocd-project",
      title: "AppProject",
      icon: iconSvg(GitBranch),
      body: {
        type: "facts",
        rows: [
          {
            label: "sourceRepos",
            values: [{ text: projectReposWords(fields.sourceRepos ?? [], t) }],
          },
          {
            label: "destinations",
            values: [
              {
                text: projectDestinationsWords(fields.destinations ?? [], t),
              },
            ],
          },
          {
            label: "roles",
            values: [{ text: String((fields.roles ?? []).length) }],
          },
        ],
      },
    },
  ];
}

export function reportOf(
  object: {
    group: string;
    kind: string;
    namespace: string | null;
    name: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] | null {
  if (object.group !== GROUP) return null;
  switch (object.kind) {
    case "Application":
      return applicationSections(object, t);
    case "AppProject":
      return appProjectSections(object.spec, t);
    default:
      return null;
  }
}
