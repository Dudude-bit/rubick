import { History } from "lucide-react";

import { ObjectChanges, type ObjectChangesSubject } from "./ObjectChanges";
import { viewGlyph, type DetailTab } from "@/components/object/detail-tab";
import type { T } from "@/i18n/useT";

/**
 * Every object page's Changes tab, under the id a `?tab=changes&since=…`
 * link opens: what the timeline recorded of the object and the cluster's
 * events about it. `null` until the object is read.
 */
export function changesTab(
  subject: ObjectChangesSubject | null,
  t: T
): DetailTab {
  return {
    id: "changes",
    label: t("changes", "title"),
    glyph: viewGlyph(History),
    content: subject ? <ObjectChanges subject={subject} /> : null,
  };
}
