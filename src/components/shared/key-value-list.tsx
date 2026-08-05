// src/components/shared/key-value-list.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { MaskedValue } from "@/components/ui/masked-value";
import { Copy, Eye, EyeOff, Key, ShieldAlert } from "lucide-react";
import { useCopyToClipboard } from "@/hooks";

interface KeyValueListProps {
  data: Record<string, string>;
  title?: string;
  /** Whether values should be masked (for secrets) */
  isSensitive?: boolean;
  /** Show sensitive badge */
  showSensitiveBadge?: boolean;
  isLoading?: boolean;
  emptyMessage?: string;
}

export function KeyValueList({
  data,
  title = "Data",
  isSensitive = false,
  showSensitiveBadge = false,
  isLoading = false,
  emptyMessage = "No data defined",
}: KeyValueListProps) {
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const copyToClipboard = useCopyToClipboard();

  const entries = Object.entries(data);

  const toggleReveal = (key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const revealAll = () => {
    setRevealedKeys(new Set(Object.keys(data)));
  };

  const hideAll = () => {
    setRevealedKeys(new Set());
  };

  const handleCopyAll = () => {
    copyToClipboard(
      JSON.stringify(data, null, 2),
      "All data copied to clipboard."
    );
  };

  const handleCopyValue = (key: string, value: string) => {
    copyToClipboard(value, `Value of "${key}" copied to clipboard.`);
  };

  return (
    <Section>
      <SectionHeader
        title={title}
        count={
          showSensitiveBadge && isSensitive ? (
            <span className="flex items-center gap-2">
              {entries.length}
              <Badge variant="outline" className="text-xs">
                <ShieldAlert className="h-3 w-3 mr-1" />
                Sensitive
              </Badge>
            </span>
          ) : (
            entries.length
          )
        }
        actions={
          entries.length > 0 && (
            <>
              {isSensitive && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={revealAll}
                    disabled={isLoading}
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    Reveal All
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={hideAll}
                    disabled={isLoading}
                  >
                    <EyeOff className="h-4 w-4 mr-2" />
                    Hide All
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyAll}
                disabled={isLoading}
              >
                <Copy className="h-4 w-4 mr-2" />
                Copy All
              </Button>
            </>
          )
        }
      />
      <SectionBody className="flex flex-col divide-y divide-hair">
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-col gap-2 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4 text-fg-fnt" />
                <span className="font-medium font-mono text-sm">{key}</span>
                <Badge variant="secondary" className="text-xs">
                  {value.length} chars
                </Badge>
              </div>
              <div className="flex items-center gap-1">
                {isSensitive && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleReveal(key)}
                    disabled={isLoading}
                    className="h-8 w-8 p-0"
                  >
                    {revealedKeys.has(key) ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopyValue(key, value)}
                  disabled={isLoading}
                  className="h-8 w-8 p-0"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {isSensitive ? (
              <MaskedValue
                value={value}
                isRevealed={revealedKeys.has(key)}
                showCopy={false}
                isLoading={isLoading}
              />
            ) : (
              <pre className="bg-hover p-2 rounded text-sm overflow-x-auto whitespace-pre-wrap break-all font-mono">
                {isLoading ? "Loading..." : value}
              </pre>
            )}
          </div>
        ))}
        {entries.length === 0 && !isLoading && (
          <p className="text-fg-mut text-sm py-3">{emptyMessage}</p>
        )}
      </SectionBody>
    </Section>
  );
}
