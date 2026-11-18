/**
 * The three breakdowns: by namespace, by workload, by node. Each row is a
 * view of the one picture, with its share and its currency on it, so the
 * column renderers are built once and the file Share writes reads the
 * same words as the cells.
 */
import { replaceEqualDeep } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { DataTable } from "@/components/ui/data-table";
import { Section, SectionHeader } from "@/components/ui/section";
import { useT } from "@/i18n/useT";
import { currencyOf, shareOf, type CostPicture } from "@/lib/cost";
import { workloadEfficiency, type UsageReading } from "@/lib/efficiency";
import { crdInGroup, hrefOf, objectLink } from "@/lib/links";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import type { WorkloadKey } from "@/generated/types";
import { money } from "./cost-words";
import {
  namespaceColumns,
  nodeColumns,
  workloadColumns,
  type NamespaceRow,
  type NodeRow,
  type WorkloadRow,
} from "./cost-columns";

/**
 * `next`, keeping every part of the last value that reads the same: an
 * answer that moved nothing gives back what was there, and one that moved
 * a row gives back every other row as it was.
 */
function useKept<T>(next: T): T {
  const [kept, keep] = useState(next);
  const shared = replaceEqualDeep(kept, next);
  if (shared !== kept) keep(shared);
  return shared;
}

const idOf = (key: WorkloadKey) =>
  `${key.namespace}/${key.group}/${key.kind}/${key.name}`;

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

  // Each answer rebuilds the rows; a row that reads the same keeps its
  // object, so the tables redraw and re-measure only what moved, and an
  // answer that moved nothing hands them the arrays they already hold.
  const built = useMemo(() => {
    const of = (perHour: number | null) => shareOf(perHour, picture.total);
    return {
      namespaces: picture.namespaces.map((row): NamespaceRow => ({
        ...row,
        currency,
        share: of(row.perHour),
      })),
      workloads: picture.workloads.map((row): WorkloadRow => ({
        ...row,
        id: idOf(row.key),
        crd: crdInGroup(row.key, crdFor),
        currency,
        share: of(row.perHour),
        efficiency: workloadEfficiency(usage, row.key, row.requests),
      })),
      nodes:
        picture.nodes &&
        picture.nodes.map((row): NodeRow => ({ ...row, currency })),
    };
  }, [picture, usage, currency, crdFor]);
  const rows = useKept(built);

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
