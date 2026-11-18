/** A flow's end and a number in its row, as the table and the block draw them. */
import {
  RESOURCE_NAME_SHELL,
  ResourceName,
} from "@/components/object/ResourceName";
import type { FlowEnd } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { drawnCrd } from "@/lib/links";
import { shareTone, type Cell, type FlowRow } from "@/lib/traffic";
import { cn } from "@/lib/utils";
import { TONE_TEXT } from "../-map/tone-classes";
import {
  cellText,
  cellTitle,
  endLabel,
  endSub,
  type CellKind,
} from "./traffic-words";

const SERVICE = drawnCrd({ kind: "Service", group: "" });

/**
 * An end on one line: its kind's glyph and its name, the namespace never
 * cut and the name cut in the middle, whole in its title. A Service says
 * so in words, its glyph being all that tells it from a workload otherwise.
 */
export function End({ end }: { end: FlowEnd }) {
  const t = useT();
  if (end.is === "workload")
    return (
      <span className={RESOURCE_NAME_SHELL}>
        <ResourceName
          kind={end.key.kind}
          crd={drawnCrd(end.key)}
          group={end.key.group}
          namespace={end.key.namespace}
          name={end.key.name}
          showKind={false}
        />
      </span>
    );
  if (end.is === "service")
    return (
      <span className={RESOURCE_NAME_SHELL}>
        <ResourceName
          kind="Service"
          crd={SERVICE}
          namespace={end.namespace}
          name={end.name}
          showKind={false}
        />
        <span className="flex-none text-[11px] text-fg-fnt">Service</span>
      </span>
    );
  const label = endLabel(end);
  const sub = endSub(end, t);
  return (
    <span
      className="flex min-w-0 items-baseline gap-1.5"
      title={`${label} (${sub})`}
    >
      <span className="min-w-0 truncate font-mono text-[12px]">{label}</span>
      <span className="min-w-0 truncate text-[11px] text-fg-fnt">{sub}</span>
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
        cell.state === "notRead" && "text-warn",
        kind === "share" && cell.value !== null && TONE_TEXT[shareTone(cell)]
      )}
    >
      {cellText(cell, kind, t)}
    </span>
  );
}
