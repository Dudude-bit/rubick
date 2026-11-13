import { CircleX, Hourglass, History, Lock } from "lucide-react";

import { useNow } from "@/hooks/useNow";
import { useT } from "@/i18n/useT";
import { cn, formatSince } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import {
  useWriteLog,
  type WriteOutcome,
  type WriteRecord,
} from "@/stores/writeLogStore";
import { ACTIVITY_ROW, ActivityAction, ActivityEmpty } from "./primitives";

const OUTCOME = {
  refused: { icon: Lock, tone: "text-err" },
  failed: { icon: CircleX, tone: "text-err" },
  unanswered: { icon: Hourglass, tone: "text-warn" },
} as const satisfies Record<WriteOutcome, unknown>;

/** The writes of this cluster that did not go through, in the words their dialog used. */
export function WritesTab() {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext);
  const records = useWriteLog((s) => s.records);
  const clear = useWriteLog((s) => s.clear);
  const now = useNow();
  const rows = records.filter((record) => record.context === context);

  if (rows.length === 0) {
    return (
      <ActivityEmpty
        icon={History}
        title={t("activity", "writesEmpty")}
        hint={t("activity", "writesEmptyHint")}
      />
    );
  }

  return (
    <div>
      <div className="flex justify-end border-b border-hair px-2 py-1">
        <ActivityAction onClick={() => clear(context)}>
          {t("activity", "clearWrites")}
        </ActivityAction>
      </div>
      {rows.map((record) => (
        <Row key={record.id} record={record} now={now} />
      ))}
    </div>
  );
}

function Row({ record, now }: { record: WriteRecord; now: number }) {
  const t = useT();
  const { icon: Icon, tone } = OUTCOME[record.outcome];
  const words =
    record.outcome === "unanswered"
      ? t("action", "writeUnansweredDetail", { said: record.said })
      : `${t("action", record.outcome === "refused" ? "writeRefusedLead" : "writeFailedLead")} ${record.said}`;
  return (
    <div
      className={cn(ACTIVITY_ROW, "items-start")}
      data-outcome={record.outcome}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 h-3.5 w-3.5 flex-none", tone)}
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words">{record.title}</span>
        <span className="block select-text break-words font-mono text-caption text-fg-mut">
          {words}
        </span>
        <span className="block text-caption text-fg-fnt">
          {t("action", "agoSuffix", { age: formatSince(record.at, now) })}
        </span>
      </span>
    </div>
  );
}
