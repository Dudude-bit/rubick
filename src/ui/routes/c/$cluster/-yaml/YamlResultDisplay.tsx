import {
  CheckCircle2,
  HelpCircle,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ResultShown } from "@/stores/yamlEditorStore";
import { cn } from "@/lib/utils";
import { useT, type T } from "@/i18n/useT";

export interface YamlResultDisplayProps {
  result: ResultShown;
}

/** Total on purpose: an apply nobody answered is neither green nor red. */
const LOOK: Record<
  ResultShown["verdict"],
  { icon: LucideIcon; tone: string; word: (t: T) => string }
> = {
  ok: {
    icon: CheckCircle2,
    tone: "text-ok",
    word: (t) => t("settings", "success"),
  },
  failed: {
    icon: XCircle,
    tone: "text-err",
    word: (t) => t("action", "error"),
  },
  unanswered: {
    icon: HelpCircle,
    tone: "text-warn",
    word: (t) => t("action", "applyUnanswered"),
  },
};

/**
 * The outcome of applying a manifest. No tinted panel: the icon and the
 * word carry the result, and the colour only reinforces them — a filled
 * green block on the canvas would be the only surface on the screen.
 */
export function YamlResultDisplay({ result }: YamlResultDisplayProps) {
  const t = useT();
  const { icon: Icon, tone, word } = LOOK[result.verdict];
  return (
    <div
      className="border-t border-hair pt-2 text-xs"
      data-testid="yaml-result"
      data-verdict={result.verdict}
    >
      <p className={cn("flex items-center gap-1.5 font-medium", tone)}>
        <Icon className="h-3.5 w-3.5 flex-none" />
        {word(t)}
      </p>
      {/* Bounded: a line per object squeezed the editor and pushed the
       *  dialog's buttons past the window. */}
      {result.stdout && (
        <pre className="mt-1.5 max-h-40 overflow-y-auto scrollbar-lane whitespace-pre-wrap font-mono text-[11px] text-fg-mid">
          {result.stdout}
        </pre>
      )}
      {result.stderr && (
        <pre
          className={cn(
            "mt-1.5 max-h-40 overflow-y-auto scrollbar-lane whitespace-pre-wrap font-mono text-[11px]",
            result.verdict === "unanswered" ? "text-warn" : "text-err"
          )}
        >
          {result.stderr}
        </pre>
      )}
    </div>
  );
}
