import { readCountMark } from "@/components/object/detail-tab";
import type { ObjectRef } from "@/generated/types";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type { T } from "@/i18n/useT";
import { endpointCount, publishedFor } from "@/lib/published";

/** Every address the tab lists, ready or not; nothing while the read is out. */
export function endpointsMark(
  query: ConnectionsQuery,
  service: ObjectRef | null,
  t: T
) {
  if (query.error) return readCountMark(null, t("empty", "publishedUnread"));
  const published =
    query.data && service ? publishedFor(query.data, service) : undefined;
  return readCountMark(published ? endpointCount(published) : null, null);
}
