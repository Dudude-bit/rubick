import { kindMark } from "@/lib/resource-identity";
import type { ResourceKind } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";

/**
 * A kind's glyph in its hue, the mark every reference to an object wears. A
 * kind the registry does not carry still reserves the width, as a dashed
 * circle, so a column of them stays aligned.
 */
export function KindIcon({
  kind,
  crd,
  className,
  ...rest
}: (
  | { kind: ResourceKind; crd?: undefined }
  | { kind: string; crd: string | null | undefined }
) & {
  className?: string;
  "data-testid"?: string;
}) {
  const colouring = useDisplaySettingsStore((state) => state.resourceColouring);
  const { Icon, hue } = kindMark({ kind, crd });
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
          : { color: `hsl(${hue} var(--kind-s) var(--kind-l))` }
      }
      aria-hidden="true"
      {...rest}
    />
  );
}
