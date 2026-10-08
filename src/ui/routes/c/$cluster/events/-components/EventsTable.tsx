import { createContext, useContext, useMemo, useState } from "react";
import { ArrowUpToLine } from "lucide-react";

import { DataTable } from "@/components/ui/data-table";
import type { ColumnDef } from "@/components/ui/table-features";
import { None } from "@/components/ui/none";
import { RealtimeAge } from "@/components/ui/realtime";
import { ResourceMessage } from "@/components/object/ResourceMessage";
import { ResourceRef } from "@/components/object/ResourceRef";
import type { EventInfo } from "@/generated/types";
import { columnHeader } from "@/i18n/column-header";
import { eventReasonMark } from "@/lib/event-reason";
import { cn, formatDate } from "@/lib/utils";
import { useT } from "@/i18n/useT";
import { hrefOf, objectLink } from "@/lib/links";
import type { PeekTarget } from "@/hooks/usePeek";
import { eventLanding } from "../../-object/attachment";
import { useRowMenu } from "../../-list/useRowMenu";
import { useHeldRows } from "./held-rows";
import { AGE_CELL_PX, AGE_LABEL, ageOrder } from "../../-list/columns";
import { AgeHeader } from "@/components/ui/sortable-header";

const subjectOf = (event: EventInfo) => ({
  kind: event.involvedObject.kind,
  name: event.involvedObject.name,
  namespace: event.involvedObject.namespace ?? event.namespace,
});

function ReasonCell({ row }: { row: { original: EventInfo } }) {
  const event = row.original;
  const isWarning = event.type === "Warning";
  const { family, Icon, color } = eventReasonMark(event.reason ?? null);
  const familyStyle = isWarning || !color ? undefined : { color };
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-baseline gap-1.5 font-mono font-medium",
        isWarning ? "text-warn" : familyStyle ? undefined : "text-fg-mut"
      )}
      style={familyStyle}
      title={event.reason ?? undefined}
    >
      <span
        className={cn(
          "w-2.5 flex-none text-center text-[9px]",
          isWarning ? "text-warn" : "text-fg-fnt"
        )}
        aria-hidden="true"
      >
        {isWarning ? "▲" : "●"}
      </span>
      <span className="sr-only">
        {event.type}
        {family ? `, ${family}` : ""}:{" "}
      </span>
      <Icon className="h-2.5 w-2.5 flex-none self-center" aria-hidden="true" />
      <span className="truncate">{event.reason ?? <None />}</span>
    </span>
  );
}

const landingOf = (event: EventInfo) =>
  eventLanding(event.involvedObject.kind, event);

function ObjectCell({ row }: { row: { original: EventInfo } }) {
  const subject = subjectOf(row.original);
  return (
    <ResourceRef
      kind={subject.kind}
      name={subject.name}
      namespace={subject.namespace}
      linkOptions={landingOf(row.original)}
    />
  );
}

function NamespaceCell({ row }: { row: { original: EventInfo } }) {
  return (
    <span className="font-mono text-fg-mut">{row.original.namespace}</span>
  );
}

function MessageCell({ row }: { row: { original: EventInfo } }) {
  const event = row.original;
  return (
    <span className="text-fg-fnt" title={event.message ?? undefined}>
      {event.message ? (
        <ResourceMessage message={event.message} subject={subjectOf(event)} />
      ) : (
        <None />
      )}
    </span>
  );
}

function CountCell({ row }: { row: { original: EventInfo } }) {
  const count = row.original.count ?? 0;
  return (
    <span className="font-mono text-[11px] text-fg-fnt">
      {count > 1 ? `×${count}` : ""}
    </span>
  );
}

function AgeCell({ row }: { row: { original: EventInfo } }) {
  const at = row.original.lastTimestamp;
  return (
    <span className="text-fg-fnt" title={formatDate(at) ?? undefined}>
      {at ? <RealtimeAge timestamp={at} /> : <None />}
    </span>
  );
}

const REASON: ColumnDef<EventInfo> = {
  id: "reason",
  size: 210,
  accessorFn: (event) => event.reason ?? "",
  enableSorting: false,
  header: columnHeader("columns", "reason"),
  cell: ReasonCell,
};
const OBJECT: ColumnDef<EventInfo> = {
  id: "object",
  size: 300,
  accessorFn: (event) =>
    `${event.involvedObject.kind}/${event.involvedObject.name}`,
  enableSorting: false,
  header: columnHeader("columns", "object"),
  cell: ObjectCell,
};
const NAMESPACE: ColumnDef<EventInfo> = {
  id: "namespace",
  size: 140,
  accessorKey: "namespace",
  enableSorting: false,
  header: columnHeader("columns", "namespace"),
  cell: NamespaceCell,
};
const MESSAGE: ColumnDef<EventInfo> = {
  id: "message",
  size: 560,
  accessorFn: (event) => event.message ?? "",
  enableSorting: false,
  header: columnHeader("columns", "message"),
  cell: MessageCell,
};
const COUNT: ColumnDef<EventInfo> = {
  id: "count",
  size: 70,
  accessorFn: (event) => event.count ?? 0,
  enableSorting: false,
  enableGlobalFilter: false,
  header: columnHeader("columns", "eventCount"),
  cell: CountCell,
};
const AGE: ColumnDef<EventInfo> = {
  id: "age",
  size: 80,
  accessorFn: (event) => ageOrder(event.lastTimestamp),
  sortUndefined: "last",
  sortDescFirst: false,
  enableGlobalFilter: false,
  meta: { floor: AGE_CELL_PX, label: AGE_LABEL },
  header: AgeHeader,
  cell: AgeCell,
};

const EVERY_NAMESPACE = [REASON, OBJECT, NAMESPACE, MESSAGE, COUNT, AGE];
const ONE_NAMESPACE = [REASON, OBJECT, MESSAGE, COUNT, AGE];

const uidOf = (event: EventInfo) => event.uid;

/** The object's Events tab where its page has one, the Event's own page otherwise. */
function hrefOfEvent(event: EventInfo): string {
  const landing = landingOf(event);
  const link = landing
    ? objectLink(subjectOf(event), landing)
    : objectLink({
        kind: "Event",
        name: event.name,
        namespace: event.namespace,
      });
  return link ? hrefOf(link) : "";
}

const peekOfEvent = (event: EventInfo): PeekTarget => ({
  ...subjectOf(event),
  via: landingOf(event)?.via,
});

const Waiting = createContext<{ n: number; show: () => void }>({
  n: 0,
  show: () => {},
});

/** Reads the count through context, so a batch held back redraws this button and not the table. */
function ShowWaiting() {
  const t = useT();
  const { n, show } = useContext(Waiting);
  if (n === 0) return null;
  return (
    <button
      type="button"
      onClick={show}
      title={t("hints", "eventsHeld")}
      className="inline-flex h-6 items-center gap-1.5 rounded px-1.5 text-[11px] text-info transition-colors hover:bg-hover"
    >
      <ArrowUpToLine className="h-3 w-3" aria-hidden="true" />
      {t("count", "eventsWaiting", { n })}
    </button>
  );
}

const SHOW_WAITING = <ShowWaiting />;
const NO_QUICK_ACTIONS: never[] = [];

/**
 * The All events view: a table that draws only the rows on screen, and holds
 * still while the pointer is on it so a click lands on the row it aimed at.
 */
export function EventsTable({
  events,
  showNamespace,
  emptyMessage,
  question,
}: {
  events: EventInfo[];
  showNamespace: boolean;
  emptyMessage: string;
  /** What the rows answer; a new one is drawn at once, held or not. */
  question: string;
}) {
  const [pointed, setPointed] = useState(false);
  const { shown, waiting, show } = useHeldRows(events, pointed, question);
  const rowMenu = useRowMenu<EventInfo>({
    kind: "Event",
    getRowHref: hrefOfEvent,
    getRowPeek: peekOfEvent,
  });
  const waitingValue = useMemo(() => ({ n: waiting, show }), [waiting, show]);
  const table = useMemo(
    () => (
      <DataTable
        columns={showNamespace ? EVERY_NAMESPACE : ONE_NAMESPACE}
        data={shown}
        fill
        getRowId={uidOf}
        getRowHref={hrefOfEvent}
        getRowPeek={peekOfEvent}
        onRowMenu={rowMenu.open}
        pageKeys
        rowLabel="events"
        widthsKey="events-feed"
        emptyMessage={emptyMessage}
        toolbar={SHOW_WAITING}
      />
    ),
    [showNamespace, shown, emptyMessage, rowMenu.open]
  );
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onPointerEnter={() => setPointed(true)}
      onPointerLeave={() => setPointed(false)}
    >
      <Waiting.Provider value={waitingValue}>{table}</Waiting.Provider>
      {rowMenu.element(NO_QUICK_ACTIONS)}
    </div>
  );
}
