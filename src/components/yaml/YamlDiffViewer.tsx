import { CheckCircle2, Loader2 } from "lucide-react";

import { useLineDiff } from "@/hooks/useLineDiff";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

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
  const t = useT();
  const { lines: diffLines, computing } = useLineDiff(original, modified);

  if (computing && diffLines.length === 0) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center gap-1.5 py-8 text-xs text-fg-mut"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {t("empty", "diffComputing")}
      </div>
    );
  }

  const hasChanges = diffLines.some((line) => line.type !== "unchanged");

  if (!hasChanges) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 py-8 text-xs text-fg-mut">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t("empty", "noChangesDetected")}
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
