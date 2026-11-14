/**
 * The three breakdowns: by namespace, by workload, by node. Each row is a
 * view of the one picture, with its share and its currency on it, so the
 * column renderers are built once and the file Share writes reads the
 * same words as the cells.
 */
import { useMemo } from "react";

import { DataTable } from "@/components/ui/data-table";
import type { ColumnDef } from "@/components/ui/table-features";
import { Section, SectionHeader } from "@/components/ui/section";
import { ResourceName } from "@/components/object/ResourceName";
import type { T } from "@/i18n/useT";
import { useT } from "@/i18n/useT";
import {
  currencyOf,
  formatMoney,
  formatShare,
  monthOf,
  type CostPicture,
  type NamespaceCost,
  type NodeCost,
  type Parts,
  type WorkloadCost,
} from "@/lib/cost";
import {
  EFFICIENCY_WINDOW,
  overRequested,
  workloadEfficiency,
  type UsageReading,
  type WorkloadEfficiency,
} from "@/lib/efficiency";
import { formatQuantity } from "@/lib/metric-format";
import { crdInGroup, drawnCrd, hrefOf, objectLink } from "@/lib/links";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import type { WorkloadKey } from "@/generated/types";
import { efficiencyWords } from "./cost-words";
import { cn } from "@/lib/utils";

interface Priced {
  perHour: number | null;
  share: number | null;
  currency: string;
}

type NamespaceRow = NamespaceCost & Priced;
type WorkloadRow = WorkloadCost &
  Priced & {
    id: string;
    /** The CRD its group serves the kind as; none for a built-in's own group. */
    crd: string | null | undefined;
    efficiency: WorkloadEfficiency;
    used: Used;
  };
type NodeRow = NodeCost & { currency: string };

interface Used {
  cpu: { avg: number | null; peak: number | null } | null;
  memory: { avg: number | null; peak: number | null } | null;
}

function money(
  value: number | null | undefined,
  currency: string,
  t: T
): string {
  return value === null || value === undefined
    ? t("cost", "notPriced")
    : formatMoney(value, currency);
}

function share(value: number | null, t: T): string {
  return value === null ? t("cost", "notPriced") : formatShare(value);
}

function Money({
  value,
  currency,
}: {
  value: number | null | undefined;
  currency: string;
}) {
  const t = useT();
  return value === null || value === undefined ? (
    <span className="text-fg-fnt">{t("cost", "notPriced")}</span>
  ) : (
    <span className="font-mono tabular-nums">
      {formatMoney(value, currency)}
    </span>
  );
}

const part = (parts: Parts, key: keyof Parts) => parts[key] ?? null;

function namespaceColumns(t: T): ColumnDef<NamespaceRow>[] {
  const moneyColumn = (
    id: string,
    header: string,
    read: (row: NamespaceRow) => number | null
  ): ColumnDef<NamespaceRow> => ({
    id,
    header,
    accessorFn: (row) => read(row) ?? -1,
    cell: ({ row }) => (
      <Money value={read(row.original)} currency={row.original.currency} />
    ),
    meta: {
      share: (row: NamespaceRow, tt: T) => money(read(row), row.currency, tt),
    },
  });
  return [
    {
      id: "namespace",
      accessorKey: "namespace",
      header: t("columns", "namespace"),
      cell: ({ row }) => (
        <ResourceName
          kind="Namespace"
          crd={BUILT_IN}
          name={row.original.namespace}
        />
      ),
    },
    moneyColumn("perHour", t("cost", "perHour"), (row) => row.perHour),
    moneyColumn("perMonth", t("cost", "perMonth"), (row) =>
      row.perHour === null ? null : monthOf(row.perHour)
    ),
    {
      id: "share",
      header: t("cost", "share"),
      accessorFn: (row) => row.share ?? -1,
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {share(row.original.share, t)}
        </span>
      ),
      meta: { share: (row: NamespaceRow, tt: T) => share(row.share, tt) },
    },
    moneyColumn("cpu", t("cost", "cpu"), (row) => part(row.parts, "cpu")),
    moneyColumn("memory", t("cost", "memory"), (row) =>
      part(row.parts, "memory")
    ),
    moneyColumn("gpu", t("cost", "gpu"), (row) => part(row.parts, "gpu")),
    moneyColumn("storage", t("cost", "storage"), (row) =>
      part(row.parts, "storage")
    ),
    moneyColumn("loadBalancer", t("cost", "loadBalancers"), (row) =>
      part(row.parts, "loadBalancer")
    ),
  ];
}

function EfficiencyCell({ efficiency }: { efficiency: WorkloadEfficiency }) {
  const t = useT();
  return (
    <span className="flex flex-col text-[11px] leading-tight">
      {(["cpu", "memory"] as const).map((resource) => {
        const e = efficiency[resource];
        return (
          <span
            key={resource}
            className={cn(
              e.state === "measured" ? "font-mono tabular-nums" : "text-fg-fnt",
              overRequested(e) && "text-warn"
            )}
            title={overRequested(e) ? t("cost", "overRequested") : undefined}
          >
            {t("cost", resource === "cpu" ? "cpu" : "memory")}{" "}
            {efficiencyWords(e, t)}
          </span>
        );
      })}
    </span>
  );
}

function usedWords(
  used: { avg: number | null; peak: number | null } | null,
  kind: "cpu" | "memory",
  t: T
): string {
  if (!used) return t("cost", "notMeasured");
  const say = (v: number | null) =>
    v === null ? t("cost", "notMeasured") : formatQuantity(v, kind);
  return t("cost", "usedAvgPeak", { avg: say(used.avg), peak: say(used.peak) });
}

function workloadColumns(t: T): ColumnDef<WorkloadRow>[] {
  return [
    {
      id: "workload",
      header: t("cost", "workload"),
      accessorFn: (row) => `${row.key.kind}/${row.key.name}`,
      cell: ({ row }) => (
        <ResourceName
          kind={row.original.key.kind}
          crd={row.original.crd}
          name={row.original.key.name}
          namespace={row.original.key.namespace}
        />
      ),
      meta: {
        share: (row: WorkloadRow) => `${row.key.kind} ${row.key.name}`,
      },
    },
    {
      id: "namespace",
      header: t("columns", "namespace"),
      accessorFn: (row) => row.key.namespace,
    },
    { id: "pods", header: t("columns", "pods"), accessorKey: "pods" },
    {
      id: "perHour",
      header: t("cost", "perHour"),
      accessorFn: (row) => row.perHour ?? -1,
      cell: ({ row }) => (
        <Money value={row.original.perHour} currency={row.original.currency} />
      ),
      meta: {
        share: (row: WorkloadRow, tt: T) =>
          money(row.perHour, row.currency, tt),
      },
    },
    {
      id: "share",
      header: t("cost", "share"),
      accessorFn: (row) => row.share ?? -1,
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {share(row.original.share, t)}
        </span>
      ),
      meta: { share: (row: WorkloadRow, tt: T) => share(row.share, tt) },
    },
    {
      id: "cpuRequested",
      header: t("cost", "cpuRequested"),
      accessorFn: (row) => row.requests.cpu,
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {formatQuantity(row.original.requests.cpu, "cpu")}
        </span>
      ),
      meta: {
        share: (row: WorkloadRow) => formatQuantity(row.requests.cpu, "cpu"),
      },
    },
    {
      id: "cpuUsed",
      header: t("cost", "cpuUsed", { window: EFFICIENCY_WINDOW }),
      accessorFn: (row) => row.used.cpu?.avg ?? -1,
      cell: ({ row }) => (
        <span className="text-[11px]">
          {usedWords(row.original.used.cpu, "cpu", t)}
        </span>
      ),
      meta: {
        share: (row: WorkloadRow, tt: T) => usedWords(row.used.cpu, "cpu", tt),
      },
    },
    {
      id: "memoryRequested",
      header: t("cost", "memoryRequested"),
      accessorFn: (row) => row.requests.memory,
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {formatQuantity(row.original.requests.memory, "memory")}
        </span>
      ),
      meta: {
        share: (row: WorkloadRow) =>
          formatQuantity(row.requests.memory, "memory"),
      },
    },
    {
      id: "memoryUsed",
      header: t("cost", "memoryUsed", { window: EFFICIENCY_WINDOW }),
      accessorFn: (row) => row.used.memory?.avg ?? -1,
      cell: ({ row }) => (
        <span className="text-[11px]">
          {usedWords(row.original.used.memory, "memory", t)}
        </span>
      ),
      meta: {
        share: (row: WorkloadRow, tt: T) =>
          usedWords(row.used.memory, "memory", tt),
      },
    },
    {
      id: "efficiency",
      header: t("cost", "efficiency"),
      accessorFn: (row) =>
        row.efficiency.cpu.state === "measured"
          ? (row.efficiency.cpu.ratio ?? -1)
          : -1,
      cell: ({ row }) => (
        <EfficiencyCell efficiency={row.original.efficiency} />
      ),
      meta: {
        share: (row: WorkloadRow, tt: T) =>
          `${tt("cost", "cpu")} ${efficiencyWords(row.efficiency.cpu, tt)}; ${tt(
            "cost",
            "memory"
          )} ${efficiencyWords(row.efficiency.memory, tt)}`,
      },
    },
  ];
}

function nodeColumns(t: T, estimate: boolean): ColumnDef<NodeRow>[] {
  const moneyColumn = (
    id: string,
    header: string,
    read: (row: NodeRow) => number | null
  ): ColumnDef<NodeRow> => ({
    id,
    header,
    accessorFn: (row) => read(row) ?? -1,
    cell: ({ row }) => (
      <Money value={read(row.original)} currency={row.original.currency} />
    ),
    meta: {
      share: (row: NodeRow, tt: T) => money(read(row), row.currency, tt),
    },
  });
  return [
    {
      id: "node",
      accessorKey: "name",
      header: t("columns", "node"),
      cell: ({ row }) => (
        <ResourceName kind="Node" crd={BUILT_IN} name={row.original.name} />
      ),
    },
    {
      id: "instanceType",
      header: t("cost", "instanceType"),
      accessorFn: (row) => row.instanceType ?? "",
    },
    {
      id: "spot",
      header: t("cost", "spot"),
      accessorFn: (row) =>
        row.spot === null
          ? ""
          : row.spot
            ? t("cost", "spotYes")
            : t("cost", "spotNo"),
    },
    moneyColumn("perHour", t("cost", "perHour"), (row) => row.perHour),
    moneyColumn("allocated", t("cost", "allocated"), (row) => row.allocated),
    moneyColumn("idle", t("cost", "idle"), (row) => row.idle),
    // Only an estimate knows it: OpenCost's idle already holds it.
    ...(estimate
      ? [moneyColumn("reserved", t("cost", "reserved"), (row) => row.reserved)]
      : []),
  ];
}

const usedOf = (
  reading: UsageReading,
  index: Map<string, number>,
  id: string
): Used => {
  if (reading.state !== "read") return { cpu: null, memory: null };
  const at = index.get(id);
  const values = at === undefined ? undefined : reading.fold.values[at];
  if (!values) return { cpu: null, memory: null };
  return {
    cpu: { avg: values[0] ?? null, peak: values[1] ?? null },
    memory: { avg: values[2] ?? null, peak: values[3] ?? null },
  };
};

const idOf = (key: WorkloadKey) =>
  `${key.namespace}/${key.group}/${key.kind}/${key.name}`;

/** Namespaces and nodes are the core group's own kinds. */
const BUILT_IN = drawnCrd({ kind: "Node", group: "" });

export function CostTables({
  picture,
  usage,
}: {
  picture: CostPicture;
  usage: UsageReading;
}) {
  const t = useT();
  const currency = currencyOf(picture);
  const estimate = picture.source.kind === "estimate";
  const { crdFor } = useCrdIndex();

  const rows = useMemo(() => {
    const whole = picture.total?.perHour ?? null;
    const shareOf = (perHour: number | null) =>
      perHour === null || whole === null || whole <= 0 ? null : perHour / whole;
    const index = new Map(
      usage.state === "read" ? usage.keys.map((key, i) => [idOf(key), i]) : []
    );
    return {
      namespaces: picture.namespaces.map((row): NamespaceRow => ({
        ...row,
        currency,
        share: shareOf(row.perHour),
      })),
      workloads: picture.workloads.map((row): WorkloadRow => ({
        ...row,
        id: idOf(row.key),
        crd: crdInGroup(row.key, crdFor),
        currency,
        share: shareOf(row.perHour),
        efficiency: workloadEfficiency(usage, row.key, row.requests),
        used: usedOf(usage, index, idOf(row.key)),
      })),
      nodes:
        picture.nodes &&
        picture.nodes.map((row): NodeRow => ({ ...row, currency })),
    };
  }, [picture, usage, currency, crdFor]);

  const byNamespace = useMemo(() => namespaceColumns(t), [t]);
  const byWorkload = useMemo(() => workloadColumns(t), [t]);
  const byNode = useMemo(() => nodeColumns(t, estimate), [t, estimate]);

  const rest = picture.rest;
  return (
    <>
      <Section>
        <SectionHeader title={t("cost", "byNamespace")} />
        <DataTable
          columns={byNamespace}
          data={rows.namespaces}
          getRowId={(row) => row.namespace}
          getRowHref={(row) =>
            hrefOf(objectLink({ kind: "Namespace", name: row.namespace })!)
          }
          share={{ title: t("cost", "byNamespace") }}
          partial={picture.unread.length > 0}
          emptyMessage={t("cost", "noRows")}
          widthsKey="cost-namespaces"
        />
      </Section>
      <Section>
        <SectionHeader
          title={t("cost", "byWorkload")}
          description={
            rest
              ? t("cost", "rest", {
                  kept: picture.workloads.length,
                  n: rest.workloads,
                  amount: money(rest.perHour, currency, t),
                })
              : undefined
          }
        />
        <DataTable
          columns={byWorkload}
          data={rows.workloads}
          getRowId={(row) => row.id}
          getRowHref={(row) => {
            const link = objectLink({ ...row.key, crd: row.crd });
            return link ? hrefOf(link) : "";
          }}
          share={{
            title: t("cost", "byWorkload"),
            partial: rest
              ? t("cost", "rest", {
                  kept: picture.workloads.length,
                  n: rest.workloads,
                  amount: money(rest.perHour, currency, t),
                })
              : null,
          }}
          partial={rest !== null || picture.unread.length > 0}
          enableVirtualScroll={rows.workloads.length > 100}
          virtualScrollHeight={480}
          emptyMessage={t("cost", "noRows")}
          widthsKey="cost-workloads"
        />
      </Section>
      {rows.nodes && (
        <Section>
          <SectionHeader title={t("cost", "byNode")} />
          <DataTable
            columns={byNode}
            data={rows.nodes}
            getRowId={(row) => row.name}
            getRowHref={(row) =>
              hrefOf(objectLink({ kind: "Node", name: row.name })!)
            }
            share={{ title: t("cost", "byNode") }}
            emptyMessage={t("cost", "noRows")}
            widthsKey="cost-nodes"
          />
        </Section>
      )}
    </>
  );
}
