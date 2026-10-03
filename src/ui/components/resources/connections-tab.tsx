import type { T } from "@/i18n/useT";
import { Link2 } from "lucide-react";

import { connectionCount } from "@/lib/connections";
import type { DeliveryQuery } from "@/integrations";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import { countMark, viewGlyph, type DetailTab } from "./detail-tab";
import { ConnectionsPanel } from "./ConnectionsPanel";

/**
 * The Connections tab, identical on the ten pages that have one.
 *
 * A view rather than a kind: it opens onto six kinds at once, so no single
 * kind's glyph or hue would be telling the truth.
 *
 * The mark is a count and never a severity. A stopped chain is the loudest
 * thing this feature knows and it is drawn on the Overview, so a red dot here
 * would send the reader into a tab that does not contain the fault. The count
 * answers what a collection's mark is for: whether this is worth opening.
 */
export function connectionsTab(
  query: ConnectionsQuery,
  t: T,
  /** The subject, so its off-cluster maker can be one of the edges. */
  delivery?: DeliveryQuery | null
): DetailTab {
  return {
    id: "connections",
    label: t("columns", "connections"),
    glyph: viewGlyph(Link2),
    // Deliberately not counting the delivery edge: the mark stands for how
    // many objects are behind the tab, and a commit is not one of them.
    mark: query.data ? countMark(connectionCount(query.data)) : undefined,
    content: <ConnectionsPanel query={query} delivery={delivery ?? null} />,
  };
}
