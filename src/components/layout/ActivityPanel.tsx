import { useMemo } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Activity, Network, Terminal, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useBackgroundJobStore } from "@/stores/backgroundJobStore";
import {
  useActivityPanelStore,
  type ActivityTab,
} from "@/stores/activityPanelStore";
import { activityLabel } from "@/lib/activity-label";
import { useLocale } from "@/stores/localeStore";
import { PortForwardsTab } from "./activity/PortForwardsTab";
import { TerminalsTab } from "./activity/TerminalsTab";
import { BackgroundJobsTab } from "./activity/BackgroundJobsTab";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

type TabId = ActivityTab;

const TABS: Array<{
  id: TabId;
  label: keyof typeof en.activity;
  icon: typeof Network;
}> = [
  { id: "ports", label: "ports", icon: Network },
  { id: "terminals", label: "terminals", icon: Terminal },
  { id: "jobs", label: "jobs", icon: Loader2 },
];

export function ActivityPanel() {
  const t = useT();
  // Not local state: the command palette and the port-forward toast open this
  // panel by name, and a reader who cannot find a screen reaches for the
  // palette first.
  const open = useActivityPanelStore((state) => state.open);
  const tab = useActivityPanelStore((state) => state.tab);
  const setOpen = useActivityPanelStore((state) => state.setOpen);
  const setTab = useActivityPanelStore((state) => state.openOn);

  // IMPORTANT: every Zustand selector here returns a *raw* slice
  // (`state.sessions`, `state.jobs`) so its result is reference-stable
  // across renders. Filtering happens in useMemo below. Returning a
  // freshly-built array from inside the selector — e.g. `state.jobs
  // .filter(...)` — fails Zustand 5's `useSyncExternalStore` snapshot
  // contract: each render produces a new array reference, React thinks
  // state changed, re-renders, calls the selector again → infinite
  // loop with React error #185 ("Maximum update depth exceeded").
  const portForwardSessions = usePortForwardStore((state) => state.sessions);
  const terminalSessions = useTerminalSessionStore((state) => state.sessions);
  const jobs = useBackgroundJobStore((state) => state.jobs);

  const activeJobs = useMemo(
    () =>
      jobs.filter(
        (job) => job.status === "pending" || job.status === "running"
      ),
    [jobs]
  );

  const activeTerminals = terminalSessions.filter(
    (s) => s.status === "connected"
  ).length;

  const counts: Record<TabId, number> = {
    ports: portForwardSessions.length,
    terminals: activeTerminals,
    jobs: activeJobs.length,
  };

  const totalActive = counts.ports + counts.terminals + counts.jobs;
  const label = activityLabel(counts, useLocale());

  const handleClose = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* Lives in the status bar, so the trigger is a status-bar line and
          not a 36px icon button: the running count is the point. */}
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={t("activity", "panel")}
          // Underlined on hover as well as brightened: on a line where
          // everything else is text that does nothing, colour alone did not
          // read as a control.
          className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-fg-fnt transition-colors hover:text-fg hover:underline hover:decoration-dotted hover:underline-offset-2"
        >
          <Activity className="h-3 w-3" />
          <span className={cn(totalActive > 0 && "tabular-nums")}>{label}</span>
        </button>
      </SheetTrigger>

      {/* The sheet itself is the elevation; everything inside it is back
          on the flat rules — hairlines and alignment, no inner panels. */}
      <SheetContent className="flex w-[400px] flex-col gap-0 p-0 sm:w-[460px]">
        <SheetHeader className="flex-none px-3 py-2">
          <SheetTitle>{t("activity", "title")}</SheetTitle>
        </SheetHeader>

        <div
          role="tablist"
          aria-label={t("activity", "title")}
          className="flex flex-none items-center gap-1 border-b border-hair px-2 pb-1.5"
        >
          {TABS.map((item) => {
            const selected = tab === item.id;
            const count = counts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(item.id)}
                className={cn(
                  "flex items-center gap-[7px] rounded-md px-[9px] py-1 text-xs transition-colors",
                  selected ? "bg-sel text-fg" : "text-fg-mut hover:bg-hover"
                )}
              >
                <item.icon className="h-3.5 w-3.5 text-fg-fnt" />
                {t("activity", item.label)}
                {count > 0 && (
                  <span className="font-mono text-[11px] text-fg-fnt">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {tab === "ports" && <PortForwardsTab />}
          {tab === "terminals" && <TerminalsTab onClose={handleClose} />}
          {tab === "jobs" && <BackgroundJobsTab />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
