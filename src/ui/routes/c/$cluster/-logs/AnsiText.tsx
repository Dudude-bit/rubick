import type { StyledSegment } from "@/generated/types";
import { useIsDark } from "@/lib/use-is-dark";
import { skipsOf, splitByQuery, styleToCss } from "./ansi";

/**
 * The runs of a line, drawn. A search query marks its matches inside
 * each run, so a line keeps its colours while it is being searched.
 */
export function AnsiText({
  segments,
  query = "",
  skip = 0,
}: {
  segments: readonly StyledSegment[];
  query?: string;
  skip?: number;
}) {
  const dark = useIsDark();
  const skips = skipsOf(segments, skip);
  return (
    <>
      {segments.map((segment, i) => {
        const text = query ? (
          <Marked text={segment.text} query={query} skip={skips[i]} />
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

/** The text with every match of `query` in a `<mark>`, past its first `skip` characters. */
export function Marked({
  text,
  query,
  skip = 0,
}: {
  text: string;
  query: string;
  skip?: number;
}) {
  return (
    <>
      {text.slice(0, skip)}
      {splitByQuery(text.slice(skip), query).map((part, i) =>
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
