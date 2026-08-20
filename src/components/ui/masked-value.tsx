// src/components/ui/masked-value.tsx
import { Button } from "@/components/ui/button";
import { Copy, Eye, EyeOff } from "lucide-react";
import { useCopyToClipboard } from "@/hooks";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

interface MaskedValueProps {
  value: string;
  isRevealed: boolean;
  onToggleReveal?: () => void;
  showCopy?: boolean;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  copyLabel?: string;
  /** What the value is, for the copy toast: "Value of DB_PASSWORD copied." */
  label?: string;
  /** Compact mode for table cells */
  compact?: boolean;
}

export function MaskedValue({
  value,
  isRevealed,
  onToggleReveal,
  showCopy = true,
  isLoading = false,
  placeholder = "••••••••",
  className,
  copyLabel,
  label,
  compact = false,
}: MaskedValueProps) {
  const t = useT();
  const copyToClipboard = useCopyToClipboard();
  const displayValue = isRevealed ? value : placeholder;

  const handleCopy = () => {
    copyToClipboard(
      value,
      copyLabel ??
        t("action", "valueCopied", { label: label ?? t("action", "valueNoun") })
    );
  };

  if (compact) {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        <span
          className={cn(
            "font-mono text-xs break-all",
            !isRevealed && "italic text-fg-fnt"
          )}
        >
          {isLoading ? t("settings", "loading") : displayValue}
        </span>
        {onToggleReveal && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleReveal}
            disabled={isLoading}
            className="h-6 w-6 p-0 shrink-0"
          >
            {isRevealed ? (
              <EyeOff className="h-3 w-3" />
            ) : (
              <Eye className="h-3 w-3" />
            )}
          </Button>
        )}
        {showCopy && isRevealed && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            disabled={isLoading}
            className="h-6 w-6 p-0 shrink-0"
          >
            <Copy className="h-3 w-3" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <pre className="flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-hover p-2 font-mono text-xs text-fg-mid">
        {isLoading ? t("settings", "loading") : displayValue}
      </pre>
      <div className="flex items-center gap-1 shrink-0">
        {onToggleReveal && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleReveal}
            disabled={isLoading}
            className="h-8 w-8 p-0"
          >
            {isRevealed ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        )}
        {showCopy && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            disabled={isLoading}
            className="h-8 w-8 p-0"
          >
            <Copy className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
