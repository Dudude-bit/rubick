import { useMemo, useState } from "react";
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
import { PortForwardsTab } from "./activity/PortForwardsTab";
import { TerminalsTab } from "./activity/TerminalsTab";
import { BackgroundJobsTab } from "./activity/BackgroundJobsTab";

type TabId = "ports" | "terminals" | "jobs";

const TABS: Array<{
  id: TabId;
  label: string;
  icon: typeof Network;
}> = [
  { id: "ports", label: "Ports", icon: Network },
  { id: "terminals", label: "Terminals", icon: Terminal },
  { id: "jobs", label: "Jobs", icon: Loader2 },
];

export function ActivityPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId>("ports");

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

  const handleClose = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* Lives in the status bar, so the trigger is a status-bar line and
          not a 36px icon button: the running count is the point. */}
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Activity panel"
          className="flex items-center gap-1.5 rounded px-1.5 text-[11px] text-fg-fnt transition-colors hover:text-fg"
        >
          <Activity className="h-3 w-3" />
          <span>{totalActive > 0 ? `${totalActive} active` : "activity"}</span>
        </button>
      </SheetTrigger>

      {/* The sheet itself is the elevation; everything inside it is back
          on the flat rules — hairlines and alignment, no inner panels. */}
      <SheetContent className="flex w-[400px] flex-col gap-0 p-0 sm:w-[460px]">
        <SheetHeader className="flex-none px-3 py-2">
          <SheetTitle>Activity</SheetTitle>
        </SheetHeader>

        <div
          role="tablist"
          aria-label="Activity"
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
                {item.label}
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
          {tab === "ports" && <PortForwardsTab onClose={handleClose} />}
          {tab === "terminals" && <TerminalsTab onClose={handleClose} />}
          {tab === "jobs" && <BackgroundJobsTab />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
