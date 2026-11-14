/** A flow's end and a number in its row, as the table and the block draw them. */
import { ResourceName } from "@/components/object/ResourceName";
import type { FlowEnd } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { drawnCrd } from "@/lib/links";
import type { Cell, FlowRow } from "@/lib/traffic";
import { cn } from "@/lib/utils";
import {
  cellText,
  cellTitle,
  endLabel,
  endSub,
  type CellKind,
} from "./traffic-words";

const SERVICE = drawnCrd({ kind: "Service", group: "" });

export function End({ end }: { end: FlowEnd }) {
  const t = useT();
  if (end.is === "workload")
    return (
      <ResourceName
        kind={end.key.kind}
        crd={drawnCrd(end.key)}
        group={end.key.group}
        namespace={end.key.namespace}
        name={end.key.name}
      />
    );
  if (end.is === "service")
    return (
      <ResourceName
        kind="Service"
        crd={SERVICE}
        namespace={end.namespace}
        name={end.name}
      />
    );
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-mono text-[12px]">{endLabel(end)}</span>
      <span className="truncate text-[11px] text-fg-fnt">{endSub(end, t)}</span>
    </span>
  );
}

export function Figure({
  cell,
  kind,
  row,
}: {
  cell: Cell;
  kind: CellKind;
  row: FlowRow;
}) {
  const t = useT();
  return (
    <span
      title={cellTitle(cell, row, t)}
      className={cn(
        "font-mono tabular-nums",
        cell.value === null && "text-fg-fnt",
        cell.state === "notRead" && "text-warn"
      )}
    >
      {cellText(cell, kind, t)}
    </span>
  );
}
