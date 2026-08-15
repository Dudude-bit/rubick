import { useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNumber: number;
}

interface LCSMatch {
  origIdx: number;
  modIdx: number;
}

function computeLCS(original: string[], modified: string[]): LCSMatch[] {
  const m = original.length;
  const n = modified.length;

  // Create DP table
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (original[i - 1] === modified[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matches
  const matches: LCSMatch[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (original[i - 1] === modified[j - 1]) {
      matches.unshift({ origIdx: i - 1, modIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

function computeDiff(original: string, modified: string): DiffLine[] {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  const result: DiffLine[] = [];

  const lcs = computeLCS(originalLines, modifiedLines);

  let origIdx = 0;
  let modIdx = 0;
  let lineNum = 1;

  for (const match of lcs) {
    // Add removed lines
    while (origIdx < match.origIdx) {
      result.push({
        type: "removed",
        content: originalLines[origIdx],
        lineNumber: lineNum++,
      });
      origIdx++;
    }

    // Add added lines
    while (modIdx < match.modIdx) {
      result.push({
        type: "added",
        content: modifiedLines[modIdx],
        lineNumber: lineNum++,
      });
      modIdx++;
    }

    // Add unchanged line
    result.push({
      type: "unchanged",
      content: originalLines[origIdx],
      lineNumber: lineNum++,
    });
    origIdx++;
    modIdx++;
  }

  // Add remaining removed lines
  while (origIdx < originalLines.length) {
    result.push({
      type: "removed",
      content: originalLines[origIdx],
      lineNumber: lineNum++,
    });
    origIdx++;
  }

  // Add remaining added lines
  while (modIdx < modifiedLines.length) {
    result.push({
      type: "added",
      content: modifiedLines[modIdx],
      lineNumber: lineNum++,
    });
    modIdx++;
  }

  return result;
}

export interface YamlDiffViewerProps {
  original: string;
  modified: string;
  height?: string;
}

export function YamlDiffViewer({
  original,
  modified,
  height = "500px",
}: YamlDiffViewerProps) {
  const diffLines = useMemo(
    () => computeDiff(original, modified),
    [original, modified]
  );

  const hasChanges = diffLines.some((line) => line.type !== "unchanged");

  if (!hasChanges) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 py-8 text-xs text-fg-mut">
        <CheckCircle2 className="h-3.5 w-3.5" />
        No changes detected
      </div>
    );
  }

  return (
    <div
      className="overflow-auto border-t border-hair py-1 font-mono text-xs"
      style={{ height }}
    >
      {diffLines.map((line, idx) => (
        <div
          key={idx}
          className={cn(
            "flex gap-2 px-2",
            line.type === "added" && "bg-ok/16 text-ok",
            line.type === "removed" && "bg-err/16 text-err",
            line.type === "unchanged" && "text-fg-mid"
          )}
        >
          {/* The gutter is the cue that survives without hue — a diff
              read in greyscale still has to say which side a line is on. */}
          <span
            className={cn(
              "w-2 flex-none",
              line.type === "unchanged" && "text-fg-fnt"
            )}
          >
            {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
          </span>
          <span className="whitespace-pre">{line.content}</span>
        </div>
      ))}
    </div>
  );
}
