import type { NodeSilence } from "@/lib/node-reporting";
import type { ReportStat } from "@/lib/report";
import type { PlacedSection } from "@/lib/report-parts";
import type { ChainExtra } from "@/lib/report-graph";
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
  /** What the page hands its own traffic chain, so the file's chain is the same one. */
  chain?: ChainExtra;
}

/** What the frame reads once Share is pressed, so a page need not read it on every visit. */
export interface ShareFrame {
  /** The nodes that stopped reporting; empty when nodes could not be listed. */
  silent: Map<string, NodeSilence>;
  /** When Share was pressed: an age in the file is an age at this moment. */
  capturedAt: string;
}
