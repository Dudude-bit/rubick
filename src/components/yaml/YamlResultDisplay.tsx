import { CheckCircle2, XCircle } from "lucide-react";
import type { ManifestResult } from "@/generated/types";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

export interface YamlResultDisplayProps {
  result: ManifestResult;
}

/**
 * The outcome of applying a manifest. No tinted panel: the icon and the
 * word carry the result, and the colour only reinforces them — a filled
 * green block on the canvas would be the only surface on the screen.
 */
export function YamlResultDisplay({ result }: YamlResultDisplayProps) {
  const t = useT();
  return (
    <div className="border-t border-hair pt-2 text-xs">
      <p
        className={cn(
          "flex items-center gap-1.5 font-medium",
          result.success ? "text-ok" : "text-err"
        )}
      >
        {result.success ? (
          <CheckCircle2 className="h-3.5 w-3.5 flex-none" />
        ) : (
          <XCircle className="h-3.5 w-3.5 flex-none" />
        )}
        {result.success ? t("settings", "success") : t("action", "error")}
      </p>
      {/* Bounded, with its own scroller. `kubectl apply` on a big manifest
       *  answers with a line per object, and unbounded this block pushed
       *  the dialog's own buttons past the bottom of the window while
       *  squeezing the editor above it to nothing. */}
      {result.stdout && (
        <pre className="mt-1.5 max-h-40 overflow-y-auto scrollbar-thin whitespace-pre-wrap font-mono text-[11px] text-fg-mid">
          {result.stdout}
        </pre>
      )}
      {result.stderr && (
        <pre className="mt-1.5 max-h-40 overflow-y-auto scrollbar-thin whitespace-pre-wrap font-mono text-[11px] text-err">
          {result.stderr}
        </pre>
      )}
    </div>
  );
}
