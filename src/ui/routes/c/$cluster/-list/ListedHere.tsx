import { CornerDownRight } from "lucide-react";
import type { ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { useAppSearchValue } from "@/hooks/useSearchParam";
import { parts } from "@/i18n/parts";
import { useT, type T } from "@/i18n/useT";
import {
  listedElsewhere,
  listSegment,
  type ResourceKind,
} from "@/lib/resource-registry";

const place = (words: string) => (
  <span className="font-semibold text-fg">{words}</span>
);

/** Where on this list a kind with none of its own is found. */
const LISTED_HERE: Partial<Record<ResourceKind, (t: T) => ReactNode>> = {
  ReplicaSet: (t) =>
    parts(t("attached", "replicaSetsListedHere"), {
      tab: place(t("nav", "revisions")),
    }),
  GatewayClass: (t) =>
    parts(t("attached", "gatewayClassesListedHere"), {
      column: place(t("columns", "class")),
    }),
};

/** On a list a link to another kind's list landed on: why, and where that kind is. */
export function ListedHere({ kind }: { kind: ResourceKind | null }) {
  const t = useT();
  const asked = listedElsewhere(useAppSearchValue("listOf") ?? "");
  const words = asked && LISTED_HERE[asked];
  if (!asked || !words || !kind || listSegment(asked) !== listSegment(kind))
    return null;
  return (
    <Alert role="status" variant="info" className="mb-3">
      <CornerDownRight />
      <span>{words(t)}</span>
    </Alert>
  );
}
