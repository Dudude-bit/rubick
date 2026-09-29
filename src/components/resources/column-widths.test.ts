import { describe, expect, it } from "vitest";

import { configMapColumns } from "./ConfigMapList";
import { columns as cronJobs } from "./CronJobList";
import { columns as daemonSets } from "./DaemonSetList";
import { columns as deployments } from "./DeploymentList";
import { columns as endpoints } from "./EndpointsList";
import { baseColumns as ingresses } from "./IngressList";
import { columns as jobs } from "./JobList";
import { columns as namespaces } from "./NamespaceList";
import { networkPolicyColumns } from "./NetworkPolicyList";
import { columns as nodes } from "./NodeList";
import { columns as persistentVolumeClaims } from "./PersistentVolumeClaimList";
import { columns as persistentVolumes } from "./PersistentVolumeList";
import { columns as pods } from "./PodList";
import { columns as secrets } from "./SecretList";
import { columns as services } from "./ServiceList";
import { columns as statefulSets } from "./StatefulSetList";
import { columns as storageClasses } from "./StorageClassList";

/** The fields the questions below need, so one array can hold them all. */
interface Column {
  size?: number;
  id?: string;
  accessorKey?: unknown;
  accessorFn?: unknown;
  header?: unknown;
  meta?: { share?: unknown; label?: unknown };
}

/**
 * Every list page whose columns can be reached from a test.
 *
 * Three tables are missing, and it is worth naming them rather than leaving
 * the list looking complete:
 *
 * - CustomResources builds its columns from whichever CRD is installed, so
 *   their widths are decided there and cannot be decided here.
 * - CRDs (`src/pages/Crds.tsx`) and Helm releases
 *   (`src/components/helm/HelmReleasesTab.tsx`) build theirs in a `useMemo`
 *   inside the component and close over its state, so reaching them means
 *   either rendering the page with a cluster's worth of mocks behind it or
 *   lifting the array out into a factory that takes those callbacks.
 *
 * The last two are that one refactor away from being covered here, the way
 * every page below already is. Until someone lifts them out, this file does
 * not speak for them — which is the point of saying so rather than letting
 * the list read as the whole app.
 */
const PAGES: [string, Column[]][] = [
  ["ConfigMaps", configMapColumns()],
  ["CronJobs", cronJobs()],
  ["DaemonSets", daemonSets()],
  ["Deployments", deployments()],
  ["Endpoints", endpoints()],
  ["Ingresses", ingresses],
  ["Jobs", jobs()],
  ["Namespaces", namespaces],
  ["NetworkPolicies", networkPolicyColumns],
  ["Nodes", nodes(new Map())],
  ["PersistentVolumeClaims", persistentVolumeClaims],
  ["PersistentVolumes", persistentVolumes()],
  ["Pods", pods],
  ["Secrets", secrets()],
  ["Services", services()],
  ["StatefulSets", statefulSets()],
  ["StorageClasses", storageClasses()],
];

const nameOf = (column: Column) => String(column.id ?? column.accessorKey);

describe("what a list page declares about its columns", () => {
  /**
   * The table is fixed-layout, so a column that names no size takes
   * TanStack's 150px default. Miss one and it is not obviously wrong — it is
   * a table where an age is as wide as a hostname, and nothing in the code
   * says so.
   */
  it.each(PAGES)("%s sizes every column it draws", (_page, columns) => {
    const unsized = columns.filter((c) => c.size === undefined).map(nameOf);
    expect(unsized).toEqual([]);
  });

  /**
   * The name is what a reader aims at and the only cell that is never
   * shorthand, so nothing beside it may claim more of the row. The trap is a
   * bespoke column added later with a generous size and no view of the table
   * it landed in.
   */
  it.each(PAGES)("%s keeps the name the widest column", (_page, columns) => {
    // Found, not assumed to be first. Leading with something else is a real
    // shape — Helm's releases table opens on `source` — and a `columns[0]`
    // that quietly stopped being the name turns this into a check that no
    // column is wider than whatever happens to be leftmost, which passes.
    const name = columns.find((c) => c.accessorKey === "name");
    expect(name).toBeDefined();
    const nameSize = name?.size ?? 0;
    const wider = columns.filter((c) => c !== name && (c.size ?? 0) > nameSize);
    expect(wider.map(nameOf)).toEqual([]);
  });

  /**
   * A shared file carries each column in the words its cell draws: a value
   * behind it, or a `share` that says them. A column with neither is named
   * in the file as left out, which is honest and is also a column a
   * colleague does not get — the Deployments list sent Name and Created
   * while its Replicas and Status said `0/3` and `Progressing`.
   *
   * The ones here draw what the row does not hold, and are left out by name.
   */
  const CANNOT_SAY: Record<string, string> = {
    // Namespaces: counted from the pod list by the page, not the row.
    pods: "a count the page keeps beside the list",
  };
  const OWN = new Set(["name", "namespace", "age"]);

  it.each(PAGES)(
    "%s can say, in a shared file, what every column draws",
    (_page, columns) => {
      const mute = columns
        .filter((c) => !OWN.has(nameOf(c)))
        .filter(
          (c) =>
            !c.meta?.share &&
            !c.accessorKey &&
            !c.accessorFn &&
            !(nameOf(c) in CANNOT_SAY)
        )
        .map(nameOf);
      expect(mute).toEqual([]);
    }
  );

  /** A header the file cannot name is a column in the file with no title. */
  it.each(PAGES)(
    "%s names every column in words the file can use",
    (_page, columns) => {
      const unnamed = columns
        .filter(
          (c) =>
            typeof c.header !== "string" &&
            !(c.header as { saying?: unknown } | undefined)?.saying &&
            !c.meta?.label
        )
        .map(nameOf);
      expect(unnamed).toEqual([]);
    }
  );
});
