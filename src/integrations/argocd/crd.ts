/**
 * Argo's own objects on the generic CRD list.
 *
 * The page is where the question is answered; this is for somebody who
 * reached `applications.argoproj.io` from the CRD list and wants columns
 * rather than raw YAML. Argo states health in two words that disagree on
 * purpose — an Application can be `Synced` and `Degraded`, which is applied
 * and not working — so both are columns and neither stands for the other.
 */

import type { CrdColumn, CrdStatus } from "../kit";
import { getValueByPath, matchMultiple } from "../kit";
import type { CrdView } from "../registry";

const status: CrdStatus = {
  getStatus: (resource) => {
    const health = getValueByPath(resource, "status.health.status") as
      string | undefined;
    const sync = getValueByPath(resource, "status.sync.status") as
      string | undefined;
    // Health first: "OutOfSync" is a statement about git, and a Degraded
    // application that happens to match git is still the more urgent word.
    if (health && health !== "Healthy") return health;
    return sync ?? health ?? null;
  },
  getVariant: (value) => {
    switch (value.toLowerCase()) {
      case "healthy":
      case "synced":
        return "default";
      case "progressing":
        return "secondary";
      case "degraded":
      case "missing":
      case "outofsync":
        return "destructive";
      default:
        return "outline";
    }
  },
};

const text = (value: unknown) => String(value ?? "-");

const applicationColumns: CrdColumn[] = [
  {
    id: "sync",
    header: "sync",
    accessor: (resource) => getValueByPath(resource, "status.sync.status"),
    cell: text,
  },
  {
    id: "health",
    header: "health",
    accessor: (resource) => getValueByPath(resource, "status.health.status"),
    cell: text,
  },
  {
    id: "project",
    header: "project",
    accessor: (resource) => getValueByPath(resource, "spec.project"),
    cell: text,
  },
  {
    id: "repo",
    header: "repository",
    accessor: (resource) =>
      getValueByPath(resource, "spec.source.repoURL") ??
      getValueByPath(resource, "spec.sources[0].repoURL"),
    cell: (value) =>
      value ? String(value).replace(/^https:\/\//, "") : "several",
  },
  {
    id: "destination",
    header: "destination",
    accessor: (resource) =>
      getValueByPath(resource, "spec.destination.namespace"),
    cell: text,
  },
  {
    id: "autoSync",
    header: "autoSync",
    accessor: (resource) =>
      getValueByPath(resource, "spec.syncPolicy.automated") != null,
    cell: (value) => (value ? "on" : "off"),
  },
];

const applicationSetColumns: CrdColumn[] = [
  {
    id: "generators",
    header: "generators",
    accessor: (resource) => {
      const generators = getValueByPath(resource, "spec.generators");
      return Array.isArray(generators)
        ? generators
            .flatMap((generator) => Object.keys(generator ?? {}))
            .join(", ")
        : null;
    },
    cell: text,
  },
  {
    id: "goTemplate",
    header: "template",
    accessor: (resource) =>
      getValueByPath(resource, "spec.template.metadata.name"),
    cell: text,
  },
];

const projectColumns: CrdColumn[] = [
  {
    id: "repos",
    header: "sourceRepos",
    accessor: (resource) => {
      const repos = getValueByPath(resource, "spec.sourceRepos");
      return Array.isArray(repos) ? repos.join(", ") : null;
    },
    cell: text,
  },
  {
    id: "destinations",
    header: "destinations",
    accessor: (resource) => {
      const destinations = getValueByPath(resource, "spec.destinations");
      return Array.isArray(destinations) ? destinations.length : 0;
    },
    cell: (value) => `${value}`,
  },
];

/**
 * Three kinds, named one by one rather than by group.
 *
 * `argoproj.io` is not Argo CD's — Argo Rollouts and Argo Workflows put
 * `Rollout`, `AnalysisRun` and `Workflow` in the same group, and claiming the
 * group would draw a Workflow with a sync status it does not have.
 */
export const crd: CrdView = {
  matches: matchMultiple([
    ["argoproj.io", "Application"],
    ["argoproj.io", "ApplicationSet"],
    ["argoproj.io", "AppProject"],
  ]),
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "applicationset":
        return applicationSetColumns;
      case "appproject":
        return projectColumns;
      default:
        return applicationColumns;
    }
  },
  status,
};
