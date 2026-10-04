import { CircleDashed } from "lucide-react";

import {
  getResourceDefinition,
  isResourceType,
  toKind,
} from "@/lib/resource-registry";
import { kindHue } from "@/lib/resource-identity";
import { cn } from "@/lib/utils";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";

/**
 * A kind's glyph in its hue, the mark every reference to an object wears. A
 * kind the registry does not carry still reserves the width, as a dashed
 * circle, so a column of them stays aligned.
 */
export function KindIcon({
  kind,
  className,
  ...rest
}: {
  kind: string;
  className?: string;
  "data-testid"?: string;
}) {
  const colouring = useDisplaySettingsStore((state) => state.resourceColouring);
  const resolved = isResourceType(kind) ? toKind(kind) : null;
  const Icon = resolved ? getResourceDefinition(resolved).icon : CircleDashed;
  return (
    <Icon
      className={cn(
        "flex-none",
        colouring === "off" && "text-fg-mut",
        className
      )}
      style={
        colouring === "off"
          ? undefined
          : { color: `hsl(${kindHue(kind)} var(--kind-s) var(--kind-l))` }
      }
      aria-hidden="true"
      {...rest}
    />
  );
}
