import { Anchor, Package } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Which controller owns this release. The two sources differ in glyph and in
 * tooltip, not in hue — neither of them is a problem, and a coloured icon in
 * every row of a table is the loudest thing on the screen.
 */
export function SourceIcon({ source }: { source: string }) {
  const isFlux = source === "flux";
  const Icon = isFlux ? Anchor : Package;
  return (
    <Tooltip>
      <TooltipTrigger>
        <Icon className="h-3.5 w-3.5 text-fg-mut" aria-hidden="true" />
        <span className="sr-only">{isFlux ? "Flux" : "Helm"}</span>
      </TooltipTrigger>
      <TooltipContent>
        {isFlux ? "Flux CD HelmRelease" : "Native Helm release"}
      </TooltipContent>
    </Tooltip>
  );
}
