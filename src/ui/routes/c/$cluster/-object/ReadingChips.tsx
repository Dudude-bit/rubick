import {
  AlertTriangle,
  Ban,
  ChevronRight,
  Clock,
  Filter,
  ListChecks,
  Loader2,
  MinusCircle,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";

import type { KindReading, NotRead, Reading } from "@/generated/types";
import { KindIcon } from "@/components/object/KindIcon";
import { useT } from "@/i18n/useT";
import { cn, formatWhen } from "@/lib/utils";
import { listing } from "./ownership";

type Says = Reading["says"];

/** Every reading, drawn. A new one fails the compiler, never paints grey. */
const LOOK: Record<
  Says,
  {
    icon: LucideIcon;
    tone: string;
    spin?: boolean;
    key:
      | "syncing"
      | "stale"
      | "refused"
      | "partial"
      | "readFailed"
      | "unlistable"
      | "skipped";
  }
> = {
  syncing: { icon: Loader2, tone: "text-info", spin: true, key: "syncing" },
  stale: { icon: Clock, tone: "text-warn", key: "stale" },
  refused: { icon: ShieldOff, tone: "text-err", key: "refused" },
  partial: { icon: Filter, tone: "text-warn", key: "partial" },
  failed: { icon: AlertTriangle, tone: "text-err", key: "readFailed" },
  unlistable: { icon: Ban, tone: "text-fg-fnt", key: "unlistable" },
  skipped: { icon: MinusCircle, tone: "text-fg-fnt", key: "skipped" },
};

function why(reading: Reading, t: ReturnType<typeof useT>): string {
  let values: Record<string, string> | undefined;
  if (reading.says === "partial")
    values = { namespaces: reading.namespaces.join(", ") };
  if (reading.says === "stale")
    values = { since: formatWhen(reading.since, "clock") };
  return t("owns", LOOK[reading.says].key, values);
}

/**
 * The kinds the ownership index could not vouch for, one chip each: the
 * kind's glyph, its name, and why, in the colour of how much it matters.
 * Two kinds of one name (core and `events.k8s.io` Events) carry their group.
 */
export function ReadingChips({
  kinds,
  groups,
}: {
  kinds: readonly KindReading[];
  groups?: NotRead["groups"];
}) {
  const t = useT();
  const named = new Map<string, number>();
  for (const reading of kinds)
    named.set(reading.kind, (named.get(reading.kind) ?? 0) + 1);

  return (
    <ul className="flex flex-wrap gap-1.5">
      {kinds.map((reading) => {
        const look = LOOK[reading.reading.says];
        const Icon = look.icon;
        return (
          <li
            key={`${reading.group}/${reading.plural}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-hair bg-canvas px-2 py-1 text-[11px]"
          >
            <KindIcon kind={reading.kind} className="h-3 w-3" />
            <span className="font-mono text-fg">
              {reading.kind}
              {(named.get(reading.kind) ?? 0) > 1 && reading.group && (
                <span className="text-fg-fnt">.{reading.group}</span>
              )}
            </span>
            <span className={cn("inline-flex items-center gap-1", look.tone)}>
              <Icon
                className={cn("h-3 w-3", look.spin && "animate-spin")}
                aria-hidden="true"
              />
              {why(reading.reading, t)}
            </span>
          </li>
        );
      })}
      {groups?.map((group) => (
        <li
          key={`group/${group.group}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-hair bg-canvas px-2 py-1 text-[11px]"
        >
          <span className="font-mono text-fg">{group.group}</span>
          <span className="inline-flex items-center gap-1 text-err">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {t("owns", "groupUnread")}
          </span>
        </li>
      ))}
    </ul>
  );
}

const unwatched = ({ reading }: KindReading) =>
  reading.says === "unlistable" || reading.says === "skipped";

function totalsOf(notRead: NotRead) {
  const total = Math.max(notRead.watched, listing(notRead));
  return { total, served: total + notRead.kinds.filter(unwatched).length };
}

/** Once settled, how many of the watched kinds were read where they count. */
export function ReadTotals({
  notRead,
  unread,
}: {
  notRead: NotRead;
  unread: number;
}) {
  const t = useT();
  const { total, served } = totalsOf(notRead);
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 text-fg-mut"
      data-testid="read-totals"
    >
      <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="tabular-nums">
        {t("count", "kindsReadSettled", {
          n: Math.max(0, total - unread),
          total,
        })}
      </span>
      {served > total && (
        <span className="basis-full pl-5 tabular-nums text-fg-fnt">
          {t("count", "kindsServedLeftOut", { n: served })}
        </span>
      )}
    </p>
  );
}

/**
 * While the index is still listing: one line with how far it got, folded
 * over the per-kind chips, so a dialog does not open as a wall of spinners.
 */
export function ReadingProgress({ notRead }: { notRead: NotRead }) {
  const t = useT();
  const { total, served } = totalsOf(notRead);
  return (
    <details className="group text-xs">
      <summary className="inline-flex cursor-pointer select-none flex-wrap items-center gap-x-1.5 rounded-md px-1 py-0.5 text-info hover:bg-hover">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        <span className="tabular-nums">
          {t("count", "kindsReadOf", {
            n: total - listing(notRead),
            total,
          })}
        </span>
        <ChevronRight
          className="h-3 w-3 text-fg-mut transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        {served > total && (
          <span className="basis-full pl-5 tabular-nums text-fg-mut">
            {t("count", "kindsServedLeftOut", { n: served })}
          </span>
        )}
      </summary>
      <div className="mt-2 pl-1">
        <ReadingChips kinds={notRead.kinds} groups={notRead.groups} />
      </div>
    </details>
  );
}
