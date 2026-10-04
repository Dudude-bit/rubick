import {
  ChevronRight,
  EyeOff,
  GitFork,
  HelpCircle,
  MoreHorizontal,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import { Fragment } from "react";

import type { LineageStop } from "@/generated/types";
import { ResourceRef } from "@/components/object/ResourceRef";
import { useT, type T } from "@/i18n/useT";
import { cn } from "@/lib/utils";
import { crdOf, useLineage } from "./ownership";
import type { ServedResource } from "./served";

/** Why the chain stops, drawn. Every stop has its own glyph and tone. */
const STOP: Record<LineageStop["says"], { icon: LucideIcon; tone: string }> = {
  ownerGone: { icon: Unlink, tone: "text-warn" },
  ownerUnread: { icon: EyeOff, tone: "text-warn" },
  kindNotServed: { icon: HelpCircle, tone: "text-fg-mut" },
  several: { icon: GitFork, tone: "text-fg-mut" },
  tooDeep: { icon: MoreHorizontal, tone: "text-fg-mut" },
};

function stopWords(stop: LineageStop, t: T): string {
  switch (stop.says) {
    case "ownerGone":
      return t("lineage", "ownerGone", { kind: stop.kind, name: stop.name });
    case "ownerUnread":
      return t("lineage", "ownerUnread", { kind: stop.kind, name: stop.name });
    case "kindNotServed":
      return t("lineage", "kindNotServed", { kind: stop.kind });
    case "several":
      return t("lineage", "several");
    case "tooDeep":
      return t("lineage", "tooDeep");
  }
}

const Separator = () => (
  <ChevronRight className="h-3 w-3 flex-none text-fg-fnt" aria-hidden="true" />
);

/**
 * The controllers above this object, top first, each a reference with its
 * kind's glyph, on its own line over the title. Where the chain stops short
 * of the top it says why at the left end: an owner that is gone and one that
 * could not be read are different words and different marks. Nothing is
 * drawn for an object nothing owns.
 */
export function LineageTrail({
  served,
  name,
  namespace,
}: {
  served: ServedResource | null;
  name: string;
  namespace?: string | null;
}) {
  const t = useT();
  const lineage = useLineage(served, name, namespace);
  const data = lineage.data;
  if (!data || (data.ancestors.length === 0 && !data.stop)) return null;
  const top = [...data.ancestors].reverse();
  const stop = data.stop ? STOP[data.stop.says] : null;
  const StopIcon = stop?.icon;

  return (
    <nav
      aria-label={t("lineage", "label")}
      className="flex basis-full flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]"
    >
      {data.stop && stop && StopIcon && (
        <span
          className={cn("inline-flex items-center gap-1", stop.tone)}
          title={
            data.stop.says === "ownerUnread" ? data.stop.message : undefined
          }
        >
          <StopIcon className="h-3 w-3" aria-hidden="true" />
          {stopWords(data.stop, t)}
        </span>
      )}
      {top.map((ancestor, index) => (
        <Fragment key={ancestor.uid}>
          {(index > 0 || data.stop) && <Separator />}
          <ResourceRef
            kind={ancestor.kind}
            name={ancestor.name}
            namespace={ancestor.namespace}
            crd={crdOf(ancestor)}
          />
        </Fragment>
      ))}
      <Separator />
    </nav>
  );
}
