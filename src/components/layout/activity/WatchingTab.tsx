import { useSyncExternalStore } from "react";
import { Bell, Square, X } from "lucide-react";

import { agoOf } from "@/lib/usage-history";
import { cn } from "@/lib/utils";
import { isOpen, type Ask, type Watch } from "@/lib/tell-me-when";
import { SAYS_KEY } from "@/hooks/useTellMeWhen";
import { useClusterStore } from "@/stores/clusterStore";
import { useTellMeWhenStore } from "@/stores/tellMeWhenStore";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";
import { ACTIVITY_ROW, ActivityAction, ActivityEmpty } from "./primitives";

const ASK_SHORT: Record<Ask, keyof typeof en.tell> = {
  rollout: "askRolloutShort",
  podReady: "askPodShort",
  jobOutcome: "askJobShort",
  drain: "askDrainShort",
  renewed: "askRenewedShort",
  forwardAlive: "askForwardShort",
};

/**
 * Every question asked of this cluster, open or answered. An answered row
 * stays until dismissed: the notification that carried it is gone the
 * moment it was read, and this is where it can be read again.
 */
export function WatchingTab() {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext);
  const watches = useTellMeWhenStore((s) => s.watches);
  const remove = useTellMeWhenStore((s) => s.remove);
  const now = useNow();

  const rows = watches
    .filter((w) => w.context === context)
    .sort((a, b) => b.startedAt - a.startedAt);

  if (rows.length === 0) {
    return (
      <ActivityEmpty
        icon={Bell}
        title={t("tell", "empty")}
        hint={t("tell", "emptyHint")}
      />
    );
  }

  return (
    <div>
      {rows.map((w) => (
        <Row key={w.id} watch={w} now={now} onRemove={() => remove(w.id)} />
      ))}
    </div>
  );
}

const TICK_MS = 30_000;
const tickers = new Set<() => void>();
let ticking: ReturnType<typeof setInterval> | null = null;

function subscribeTick(onTick: () => void): () => void {
  tickers.add(onTick);
  ticking ??= setInterval(() => tickers.forEach((tick) => tick()), TICK_MS);
  return () => {
    tickers.delete(onTick);
    if (tickers.size === 0 && ticking !== null) {
      clearInterval(ticking);
      ticking = null;
    }
  };
}

/** The wall clock to the half minute, so the "ago" lines move on their own. */
function useNow(): number {
  return useSyncExternalStore(
    subscribeTick,
    () => Math.floor(Date.now() / TICK_MS) * TICK_MS
  );
}

function Row({
  watch,
  now,
  onRemove,
}: {
  watch: Watch;
  now: number;
  onRemove: () => void;
}) {
  const t = useT();
  const status = watch.status;
  const tone =
    status.state === "watching"
      ? "bg-ok"
      : status.state === "lost"
        ? "bg-warn"
        : status.state === "done" &&
            (status.verdict.says === "rolledOut" ||
              status.verdict.says === "ready" ||
              status.verdict.says === "succeeded" ||
              status.verdict.says === "drained" ||
              status.verdict.says === "renewed")
          ? "bg-ok"
          : status.state === "done"
            ? "bg-err"
            : "bg-fg-fnt";

  const line = (() => {
    switch (status.state) {
      case "watching":
        return t("tell", "watchingSince", {
          ago: agoOf(watch.startedAt, now),
        });
      case "lost":
        return t("tell", "lostSince", { ago: agoOf(status.since, now) });
      case "done":
        return `${t("tell", SAYS_KEY[status.verdict.says], { name: watch.name })} · ${agoOf(status.at, now)}`;
      case "expired":
        return t("tell", "expired");
    }
  })();

  return (
    <div className={ACTIVITY_ROW}>
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 flex-none rounded-full", tone)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          <span className="text-fg-fnt">{watch.kind} </span>
          {watch.namespace && (
            <span className="text-fg-fnt">{watch.namespace}/</span>
          )}
          {watch.name}
          <span className="text-fg-fnt">
            {" "}
            · {t("tell", ASK_SHORT[watch.ask])}
          </span>
        </span>
        <span
          className={cn(
            "block truncate font-mono text-[11px]",
            status.state === "done" && status.verdict.detail
              ? "text-fg-mut"
              : "text-fg-fnt"
          )}
          title={
            status.state === "done"
              ? (status.verdict.detail ?? undefined)
              : undefined
          }
        >
          {line}
          {status.state === "done" && status.verdict.detail
            ? ` · ${status.verdict.detail}`
            : ""}
        </span>
      </span>
      <ActivityAction
        aria-label={
          isOpen(watch) ? t("tell", "stopAsking") : t("tell", "dismiss")
        }
        onClick={onRemove}
      >
        {isOpen(watch) ? (
          <Square className="h-3.5 w-3.5" />
        ) : (
          <X className="h-3.5 w-3.5" />
        )}
      </ActivityAction>
    </div>
  );
}
