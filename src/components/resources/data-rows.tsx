import { useMemo, useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { useCopyToClipboard } from "@/hooks";
import { cn } from "@/lib/utils";
import { DetailAction } from "./detail-blocks";

/**
 * The body of a ConfigMap or a Secret.
 *
 * On these two pages the data *is* the page — everything else is context — so
 * it gets the full width and no competing surface. Each key is a heading with
 * its value indented behind a hairline rule, which is how a flat canvas marks
 * a block without drawing a box around it.
 */

export interface DataSectionProps {
  title?: string;
  /** Decoded key/value pairs. Empty while loading, or when access is refused. */
  data: Record<string, string>;
  /**
   * Keys taken from the object itself. A Secret's values need a second,
   * separately-authorised read, so the list of keys can be known while the
   * values are not — showing the keys beats showing "no data".
   */
  keys?: string[];
  /** Mask every value until the reader asks for it. */
  sensitive?: boolean;
  /**
   * Keys the backend refuses to hand over, and why — a private key, and
   * nothing else so far. Said in the row rather than left to read as "not
   * readable with this access", which would be a different and untrue claim.
   */
  withheld?: Record<string, string>;
  isLoading?: boolean;
  emptyMessage?: string;
}

export function DataSection({
  title = "Data",
  data,
  keys = [],
  sensitive = false,
  withheld = {},
  isLoading = false,
  emptyMessage = "No data keys",
}: DataSectionProps) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const copyToClipboard = useCopyToClipboard();

  const entries = useMemo(() => {
    const names = new Set([
      ...Object.keys(data),
      ...Object.keys(withheld),
      ...keys,
    ]);
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((key) => ({
        key,
        value: data[key] as string | undefined,
        refusal: withheld[key] as string | undefined,
      }));
  }, [data, keys, withheld]);

  const toggle = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const readable = entries.filter((entry) => entry.value !== undefined);
  const allRevealed =
    readable.length > 0 && readable.every((entry) => revealed.has(entry.key));

  if (entries.length === 0) {
    return (
      <Section>
        <SectionHeader title={title} count={0} />
        <p className="py-1 text-xs text-fg-fnt">
          {isLoading ? "Reading…" : emptyMessage}
        </p>
      </Section>
    );
  }

  return (
    <Section>
      <SectionHeader
        title={title}
        count={
          <>
            {entries.length} {entries.length === 1 ? "key" : "keys"}
            {sensitive && (
              <span className="text-fg-fnt"> · values hidden by default</span>
            )}
          </>
        }
        actions={
          readable.length > 0 && (
            <>
              {sensitive && (
                <DetailAction
                  label={allRevealed ? "Hide all" : "Reveal all"}
                  icon={allRevealed ? EyeOff : Eye}
                  onClick={() =>
                    setRevealed(
                      allRevealed
                        ? new Set()
                        : new Set(readable.map((entry) => entry.key))
                    )
                  }
                />
              )}
              <DetailAction
                label="Copy all"
                icon={Copy}
                onClick={() =>
                  copyToClipboard(
                    JSON.stringify(data, null, 2),
                    `All ${entries.length} values copied.`
                  )
                }
              />
            </>
          )
        }
      />
      <div className="flex flex-col">
        {entries.map(({ key, value, refusal }) => {
          const isRevealed = !sensitive || revealed.has(key);
          return (
            <div
              key={key}
              className="border-b border-hair py-2 last:border-b-0"
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 break-all font-mono text-xs font-medium text-fg">
                  {key}
                </span>
                <span
                  className={cn(
                    "text-[11px]",
                    refusal ? "text-fg-mut" : "text-fg-fnt"
                  )}
                >
                  {refusal
                    ? refusal
                    : value === undefined
                      ? isLoading
                        ? "reading…"
                        : "not readable with this access"
                      : `${value.length} chars`}
                </span>
                {value !== undefined && (
                  <div className="ml-auto flex items-center gap-1">
                    {sensitive && (
                      // The word stays on the control: an eye glyph alone is
                      // the difference between "this is hidden" and "this is
                      // empty", and that guess is expensive on a Secret.
                      <DetailAction
                        label={isRevealed ? "Hide" : "Reveal"}
                        icon={isRevealed ? EyeOff : Eye}
                        onClick={() => toggle(key)}
                      />
                    )}
                    <DetailAction
                      label="Copy"
                      icon={Copy}
                      onClick={() =>
                        copyToClipboard(value, `Value of ${key} copied.`)
                      }
                    />
                  </div>
                )}
              </div>
              {value !== undefined && (
                <pre
                  className={cn(
                    "mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all border-l border-hair pl-3 font-mono text-xs",
                    isRevealed ? "text-fg-mid" : "text-fg-fnt"
                  )}
                >
                  {isRevealed ? value : "•".repeat(Math.min(value.length, 32))}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
