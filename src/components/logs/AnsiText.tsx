import type { StyledSegment } from "@/generated/types";
import { styleToCss, useIsDark } from "./ansi";

export function AnsiText({ segments }: { segments: readonly StyledSegment[] }) {
  const dark = useIsDark();
  return (
    <>
      {segments.map((segment, i) =>
        segment.style ? (
          <span key={i} style={styleToCss(segment.style, dark)}>
            {segment.text}
          </span>
        ) : (
          segment.text
        )
      )}
    </>
  );
}
