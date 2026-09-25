import type { ReportStat } from "@/lib/report";
import type { PlacedSection } from "@/lib/report-parts";
import type { StatusRole } from "@/lib/status-role";

/**
 * What a page adds to the report of the object it shows, from what it has
 * already read: its status, the numbers it leads with, its own sections.
 * Everything every object has (conditions, events, changes, the graph) the
 * frame reads itself.
 */
export interface ShareContribution {
  status?: { text: string; role: StatusRole } | null;
  stats?: ReportStat[];
  verdict?: string | null;
  sections?: PlacedSection[];
  notRead?: string[];
  /** Replaces the frame's own conditions read, where the page knows better. */
  conditions?: PlacedSection | null;
}
