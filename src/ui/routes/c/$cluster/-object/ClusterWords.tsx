import { useMemo } from "react";

import { clusterWords, type WordKind } from "@/lib/cluster-words";
import { cn } from "@/lib/utils";

/** The YAML editor's own reading of code, so a field path looks the same quoted as in the manifest. */
const PAINT: Record<WordKind, string | null> = {
  prose: null,
  key: "font-medium text-fg",
  string: "text-syn-scalar",
  constant: "text-syn-constant",
  punct: "text-fg-mut",
};

/** Words a cluster wrote, in mono, with the code in them painted as code. */
export function ClusterWords({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const words = useMemo(() => clusterWords(text), [text]);
  return (
    <span className={cn("font-mono wrap-break-word text-fg-mid", className)}>
      {words.map((word) => {
        const paint = PAINT[word.kind];
        return paint ? (
          <span key={word.at} className={paint}>
            {word.text}
          </span>
        ) : (
          word.text
        );
      })}
    </span>
  );
}
