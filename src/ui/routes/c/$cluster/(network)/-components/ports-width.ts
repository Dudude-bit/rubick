import type { ServicePortInfo } from "@/generated/types";
import { widestText } from "@/lib/text-width";

export const qualifierOf = (port: ServicePortInfo) =>
  [port.name, port.protocol].filter(Boolean).join(" · ");

const mappingOf = (port: ServicePortInfo) =>
  `${port.port}→${port.targetPort}${port.nodePort != null ? `:${port.nodePort}` : ""}`;

/** The 4px gap before the qualifier and a cell's padding. */
const LINE_CHROME_PX = 4 + 20;

const lineEstimate = (port: ServicePortInfo) =>
  mappingOf(port).length * 7.2 + qualifierOf(port).length * 6.2;

/**
 * A ports cell as wide as the widest line its rows show, up to Cilium's
 * `9964→9964 envoy-metrics · TCP`; a longer one ends in an ellipsis.
 */
export function portsCellPx(
  rows: readonly { ports?: ServicePortInfo[] }[],
  maxDisplay: number
): number {
  let widest: ServicePortInfo | null = null;
  for (const row of rows)
    for (const port of row.ports?.slice(0, maxDisplay) ?? [])
      if (!widest || lineEstimate(port) > lineEstimate(widest)) widest = port;
  if (!widest) return 0;
  const cap =
    widestText(["9964→9964"], "mono", 7.2) +
    widestText(["envoy-metrics · TCP"], "caption", 6.2);
  const line =
    widestText([mappingOf(widest)], "mono", 7.2) +
    widestText([qualifierOf(widest)], "caption", 6.2);
  return Math.min(line, cap) + LINE_CHROME_PX;
}
