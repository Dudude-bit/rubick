import { CheckCircle2, XCircle } from "lucide-react";
import type { ManifestResult } from "@/generated/types";
import { cn } from "@/lib/utils";

export interface YamlResultDisplayProps {
  result: ManifestResult;
}

/**
 * The outcome of applying a manifest. No tinted panel: the icon and the
 * word carry the result, and the colour only reinforces them — a filled
 * green block on the canvas would be the only surface on the screen.
 */
export function YamlResultDisplay({ result }: YamlResultDisplayProps) {
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
        {result.success ? "Success" : "Error"}
      </p>
      {result.stdout && (
        <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] text-fg-mid">
          {result.stdout}
        </pre>
      )}
      {result.stderr && (
        <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] text-err">
          {result.stderr}
        </pre>
      )}
    </div>
  );
}
