import { describe, expect, it } from "vite-plus/test";

import { columnShares } from "@/components/ui/column-shares";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { headerFloor } from "@/lib/column-label";

import { NAME_CELL_PX } from "./columns";

import { configMapColumns } from "../(config)/configmaps/-components/ConfigMapList";
import { columns as cronJobs } from "../(workloads)/cronjobs/-components/CronJobList";
import { columns as daemonSets } from "../(workloads)/daemonsets/-components/DaemonSetList";
import { columns as deployments } from "../(workloads)/deployments/-components/DeploymentList";
import { columns as endpoints } from "../(network)/endpoints/-components/EndpointsList";
import { baseColumns as ingresses } from "../(network)/ingresses/-components/IngressList";
import { columns as jobs } from "../(workloads)/jobs/-components/JobList";
import { columns as namespaces } from "../(cluster)/namespaces/-components/NamespaceList";
import { networkPolicyColumns } from "../(network)/networkpolicies/-components/NetworkPolicyList";
import { columns as nodes } from "../(cluster)/nodes/-components/NodeList";
import { columns as persistentVolumeClaims } from "../(storage)/persistentvolumeclaims/-components/PersistentVolumeClaimList";
import { columns as persistentVolumes } from "../(storage)/persistentvolumes/-components/PersistentVolumeList";
import { columns as pods } from "../(workloads)/pods/-components/PodList";
import { columns as secrets } from "../(config)/secrets/-components/SecretList";
import { columns as services } from "../(network)/services/-components/ServiceList";
import { columns as statefulSets } from "../(workloads)/statefulsets/-components/StatefulSetList";
import { columns as storageClasses } from "../(storage)/storageclasses/-components/StorageClassList";

/** The fields the questions below need, so one array can hold them all. */
interface Column {
  size?: number;
  id?: string;
  accessorKey?: unknown;
  accessorFn?: unknown;
  header?: unknown;
  meta?: { share?: unknown; label?: unknown; floor?: number };
}

/**
 * Every list page whose columns can be reached from a test.
 *
 * Three tables are missing, and it is worth naming them rather than leaving
 * the list looking complete:
 *
 * - CustomResources builds its columns from whichever CRD is installed, so
 *   their widths are decided there and cannot be decided here.
 * - CRDs (`src/ui/routes/c/$cluster/(cluster)/customresourcedefinitions/-components/Crds.tsx`) and Helm releases
 *   (`src/ui/routes/c/$cluster/(cluster)/helm/-components/HelmReleasesTab.tsx`) build theirs in a `useMemo`
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
    // Services and Ingresses: a verdict read once for the page, not the row.
    health: "a verdict the page reads beside the list",
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

const en: T = (section, key, values) => translate("en", section, key, values);
const ru: T = (section, key, values) => translate("ru", section, key, values);

/** Four quick actions, the most a list carries. */
const ACTIONS = { size: 20 + 4 * 22 };

/** What `DataTable` lays a list out by: its sizes, and the floors under them. */
const drawn = (columns: Column[], t: T = en) =>
  [...columns, ACTIONS].map((c) => ({
    size: c.size ?? 150,
    floor: Math.max(
      "meta" in c ? (c.meta?.floor ?? 0) : 0,
      "header" in c ? headerFloor(c, t) : 0
    ),
  }));

describe("an address column", () => {
  const ADDRESS = new Set([
    "ip",
    "clusterIp",
    "internal_ip",
    "externalIps",
    "loadBalancerIps",
  ]);
  /** 15 glyphs of 12px JetBrains Mono, the 14px copy mark, 20px of cell padding. */
  const WHOLE_IPV4_PX = 15 * 7.2 + 14 + 20;
  /** A 1440px window with and without the peek open. */
  const WIDTHS = [640, 1160];

  /**
   * Sam read "10.111.219.1..." for 10.111.219.134 in Services, "192.168..."
   * on every Pods row and "172.30.1..." on Nodes: the share a column got of
   * the table was narrower than the address. Fails if any list draws an
   * address column narrower than a whole IPv4 and its copy mark.
   */
  it.each(
    PAGES.filter(([, columns]) => columns.some((c) => ADDRESS.has(nameOf(c))))
  )(
    "%s draws a whole IPv4 at every width a list is drawn at",
    (_page, columns) => {
      const specs = drawn(columns);
      for (const width of WIDTHS) {
        const shares = columnShares(specs, width);
        columns.forEach((column, index) => {
          if (!ADDRESS.has(nameOf(column))) return;
          expect((shares[index] / 100) * width).toBeGreaterThanOrEqual(
            WHOLE_IPV4_PX
          );
        });
      }
    }
  );
});

describe("the Pods status column", () => {
  /**
   * Sam read "CreateContainerConfi..." on checkout-worker: the one status a
   * reader matches against the terminal, cut. Fails if the column stops
   * fitting that reason, its mark and its padding at 1440px.
   */
  it("fits CreateContainerConfigError whole at 1440px", () => {
    const status = pods.findIndex((c) => c.id === "status");
    const shares = columnShares(drawn(pods), 1160);
    expect((shares[status] / 100) * 1160).toBeGreaterThanOrEqual(
      "CreateContainerConfigError".length * 7.2 + 14 + 20
    );
  });
});

describe("the Name column", () => {
  /** The name is what a reader aims at; fails if a list's Name column can be drawn narrower than a pod's name. */
  it.each(PAGES)(
    "%s never draws its Name under the shared floor",
    (_page, columns) => {
      const name = columns.find((c) => c.accessorKey === "name");
      expect(name?.meta?.floor).toBeGreaterThanOrEqual(NAME_CELL_PX);
    }
  );
});

describe("the Pods table at a 1440px window", () => {
  /** The scope is one namespace, or grouped by namespace: no Namespace column either way. */
  const shown: Column[] = (pods as Column[]).filter(
    (c) => nameOf(c) !== "namespace"
  );
  const WIDTH = 1160;

  /**
   * Marco read "checko…" for three different pods and Lena "Перезапус…" on a
   * table with room: the floors are pixels, so fails if Name is drawn under
   * its floor, or a header under its own words, in either language.
   */
  it.each([
    ["English", en],
    ["Russian", ru],
  ] as const)(
    "draws Name and every header whole, without a scrollbar, in %s",
    (_language, t) => {
      const specs = drawn(shown, t);
      const shares = columnShares(specs, WIDTH);
      const px = shares.map((share) => (share / 100) * WIDTH);
      const name = shown.findIndex((c) => c.accessorKey === "name");
      expect(px[name]).toBeGreaterThanOrEqual(NAME_CELL_PX);
      shown.forEach((column, index) => {
        expect(px[index], nameOf(column)).toBeGreaterThanOrEqual(
          headerFloor(column, t)
        );
      });
      expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(
        100.0001
      );
    }
  );

  /** "7 (59 мин назад)" was cut to "7 (4 мин на…" beside a free strip of row actions. */
  it("keeps the whole restart count and its age in Russian", () => {
    const restarts = shown.findIndex((c) => c.id === "restarts");
    const px = (columnShares(drawn(shown, ru), WIDTH)[restarts] / 100) * WIDTH;
    expect(px).toBeGreaterThanOrEqual("7 (59 мин назад)".length * 7.2 + 20);
  });
});
