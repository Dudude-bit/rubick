import type { T } from "@/i18n/useT";
import { verdictsUnread } from "./route-verdicts";

export interface MapNote {
  text: string;
  tone: "warn" | "mute";
}

/**
 * The lines above the map besides the kinds not read and a search's count,
 * in one list the screen draws and Share and the image carry: a line kept
 * in one of them alone is the map saying one thing and its copy another.
 */
export function mapNotes(
  of: {
    /** Kinds whose edges are absent because they were not read. */
    edgeless: readonly string[];
    vendorUnread: readonly string[];
    /** The failures of the lists route and Gateway verdicts are judged against. */
    routing: { gateways: unknown; classes: unknown };
    /** Other policy engines in force here. */
    others: readonly string[];
    /** Kinds still listing. */
    syncing: readonly string[];
  },
  t: T
): MapNote[] {
  const routing = verdictsUnread(of.routing, t);
  return [
    of.edgeless.length > 0 && {
      text: t("topology", "edgesAbsent", { kinds: of.edgeless.join(", ") }),
      tone: "mute" as const,
    },
    ...of.vendorUnread.map((text) => ({ text, tone: "warn" as const })),
    routing !== null && { text: routing, tone: "warn" as const },
    of.others.length > 0 && {
      text: t("topology", "otherEngines", { kinds: of.others.join(", ") }),
      tone: "mute" as const,
    },
    of.syncing.length > 0 && {
      text: t("topology", "stillListing", { kinds: of.syncing.join(", ") }),
      tone: "mute" as const,
    },
  ].filter((note): note is MapNote => note !== false);
}
