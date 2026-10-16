import { readCountMark } from "@/components/object/detail-tab";
import type { ConnectionsRead } from "@/hooks/useConnections";
import type { T } from "@/i18n/useT";
import { endpointCount, publishedFor } from "@/lib/published";

/** Every address the tab lists, ready or not; nothing while the read is out. */
export function endpointsMark(query: ConnectionsRead, t: T) {
  if (query.error) return readCountMark(null, t("empty", "publishedUnread"));
  const published = query.data && publishedFor(query.data, query.data.subject);
  return readCountMark(published ? endpointCount(published) : null, null);
}
