import { describe, expect, it } from "vite-plus/test";

import { actionsColumnSize, tableLayout } from "@/components/ui/column-shares";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { columnFloor } from "@/lib/column-label";
import { serviceVerdictLabels } from "@/lib/service-health";
import {
  cronStatusWord,
  isRolloutCode,
  ownStatusWord,
  rolloutWord,
} from "@/lib/status-words";

import { AGE_CELL_PX, NAME_CELL_PX, NODE_CELL_PX } from "./columns";

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
  meta?: {
    share?: unknown;
    label?: unknown;
    floor?: number | ((t: T) => number);
  };
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
const ACTIONS = {
  size: actionsColumnSize(4),
  meta: { floor: actionsColumnSize(4) },
};

/** What `DataTable` lays a list out by: its sizes, and the floors under them. */
const drawn = (columns: Column[], t: T = en) =>
  [...columns, ACTIONS].map((c) => ({
    size: c.size ?? 150,
    floor: columnFloor(c, t),
  }));

/** Each column's pixels in a port `port` wide, and whether the port has to scroll. */
const laidOut = (columns: Column[], port: number, t: T = en) => {
  const layout = tableLayout(drawn(columns, t), port);
  return {
    ...layout,
    px: layout.shares.map((share) => (share / 100) * layout.span),
  };
};

/** A 1440px window with and without the peek open, and a 1160px one: the port is the window less the sidebar and gutters. */
const PORTS = [1160, 880, 640];

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
      for (const port of PORTS) {
        const { px } = laidOut(columns, port);
        columns.forEach((column, index) => {
          if (!ADDRESS.has(nameOf(column))) return;
          expect(px[index]).toBeGreaterThanOrEqual(WHOLE_IPV4_PX);
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
    expect(laidOut(pods, 1160).px[status]).toBeGreaterThanOrEqual(
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
      expect(columnFloor(name ?? {}, en)).toBeGreaterThanOrEqual(NAME_CELL_PX);
    }
  );

  /** Lena read "named-port-de…-dcbc89bf5-4lh84": fails if the floor stops fitting 31 glyphs, the icon and the copy mark. */
  it("holds a 31 character pod name whole", () => {
    expect(NAME_CELL_PX).toBeGreaterThanOrEqual(
      "named-port-demo-dcbc89bf5-4lh84".length * 7.2 + 2 * (14 + 4) + 20
    );
  });
});

describe("every list at the windows it is drawn in", () => {
  const LANGUAGES = [
    ["English", en],
    ["Russian", ru],
  ] as const;

  /**
   * Dana read "1..." for an age and Lena "С…" for CPU, because a table that
   * cannot give every column its floor squeezed them under it. Fails if any
   * column of any list is drawn under its floor, in either language, at the
   * window 1440px, 1160px wide or beside the peek.
   */
  it.each(
    PAGES.flatMap(([page, columns]) =>
      LANGUAGES.map(([name, t]) => [page, name, columns, t] as const)
    )
  )(
    "%s draws every column at or over its floor in %s",
    (_page, _language, columns, t) => {
      const specs = drawn(columns, t);
      for (const port of PORTS) {
        const { px } = laidOut(columns, port, t);
        specs.forEach((spec, index) => {
          expect(px[index], `${index} at ${port}`).toBeGreaterThanOrEqual(
            spec.floor - 0.0001
          );
        });
      }
    }
  );

  /**
   * Fixed layout shares a table's width out in per cent, and per cent of a
   * table that cannot be wider than its port are a cut. Fails if a list whose
   * floors add up to more than the port stops asking for the width they need,
   * or asks for more than they need when they fit.
   */
  it.each(
    PAGES.flatMap(([page, columns]) =>
      LANGUAGES.map(([name, t]) => [page, name, columns, t] as const)
    )
  )(
    "%s scrolls exactly when its floors outgrow the window in %s",
    (_page, _language, columns, t) => {
      const floors = drawn(columns, t).reduce((sum, c) => sum + c.floor, 0);
      for (const port of PORTS) {
        const { span, scrolls, shares } = laidOut(columns, port, t);
        expect(scrolls).toBe(floors > port);
        expect(span).toBe(Math.max(port, floors));
        expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100);
      }
    }
  );
});

describe("the cells a narrow port draws at their floors", () => {
  /**
   * Beside a docked peek a 1440px window leaves a list about 720px, so every
   * column is drawn at its floor. Fails if Nodes stops fitting NotReady,
   * control-plane and a kubelet version there, or CronJobs a five-field
   * schedule, in either language: they read "Re…", "control-pl…" and "v1.37…".
   */
  it.each([
    ["English", en],
    ["Russian", ru],
  ] as const)(
    "Nodes and CronJobs keep their short values whole in %s",
    (_language, t) => {
      const nodeColumns = nodes(new Map());
      const node = laidOut(nodeColumns, 640, t).px;
      const at = (id: string) => nodeColumns.findIndex((c) => nameOf(c) === id);
      expect(node[at("status")]).toBeGreaterThanOrEqual(
        "NotReady".length * 6.6 + 14 + 20
      );
      expect(node[at("roles")]).toBeGreaterThanOrEqual(
        "control-plane".length * 6.6 + 20
      );
      expect(node[at("version")]).toBeGreaterThanOrEqual(
        "v1.37.10".length * 6.6 + 20
      );
      const cronColumns = cronJobs();
      const schedule = cronColumns.findIndex((c) => nameOf(c) === "schedule");
      expect(laidOut(cronColumns, 640, t).px[schedule]).toBeGreaterThanOrEqual(
        "*/15 * * * *".length * 7.2 + 20
      );
    }
  );
});

describe("the CronJobs Suspend column", () => {
  /**
   * Lena read "Приостан…" in a column sized for "Suspended". Fails if the
   * column stops fitting its badge's word, the mark and the padding in either
   * language.
   */
  it.each([
    ["English", en],
    ["Russian", ru],
  ] as const)("fits the whole Suspended badge in %s", (_language, t) => {
    const columns = cronJobs();
    const suspend = columns.findIndex((c) => c.id === "suspend");
    const word = cronStatusWord(true, t);
    expect(laidOut(columns, 1160, t).px[suspend]).toBeGreaterThanOrEqual(
      word.length * 6.6 + 14 + 20
    );
  });
});

describe("the status column of a workload and a Job", () => {
  const ROLLOUT_CODES = [
    "Ready",
    "Progressing",
    "Idle",
    "Stalled",
    "Unavailable",
    "Paused",
    "Waiting",
    "Degraded",
  ];
  const JOB_CODES = [
    "Complete",
    "Failed",
    "Suspended",
    "Retrying",
    "Running",
    "Pending",
  ];
  const word = (code: string, t: T) =>
    isRolloutCode(code)
      ? rolloutWord(code, t)
      : (ownStatusWord(code, t) ?? code);
  const widest = (codes: string[], t: T) =>
    Math.max(...codes.map((code) => word(code, t).length));

  /**
   * "Повторяет попытку", "Деградировал" and "Развёртывается" are longer than
   * the English words the columns were sized for. Fails if a status column can be drawn narrower
   * than its widest word, the mark and the padding in either language.
   */
  it.each([
    ["Deployments", deployments(), ROLLOUT_CODES],
    ["DaemonSets", daemonSets(), ROLLOUT_CODES],
    ["StatefulSets", statefulSets(), ROLLOUT_CODES],
    ["Jobs", jobs(), JOB_CODES],
  ] as [string, Column[], string[]][])(
    "fits the widest word of %s in both languages",
    (_page, columns, codes) => {
      const status = columns.findIndex((c) => c.id === "status");
      for (const t of [en, ru]) {
        for (const port of PORTS) {
          expect(laidOut(columns, port, t).px[status]).toBeGreaterThanOrEqual(
            widest(codes, t) * 6.6 + 14 + 20
          );
        }
      }
    }
  );
});

describe("the Pods table", () => {
  /** The scope is one namespace, or grouped by namespace: no Namespace column either way. */
  const shown: Column[] = (pods as Column[]).filter(
    (c) => nameOf(c) !== "namespace"
  );
  const column = (id: string) => shown.findIndex((c) => nameOf(c) === id);

  /**
   * Marco read "contro…" for controlplane and Dana "1…" for 27m: the Name floor
   * took the room the short columns needed. Fails if Age stops fitting the
   * widest age in either language, or Node a node's usual name.
   */
  it.each([
    ["English", en, 29.7],
    ["Russian", ru, 41.3],
  ] as const)(
    "draws the widest Age, and a node name, whole in %s",
    (_language, t, widestAgePx) => {
      for (const port of PORTS) {
        const { px } = laidOut(shown, port, t);
        expect(px[column("age")]).toBeGreaterThanOrEqual(widestAgePx + 20);
        expect(px[column("node")]).toBeGreaterThanOrEqual(NODE_CELL_PX);
      }
      expect(AGE_CELL_PX).toBeGreaterThanOrEqual(widestAgePx + 20);
    }
  );

  /** "7 (59 мин назад)" was cut to "7 (4 мин на…" beside a free strip of row actions. */
  it("keeps the whole restart count and its age in Russian", () => {
    const { px } = laidOut(shown, 1160, ru);
    expect(px[column("restarts")]).toBeGreaterThanOrEqual(
      "7 (59 мин назад)".length * 7.2 + 20
    );
  });

  /** Fails if the row's buttons can be squeezed to nothing once every other column sits at its floor. */
  it("keeps the room the row's buttons need when the table scrolls", () => {
    const { px, scrolls } = laidOut(shown, 640, ru);
    expect(scrolls).toBe(true);
    expect(px[px.length - 1]).toBeGreaterThanOrEqual(
      actionsColumnSize(4) - 0.0001
    );
  });
});

describe("a value a cell says in words", () => {
  const floorOf = (columns: Column[], id: string, t: T) =>
    columnFloor(columns.find((c) => nameOf(c) === id) ?? {}, t);

  /** Lena read "ни один не го…" in Services: fails if the Endpoints column stops holding its widest verdict badge in either language. */
  it.each([
    ["English", en],
    ["Russian", ru],
  ] as const)("holds every Service verdict whole in %s", (_language, t) => {
    for (const label of serviceVerdictLabels(t))
      expect(floorOf(services(), "health", t)).toBeGreaterThanOrEqual(
        Math.ceil(label.length * 6.6 + 14 + 20)
      );
  });

  /** Lena read "нет зам…" under Память on Nodes: fails if a metric column stops holding the words it says when there is no value. */
  it.each([
    ["Nodes", nodes(new Map())],
    ["Pods", pods],
  ] as const)(
    "%s holds a metric's no-sample words in Russian",
    (_page, columns) => {
      for (const id of ["cpu", "memory"])
        expect(floorOf(columns, id, ru)).toBeGreaterThanOrEqual(
          Math.ceil("нет замера".length * 7.2 + 20)
        );
    }
  );

  /** Fails if a Services row cuts its type, its namespace or a Cilium-sized port name once the window narrows. */
  it("holds a Service's type, namespace and named port whole", () => {
    expect(floorOf(services(), "type", en)).toBeGreaterThanOrEqual(
      Math.ceil("LoadBalancer".length * 7 + 20)
    );
    expect(floorOf(services(), "namespace", en)).toBeGreaterThanOrEqual(
      Math.ceil("ingress-nginx".length * 7.2 + 20)
    );
    expect(floorOf(services(), "ports", en)).toBeGreaterThanOrEqual(
      Math.ceil(
        "9964→9964".length * 7.2 + 4 + "envoy-metrics · TCP".length * 6.2 + 20
      )
    );
  });
});
