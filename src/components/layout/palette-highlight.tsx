import type { ReactNode } from "react";

import { splitMarks, type ContextMatch } from "@/lib/cluster-search";

/**
 * The name the ladder landed on, with the part the reader typed marked.
 *
 * Unmatched text is dimmed only when there is something to dim it against:
 * with nothing typed yet every name is equally a candidate.
 */
export function highlight(match: ContextMatch): ReactNode {
  return splitMarks(match.matched, match.marks).map((part, index) =>
    part.matched ? (
      <mark key={index} className="rounded-[2px] bg-warn/25 text-fg">
        {part.text}
      </mark>
    ) : (
      <span key={index} className={match.marks.length > 0 ? "text-fg-fnt" : ""}>
        {part.text}
      </span>
    )
  );
}
