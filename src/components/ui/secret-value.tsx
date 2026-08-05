import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Copy, Eye, EyeOff, Key, ShieldAlert } from "lucide-react";
import { useCopyToClipboard } from "@/hooks";

interface SecretValueProps {
  /** The actual value (decoded) */
  value: string;
  /** Whether the value is currently revealed */
  isRevealed: boolean;
  /** Callback to toggle reveal state */
  onToggleReveal: () => void;
  /** Whether to show the copy button */
  showCopy?: boolean;
  /** Optional label for the value */
  label?: string;
  /** Whether the component is in a loading state */
  isLoading?: boolean;
  /** Custom placeholder text when hidden */
  placeholder?: string;
}

/**
 * A single secret value with reveal/hide and copy functionality
 */
export function SecretValue({
  value,
  isRevealed,
  onToggleReveal,
  showCopy = true,
  label,
  isLoading = false,
  placeholder = "••••••••••••••••",
}: SecretValueProps) {
  const copyToClipboard = useCopyToClipboard();
  const displayValue = isRevealed ? value : placeholder;

  const handleCopy = () => {
    copyToClipboard(
      value,
      label ? `"${label}" copied to clipboard.` : "Value copied to clipboard."
    );
  };

  return (
    <div className="flex items-center gap-2">
      <pre className="bg-hover p-2 rounded text-sm overflow-x-auto whitespace-pre-wrap break-all font-mono flex-1">
        {isLoading ? "Loading..." : displayValue}
      </pre>
      <div className="flex items-center gap-1 shrink-0">
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

interface SecretKeyValueItemProps {
  /** The key name */
  keyName: string;
  /** The value (decoded) */
  value: string;
  /** Whether the value is revealed */
  isRevealed: boolean;
  /** Toggle reveal for this key */
  onToggleReveal: () => void;
  /** Whether currently loading */
  isLoading?: boolean;
}

/**
 * A single key-value item for secrets with reveal/hide and copy
 */
export function SecretKeyValueItem({
  keyName,
  value,
  isRevealed,
  onToggleReveal,
  isLoading = false,
}: SecretKeyValueItemProps) {
  const copyToClipboard = useCopyToClipboard();
  const displayValue = isRevealed ? value : "••••••••••••••••";

  const handleCopy = () => {
    copyToClipboard(value, `Value of "${keyName}" copied to clipboard.`);
  };

  return (
    <div className="rounded border border-hair p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-fg-mut" />
          <span className="font-medium">{keyName}</span>
          <Badge variant="secondary" className="text-xs">
            {value.length} chars
          </Badge>
        </div>
        <div className="flex items-center gap-1">
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
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            disabled={isLoading}
            className="h-8 w-8 p-0"
          >
            <Copy className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <pre className="bg-hover p-2 rounded text-sm overflow-x-auto whitespace-pre-wrap break-all font-mono">
        {isLoading ? "Loading..." : displayValue}
      </pre>
    </div>
  );
}

interface SecretKeyValueListProps {
  /** Key-value data to display */
  data: Record<string, string>;
  /** Title for the card */
  title?: string;
  /** Whether to show the sensitive badge */
  showSensitiveBadge?: boolean;
  /** Whether currently loading */
  isLoading?: boolean;
  /** Empty state message */
  emptyMessage?: string;
}

/**
 * A list of secret key-value pairs with bulk reveal/hide controls
 */
export function SecretKeyValueList({
  data,
  title = "Data",
  showSensitiveBadge = true,
  isLoading = false,
  emptyMessage = "No data keys defined",
}: SecretKeyValueListProps) {
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

  return (
    <Section>
      <SectionHeader
        title={title}
        count={
          showSensitiveBadge ? (
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
      <SectionBody className="flex flex-col gap-3 pt-3">
        {entries.map(([key, value]) => (
          <SecretKeyValueItem
            key={key}
            keyName={key}
            value={value}
            isRevealed={revealedKeys.has(key)}
            onToggleReveal={() => toggleReveal(key)}
            isLoading={isLoading}
          />
        ))}
        {entries.length === 0 && !isLoading && (
          <p className="text-sm text-fg-mut">{emptyMessage}</p>
        )}
      </SectionBody>
    </Section>
  );
}

interface SecretValueInlineProps {
  /** Whether the value is currently revealed */
  isRevealed: boolean;
  /** Callback to toggle reveal state */
  onToggleReveal: () => void;
  /** Whether the component is in a loading state */
  isLoading?: boolean;
}

/**
 * Compact secret reveal/hide button for use in tables
 */
export function SecretValueInline({
  isRevealed,
  onToggleReveal,
  isLoading = false,
}: SecretValueInlineProps) {
  return (
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
  );
}
