import type { StyledSegment } from "@/generated/types";
import { useIsDark } from "@/lib/use-is-dark";
import { splitByQuery, styleToCss } from "./ansi";

/**
 * The runs of a line, drawn. A search query marks its matches inside
 * each run, so a line keeps its colours while it is being searched.
 */
export function AnsiText({
  segments,
  query = "",
}: {
  segments: readonly StyledSegment[];
  query?: string;
}) {
  const dark = useIsDark();
  return (
    <>
      {segments.map((segment, i) => {
        const text = query ? (
          <Marked text={segment.text} query={query} />
        ) : (
          segment.text
        );
        return segment.style ? (
          <span key={i} style={styleToCss(segment.style, dark)}>
            {text}
          </span>
        ) : (
          <span key={i}>{text}</span>
        );
      })}
    </>
  );
}

/** The text with every match of `query` in a `<mark>`. */
export function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitByQuery(text, query).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-warn/24 px-0.5 text-fg">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}
