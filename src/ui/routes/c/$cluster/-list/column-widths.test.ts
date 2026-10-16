import { describe, expect, it } from "vite-plus/test";

import {
  actionsColumnSize,
  tableLayout,
  yieldedColumns,
} from "@/components/ui/column-shares";
import { IPV4_CELL_PX } from "@/components/ui/copyable-value";
import type { AppColumnMeta } from "@/components/ui/table-features";
import { translate } from "@/i18n";
import type {
  IngressInfo,
  NetworkPolicyInfo,
  PersistentVolumeClaimInfo,
  PolicyDirection,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import { columnFloor, columnIdeal, headerFloor } from "@/lib/column-label";
import type { MetricsAbsence } from "@/lib/metrics-absence";
import { directionCellWords, reachWords } from "@/lib/network-policy";
import { serviceVerdictLabels } from "@/lib/service-health";
import {
  cronStatusWord,
  isRolloutCode,
  ownStatusWord,
  rolloutWord,
} from "@/lib/status-words";

import { useLocaleStore } from "@/stores/localeStore";

import {
  AGE_CELL_PX,
  NAME_CELL_PX,
  NODE_CELL_PX,
  statusCellPx,
} from "./columns";

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
    floor?: AppColumnMeta["floor"];
    yields?: number;
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
  ["PersistentVolumeClaims", persistentVolumeClaims([])],
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
    // Services and Ingresses: a verdict read once for the page, not the
    // row; the page hands it to the columns, which share it from there.
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

/** What `DataTable` lays a list out by: its sizes, and the floors under them for `rows`. */
const drawn = (columns: Column[], t: T = en, rows: readonly unknown[] = []) =>
  [...columns, ACTIONS].map((c) => ({
    size: c.size ?? 150,
    floor: columnFloor(c, t, rows),
  }));

/** Each column's pixels in a port `port` wide, and whether the port has to scroll. */
const laidOut = (
  columns: Column[],
  port: number,
  t: T = en,
  rows: readonly unknown[] = []
) => {
  const layout = tableLayout(drawn(columns, t, rows), port);
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
    (page, columns) => {
      // Ingresses and Services' External IPs hold an address's width only while a row has one.
      const rows =
        page === "Ingresses"
          ? [{ loadBalancerIps: ["10.111.219.134"] }]
          : page === "Services"
            ? [{ externalIps: ["10.111.219.134"] }]
            : [];
      for (const port of PORTS) {
        const { px } = laidOut(columns, port, en, rows);
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
   * asks for more when they fit, or ends its sideways scroll on a sliver of
   * a column beside the pinned one: Lena read a stray ")" of a restart count
   * there.
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
        const { span, scrolls, shares, px } = laidOut(columns, port, t);
        expect(scrolls).toBe(floors > port);
        expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100);
        if (!scrolls) {
          expect(span).toBe(port);
          continue;
        }
        expect(span).toBeGreaterThanOrEqual(floors);
        const room = port - px[0];
        const ends = px.map((_, at) =>
          px.slice(at).reduce((sum, width) => sum + width, 0)
        );
        const first = ends.findIndex((end, at) => at > 1 && end <= room + 0.01);
        if (first < 0) continue;
        const sliver = room - ends[first];
        expect(
          sliver < 0.01 || sliver >= Math.min(64, px[first - 1] / 2),
          `${sliver} at ${port}`
        ).toBe(true);
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

describe("the Jobs status column", () => {
  /**
   * Lena read "Fai… BackoffLimitEx…" and "Повторя… 1 упавший под" in all
   * namespaces at 1024 in Russian, with the Age column beside them half
   * empty. Fails if the column's floor stops holding the widest badge with
   * the reason or the failed pods it draws beside it, in either language.
   */
  it.each([
    ["English", en],
    ["Russian", ru],
  ] as const)(
    "holds a badge and what follows it whole in %s",
    (_language, t) => {
      const rows = [
        {
          status: "Failed",
          failed: 6,
          failure: { reason: "BackoffLimitExceeded" },
        },
        { status: "Retrying", failed: 1, failure: null },
        { status: "Complete", failed: 0, failure: null },
      ];
      const columns = jobs();
      const status = columns.findIndex((c) => nameOf(c) === "status");
      const px = laidOut(columns, 640, t, rows).px[status];
      const drawn = (word: string, beside: number) =>
        word.length * 6.6 + 14 + 6 + beside + 20;
      expect(px).toBeGreaterThanOrEqual(
        drawn(
          ownStatusWord("Failed", t) ?? "Failed",
          "BackoffLimitExceeded".length * 6.6
        )
      );
      expect(px).toBeGreaterThanOrEqual(
        drawn(
          ownStatusWord("Retrying", t) ?? "Retrying",
          t("count", "failedPods", { n: 1 }).length * 6.2
        )
      );
    }
  );
});

describe("the Services type column", () => {
  /**
   * Lena read "ExternalName example…" in all namespaces at 1024 in Russian:
   * the column was sized for the type alone. Fails if it stops holding an
   * ExternalName's target and its copy mark whole beside a narrow window.
   */
  it("holds an ExternalName's target whole", () => {
    const rows = [
      { type: "ExternalName", externalName: "example.com" },
      { type: "ClusterIP", externalName: null },
    ];
    const columns = services();
    const type = columns.findIndex((c) => nameOf(c) === "type");
    expect(laidOut(columns, 640, ru, rows).px[type]).toBeGreaterThanOrEqual(
      "example.com".length * 7.2 + 14 + 20
    );
  });
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
        expect(px[column("node")]).toBeGreaterThanOrEqual(
          NODE_CELL_PX - 0.0001
        );
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
  const floorOf = (
    columns: Column[],
    id: string,
    t: T,
    rows: readonly unknown[] = [],
    absence: MetricsAbsence | null = null
  ) =>
    columnFloor(columns.find((c) => nameOf(c) === id) ?? {}, t, rows, absence);

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

  const unmeasured = [{ name: "web-0" }];

  /** Lena read "нет зам…" under Память on Nodes: fails if a metric column stops holding the words it says when there is no value. */
  it.each([
    ["Nodes", nodes(new Map())],
    ["Pods", pods],
  ] as const)(
    "%s holds a metric's no-sample words in Russian",
    (_page, columns) => {
      for (const id of ["cpu", "memory"])
        expect(floorOf(columns, id, ru, unmeasured)).toBeGreaterThanOrEqual(
          Math.ceil("нет замера".length * 7.2 + 20)
        );
    }
  );

  /**
   * With metrics-server not installed every CronJob row said "n/a" in a
   * column holding "no sample", and Last run cut "Pod Security rest…".
   * Fails if a column whose rows all say "n/a" keeps the room of a word
   * none of them says, or of a figure none of them has.
   */
  it.each([
    ["Nodes", nodes(new Map())],
    ["Pods", pods],
    ["CronJobs", cronJobs() as Column[]],
  ] as const)(
    "%s keeps only the room n/a takes where metrics-server is missing",
    (_page, columns) => {
      for (const id of ["cpu", "memory"]) {
        const column = columns.find((c) => nameOf(c) === id) ?? {};
        expect(
          floorOf(columns, id, en, unmeasured, "notInstalled")
        ).toBeLessThanOrEqual(
          Math.max(headerFloor(column, en), Math.ceil("n/a".length * 7.2 + 20))
        );
      }
    }
  );

  /** Fails if a column with a figure in it stops holding the widest figure, `1.81Gi`. */
  it("holds a figure where one row has one", () => {
    expect(
      floorOf(pods, "cpu", en, [{ name: "web-0", cpuMillicores: 1250 }])
    ).toBeGreaterThanOrEqual(Math.ceil(6 * 7.2 + 20));
  });

  /** Fails if a Services row cuts its type, its namespace or a Cilium-sized port name once the window narrows. */
  it("holds a Service's type, namespace and named port whole", () => {
    expect(floorOf(services(), "type", en)).toBeGreaterThanOrEqual(
      Math.ceil("LoadBalancer".length * 7 + 20)
    );
    expect(floorOf(services(), "namespace", en)).toBeGreaterThanOrEqual(
      Math.ceil("ingress-nginx".length * 7.2 + 20)
    );
    const cilium = [
      {
        ports: [
          {
            name: "envoy-metrics",
            port: 9964,
            targetPort: "9964",
            nodePort: null,
            protocol: "TCP",
          },
        ],
      },
    ];
    expect(floorOf(services(), "ports", en, cilium)).toBeGreaterThanOrEqual(
      Math.ceil(
        "9964→9964".length * 7.2 + 4 + "envoy-metrics · TCP".length * 6.2 + 20
      )
    );
  });
});

describe("a short value a row holds, in a 1024px window in Russian", () => {
  /** The port a 1024px window leaves a list, less the sidebar and gutters. */
  const PORT_1024 = 784;
  const at = (columns: Column[], id: string) =>
    columns.findIndex((c) => nameOf(c) === id);

  /** Lena read "v1.35...." for v1.35.5+k3s1 on Nodes. Fails if the Version column can be drawn narrower than the longest version a node reports. */
  it("draws a k3s kubelet version whole on Nodes", () => {
    const rows = [
      { name: "k3d-rubick-live-agent-0", version: "v1.35.5+k3s1" },
      { name: "k3d-rubick-live-server-0", version: "v1.35.5+k3s1" },
    ];
    const columns = nodes(new Map());
    const { px } = laidOut(columns, PORT_1024, ru, rows);
    expect(px[at(columns, "version")]).toBeGreaterThanOrEqual(
      "v1.35.5+k3s1".length * 6.6 + 20
    );
  });

  /** Lena read "Rolling..." for RollingUpdate on Deployments. Fails if the Strategy column can be drawn narrower than either strategy's name. */
  it.each([
    ["English", en],
    ["Russian", ru],
  ] as const)("draws RollingUpdate whole on Deployments in %s", (_l, t) => {
    const columns = deployments();
    const { px } = laidOut(columns, PORT_1024, t);
    expect(px[at(columns, "strategy")]).toBeGreaterThanOrEqual(
      "RollingUpdate".length * 6.6 + 20
    );
  });

  /**
   * Lena's Pods list needed a sideways scroll at 1024 in Russian and cut the
   * Restarts header to "Пер…". Fails if the list stops fitting by hiding
   * what kubectl prints only with -o wide and the metrics, or hides a column
   * kubectl always prints while those are still there.
   */
  it("fits Pods by hiding its wide and metric columns, not the ones kubectl always prints", () => {
    const shown = (pods as Column[]).filter((c) => nameOf(c) !== "namespace");
    const rows = [
      {
        name: "hello-web-5966d9b889-7nvr5",
        nodeName: "k3d-rubick-live-agent-0",
        restartCount: 14,
        status: { display: "Running" },
      },
      {
        name: "wd-demo",
        nodeName: "k3d-rubick-live-server-0",
        restartCount: 0,
        status: { display: "Running" },
      },
    ];
    const specs = drawn(shown, ru, rows).map((spec, index) => ({
      id: index < shown.length ? nameOf(shown[index]) : "actions",
      floor: spec.floor,
      yields: (shown[index]?.meta as { yields?: number } | undefined)?.yields,
    }));
    const hidden = yieldedColumns(specs, PORT_1024);
    expect(hidden.slice(0, 4)).toEqual(["ip", "node", "memory", "cpu"]);
    const kept = specs.filter((spec) => !hidden.includes(spec.id));
    expect(kept.map((spec) => spec.id)).toEqual(
      expect.arrayContaining(["name", "status", "ready", "restarts", "actions"])
    );
    expect(kept.reduce((sum, spec) => sum + spec.floor, 0)).toBeLessThanOrEqual(
      PORT_1024
    );
  });

  /** One row as Lena's lena-sandbox held it, in the fields every list's floors read. */
  const LENAS_ROWS = [
    {
      name: "hello-web-5966d9b889-7nvr5",
      status: { display: "Running" },
      nodeName: "k3d-rubick-live-agent-0",
      version: "v1.35.5+k3s1",
      restartCount: 15,
      selects: { kind: "written", query: "app.kubernetes.io/name=traefik" },
      selected: 1,
      ingress: { governed: false, rules: [] },
      egress: { governed: true, rules: [] },
    },
  ];

  /**
   * Lena's Services and Nodes scrolled sideways at 1024 in Russian and cut
   * their last column while Pods hid columns by priority. Fails if any list,
   * in one namespace and with a full row of actions, needs a sideways scroll
   * there, or hides its Name to avoid one.
   */
  it.each(PAGES)(
    "fits %s by hiding columns, never by scrolling",
    (_page, columns) => {
      const shown = columns.filter((c) => nameOf(c) !== "namespace");
      const specs = drawn(shown, ru, LENAS_ROWS).map((spec, index) => ({
        id: index < shown.length ? nameOf(shown[index]) : "actions",
        floor: spec.floor,
        yields: shown[index]?.meta?.yields,
      }));
      const hidden = yieldedColumns(specs, PORT_1024);
      const kept = specs.filter((spec) => !hidden.includes(spec.id));
      expect(
        kept.reduce((sum, spec) => sum + spec.floor, 0)
      ).toBeLessThanOrEqual(PORT_1024);
      expect(hidden).not.toContain("name");
    }
  );

  /**
   * Lena's Pods in all namespaces at 1024 in Russian scrolled sideways by
   * the width of the four buttons drawn only under the pointer. Fails if the
   * list, its buttons folded into one beside its laned scrollbar, still needs
   * a sideways scroll, or hides the name, the status or the restarts for it.
   */
  it("fits Pods in all namespaces at 1024 in Russian without a sideways scroll", () => {
    const rows = [
      {
        name: "named-port-demo-7954dcd89f-knkqs",
        namespace: "team-checkout",
        status: { display: "CreateContainerConfigError" },
        nodeName: "k3d-rubick-live-agent-0",
        restartCount: 830,
      },
    ];
    const shown = pods.filter((c) => nameOf(c) !== "namespace");
    const folded = { size: 1, meta: { floor: actionsColumnSize(1, 10) } };
    const specs = [...shown, folded].map((c, index) => ({
      id: index < shown.length ? nameOf(c) : "actions",
      floor: columnFloor(c, ru, rows),
      yields: (c as Column).meta?.yields,
    }));
    // The lane's 8px, then 20px less again: WebKit's glyphs run wider than
    // the widths these floors are estimated at here.
    for (const port of [PORT_1024 - 8, PORT_1024 - 28]) {
      const hidden = yieldedColumns(specs, port);
      const kept = specs.filter((spec) => !hidden.includes(spec.id));
      expect(
        kept.reduce((sum, spec) => sum + spec.floor, 0),
        `at ${port}`
      ).toBeLessThanOrEqual(port);
      expect(hidden).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^(name|status|restarts)$/),
        ])
      );
    }
  });

  /**
   * Lena read "15 (13 мин наза…" on Pods with room beside the column. Fails
   * if the Restarts floor stops holding the most restarts its rows count
   * with the widest age a restart is told in, in the reader's language.
   */
  it("holds a restart count and the age of the last one whole on Pods", () => {
    useLocaleStore.setState({ choice: "ru" });
    const restarts = (pods as Column[]).find((c) => nameOf(c) === "restarts")!;
    expect(columnFloor(restarts, ru, LENAS_ROWS)).toBeGreaterThanOrEqual(
      "15 (59 мин назад)".length * 7.2 + 20
    );
    useLocaleStore.setState({ choice: null });
  });

  /** Fails if the Pods status column keeps room for "CreateContainerConfigError" its rows never say, or stops holding the widest they do. */
  it("holds the Pods status column to the widest status its rows say", () => {
    const status = (pods as Column[]).find((c) => nameOf(c) === "status")!;
    const running = [{ status: { display: "Running" } }];
    const failing = [
      ...running,
      { status: { display: "CreateContainerConfigError" } },
    ];
    expect(columnFloor(status, en, running)).toBeLessThan(
      columnFloor(status, en, failing)
    );
    expect(columnFloor(status, en, failing)).toBeGreaterThanOrEqual(
      Math.ceil("CreateContainerConfigError".length * 6.6 + 14 + 20)
    );
  });

  /** Lena read "k3d-ru…ent-0" on Pods. Fails if the Node column can be drawn narrower than the node names its rows hold. */
  it("draws a k3d node name whole on Pods", () => {
    const shown = (pods as Column[]).filter((c) => nameOf(c) !== "namespace");
    const status = { display: "Running" };
    const rows = [
      {
        name: "cart-667846ff79-4f68h",
        nodeName: "k3d-rubick-live-agent-0",
        status,
      },
      { name: "never-placed-75dcb67599-w9npx", nodeName: null, status },
    ];
    const { px } = laidOut(shown, PORT_1024, ru, rows);
    expect(px[at(shown, "node")]).toBeGreaterThanOrEqual(
      "k3d-rubick-live-agent-0".length * 7.2 + 38
    );
  });

  /**
   * Every list gave its Name column 280px while its names were 10 to 20
   * glyphs. Fails if the Name floor keeps room its rows' names never use, or
   * stops holding the longest of them, or 31 glyphs of a longer one.
   */
  it("holds the Name column to the longest name its rows hold", () => {
    const name =
      (deployments() as Column[]).find((c) => c.accessorKey === "name") ?? {};
    const short = ["cart", "checkout", "payments", "recommendations"].map(
      (each) => ({ name: each })
    );
    expect(columnFloor(name, ru, short)).toBe(
      Math.ceil("recommendations".length * 7.2 + 2 * (14 + 4) + 20)
    );
    expect(columnFloor(name, ru, [{ name: "x".repeat(60) }, ...short])).toBe(
      NAME_CELL_PX
    );
  });
});

describe("the claims list beside a claim's cause", () => {
  const claim = (over: Partial<PersistentVolumeClaimInfo>) => ({
    uid: "",
    name: "data-orders-db-0",
    namespace: "shop",
    status: "Bound",
    volume: "pvc-88dc9f30-e660-4859-8adf-9e0d3cd274d8",
    capacity: "1Gi",
    accessModes: ["ReadWriteOnce"],
    storageClass: "local-path",
    labels: {},
    annotations: {},
    createdAt: "2026-10-13T12:00:00Z",
    ...over,
  });

  /**
   * Live at 1037px, Status took every pixel above the floors for
   * orphan-claim's cause and left Volume "pv-." and Storage class "local-...".
   * Fails if a volume or a class stops keeping a readable name beside it.
   */
  it("keeps the volume and the class readable while a cause widens Status", () => {
    const rows = [
      claim({}),
      claim({
        name: "orphan-claim",
        status: "Pending",
        volume: null,
        capacity: null,
        storageClass: "fast-ssd-missing",
      }),
    ];
    const columns = [...persistentVolumeClaims([]), ACTIONS] as Column[];
    const layout = tableLayout(
      columns.map((c) => ({
        size: c.size ?? 150,
        floor: columnFloor(c, en, rows),
        ideal: columnIdeal(c, en, rows),
      })),
      1037
    );
    const px = layout.shares.map((share) => (share / 100) * layout.span);
    const at = (id: string) => px[columns.findIndex((c) => nameOf(c) === id)];
    expect(at("volume")).toBeGreaterThanOrEqual(12 * 7.2 + 38);
    expect(at("storageClass")).toBeGreaterThanOrEqual(16 * 7.2 + 38);
    expect(at("status")).toBeGreaterThan(statusCellPx(7));
  });
});

describe("the Ingresses list beside a cause", () => {
  const ingress = (
    name: string,
    host: string,
    loadBalancerIps: string[] = []
  ) =>
    ({
      name,
      namespace: "k8s-gui-test",
      className: "traefik",
      rules: [{ host, paths: [] }],
      loadBalancerIps,
    }) as unknown as IngressInfo;

  /**
   * Live at 1040px, Status took every pixel above the floors for "No
   * IngressClass named nginx in this cluster" and left Hosts "checko" and
   * TLS "no TL"; given floors for those, it then cut its own badge to "no
   * controll". Fails if a host, the class or the badge stop fitting beside
   * the widest cause in one namespace, or TLS is drawn cut rather than hidden.
   */
  it("keeps a host, the TLS words and the badge whole while a cause widens Status", () => {
    const rows = [
      ingress("checkout", "checkout.k8s-gui.test", ["34.1.2.3"]),
      ingress("promo-nginx", "promo.nginx.k8s-gui.test"),
    ];
    // The page adds the cause to the column's ideal; the widest it allows.
    const columns = [
      ...(ingresses as Column[])
        .filter((column) => nameOf(column) !== "namespace")
        .map((column) =>
          nameOf(column) === "health"
            ? { ...column, meta: { ...column.meta, ideal: () => 185 + 366 } }
            : column
        ),
      ACTIONS,
    ] as Column[];
    const widths = (port: number) => {
      const ids = columns.map((c, index) =>
        index < columns.length - 1 ? nameOf(c) : "actions"
      );
      const specs = columns.map((c, index) => ({
        id: ids[index],
        size: c.size ?? 150,
        floor: columnFloor(c, en, rows),
        ideal: columnIdeal(c, en, rows),
        yields: c.meta?.yields,
      }));
      const hidden = yieldedColumns(specs, port);
      const kept = specs.filter((spec) => !hidden.includes(spec.id));
      const layout = tableLayout(kept, port);
      expect(layout.scrolls).toBe(false);
      return (id: string) => {
        const at = kept.findIndex((spec) => spec.id === id);
        return at < 0 ? null : (layout.shares[at] / 100) * layout.span;
      };
    };
    const badge = "backend not checked".length * 6.6 + 34;
    for (const port of [1040, 1200]) {
      const at = widths(port);
      expect(at("hosts"), `${port}`).toBeGreaterThanOrEqual(20 * 7.2 + 20);
      expect(at("className"), `${port}`).toBeGreaterThanOrEqual(
        "traefik".length * 7 + 20
      );
      expect(at("health"), `${port}`).toBeGreaterThanOrEqual(badge);
    }
    // At 1040 the TLS column is the first to give way, whole or not at all.
    expect(widths(1200)("tlsHosts")).toBeGreaterThanOrEqual(
      "TLS not checked".length * 7 + 20
    );
    expect(widths(1040)("tlsHosts")).toBeNull();
  });

  /**
   * Live at 1280, Address held an IPv4's 144px over "none" on every row and
   * Hosts, with no ideal, stayed at its floor: "legacy.nginx.k8s-gui.t".
   * Fails if a scope with no addresses reserves one, or Hosts stops rising.
   */
  it("gives the hosts the room an address nobody has would have held", () => {
    const rows = [
      ingress("checkout", "checkout.k8s-gui.test"),
      ingress("promo-nginx", "promo.nginx.k8s-gui.test"),
    ];
    const kept = (ingresses as Column[])
      .filter((column) => nameOf(column) !== "namespace")
      .map((column) =>
        nameOf(column) === "health"
          ? { ...column, meta: { ...column.meta, ideal: () => 185 + 366 } }
          : column
      );
    const specs = kept.map((c) => ({
      id: nameOf(c),
      size: c.size ?? 150,
      floor: columnFloor(c, en, rows),
      ideal: columnIdeal(c, en, rows),
    }));
    const layout = tableLayout(specs, 1200);
    const at = (id: string) =>
      (layout.shares[specs.findIndex((spec) => spec.id === id)] / 100) *
      layout.span;
    expect(at("loadBalancerIps")).toBeLessThan(IPV4_CELL_PX);
    expect(at("hosts")).toBeGreaterThanOrEqual(
      "promo.nginx.k8s-gui.test".length * 7.2 + 20
    );
  });
});

describe("the NetworkPolicies list beside the peek", () => {
  const direction = (governed: boolean): PolicyDirection => ({
    governed,
    rules: [],
    opensToEverything: false,
    deniesEverything: governed,
  });
  const row = (
    name: string,
    selected: number | null,
    over: Partial<NetworkPolicyInfo> = {}
  ): NetworkPolicyInfo => ({
    uid: "",
    name,
    namespace: "k8s-gui-test",
    selects: { kind: "written", query: "app.kubernetes.io/name=traefik" },
    selected,
    nearly: null,
    ingress: direction(true),
    egress: direction(false),
    labels: {},
    createdAt: null,
    ...over,
  });
  const rows = [
    row("default-deny-ingress", 27, { selects: { kind: "everything" } }),
    row("selects-nothing", 0),
    row("traefik-out", null, { ingress: direction(false) }),
  ];

  /**
   * Beside the peek every column but the name read "1 ...", "no ..." and
   * "not r...": only their headers held them open. Fails if Pods, Ingress or
   * Egress is hidden or drawn narrower than what its rows say there, in
   * either language, or the list scrolls rather than give up its Age and its
   * selector, which the peek draws for the row it shows.
   */
  it.each([
    ["English", en],
    ["Russian", ru],
  ] as const)(
    "keeps what a row says of its pods and directions whole in %s",
    (_language, t) => {
      const shown = (networkPolicyColumns as Column[]).filter(
        (c) => nameOf(c) !== "namespace"
      );
      const folded = { size: 1, meta: { floor: actionsColumnSize(1, 10) } };
      const specs = [...shown, folded].map((c, index) => ({
        id: index < shown.length ? nameOf(c) : "actions",
        size: c.size ?? 150,
        floor: columnFloor(c, t, rows),
        yields: (c as Column).meta?.yields,
      }));
      const hidden = yieldedColumns(specs, 640);
      const kept = specs.filter((spec) => !hidden.includes(spec.id));
      const layout = tableLayout(kept, 640);
      expect(layout.scrolls).toBe(false);
      const said: [string, string[]][] = [
        ["behind", rows.map((r) => reachWords(r.selected, t).text)],
        ["ingress", rows.map((r) => directionCellWords(r.ingress, t))],
        ["egress", rows.map((r) => directionCellWords(r.egress, t))],
      ];
      for (const [id, words] of said) {
        const at = kept.findIndex((spec) => spec.id === id);
        expect(at, id).toBeGreaterThanOrEqual(0);
        expect(
          (layout.shares[at] / 100) * layout.span,
          id
        ).toBeGreaterThanOrEqual(
          Math.max(...words.map((word) => word.length * 7)) + 10
        );
      }
    }
  );
});
