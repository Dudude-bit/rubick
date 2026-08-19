import { useMemo, useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { useCopyToClipboard } from "@/hooks";
import { formatBytes } from "@/lib/k8s-quantity";
import { cn } from "@/lib/utils";
import { DetailAction } from "./detail-blocks";
import type { BinaryValue } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { T } from "@/i18n/T";

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
  /**
   * Keys whose bytes are not text. Described by size rather than rendered:
   * a keystore run through a lossy decode is a screenful of replacement
   * characters that reads exactly like a value someone typed. The base64 is
   * offered for copying because `base64 -d` is what the reader wants next.
   */
  binary?: Record<string, BinaryValue>;
  isLoading?: boolean;
  emptyMessage?: string;
}

export function DataSection({
  title,
  data,
  keys = [],
  sensitive = false,
  withheld = {},
  binary = {},
  isLoading = false,
  emptyMessage,
}: DataSectionProps) {
  const t = useT();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const copyToClipboard = useCopyToClipboard();

  const entries = useMemo(() => {
    const names = new Set([
      ...Object.keys(data),
      ...Object.keys(withheld),
      ...Object.keys(binary),
      ...keys,
    ]);
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((key) => ({
        key,
        value: data[key] as string | undefined,
        refusal: withheld[key] as string | undefined,
        blob: binary[key] as BinaryValue | undefined,
      }));
  }, [data, keys, withheld, binary]);

  const toggle = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const readable = entries.filter((entry) => entry.value !== undefined);
  const blobCount = entries.filter((entry) => entry.blob !== undefined).length;
  const allRevealed =
    readable.length > 0 && readable.every((entry) => revealed.has(entry.key));

  // Binary goes in as its base64, never as the lossy text it is not, and the
  // toast says so — a silent substitution is the same lie in a new place.
  const copyAll = () => {
    const payload = {
      ...data,
      ...Object.fromEntries(
        Object.entries(binary).map(([key, blob]) => [key, blob.base64])
      ),
    };
    copyToClipboard(
      JSON.stringify(payload, null, 2),
      blobCount > 0
        ? t("count", "valuesCopiedWithBinary", {
            n: readable.length,
            binary: blobCount,
          })
        : t("count", "allValuesCopied", { n: readable.length })
    );
  };

  if (entries.length === 0) {
    return (
      <Section>
        <SectionHeader title={title ?? t("columns", "data")} count={0} />
        <p className="py-1 text-xs text-fg-fnt">
          {isLoading
            ? t("action", "readingEllipsis")
            : (emptyMessage ?? <T section="empty" k="noDataKeys" />)}
        </p>
      </Section>
    );
  }

  return (
    <Section>
      <SectionHeader
        title={title ?? t("columns", "data")}
        count={
          <>
            {t("count", "keys", { n: entries.length })}
            {sensitive && (
              <span className="text-fg-fnt">
                {" · "}
                {t("empty", "valuesHiddenByDefault")}
              </span>
            )}
          </>
        }
        actions={
          readable.length + blobCount > 0 && (
            <>
              {sensitive && readable.length > 0 && (
                <DetailAction
                  label={
                    allRevealed
                      ? t("action", "hideAll")
                      : t("action", "revealAll")
                  }
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
                label={t("action", "copyAll")}
                icon={Copy}
                onClick={copyAll}
              />
            </>
          )
        }
      />
      <div className="flex flex-col">
        {entries.map(({ key, value, refusal, blob }) => {
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
                    refusal || blob ? "text-fg-mut" : "text-fg-fnt"
                  )}
                >
                  {refusal
                    ? refusal
                    : blob
                      ? t("empty", "binaryNotText", {
                          size: formatBytes(blob.bytes, 0),
                        })
                      : value === undefined
                        ? isLoading
                          ? t("action", "readingInline")
                          : t("empty", "notReadableWithAccess")
                        : t("count", "chars", { n: value.length })}
                </span>
                {(value !== undefined || blob) && (
                  <div className="ml-auto flex items-center gap-1">
                    {sensitive && value !== undefined && (
                      // The word stays on the control: an eye glyph alone is
                      // the difference between "this is hidden" and "this is
                      // empty", and that guess is expensive on a Secret.
                      <DetailAction
                        label={isRevealed ? "Hide" : "Reveal"}
                        icon={isRevealed ? EyeOff : Eye}
                        onClick={() => toggle(key)}
                      />
                    )}
                    {/* Named, because a Copy that silently hands over base64
                        where every other row hands over the value is a
                        surprise the reader finds out about in a shell. */}
                    <DetailAction
                      label={blob ? "Copy base64" : "Copy"}
                      icon={Copy}
                      onClick={() =>
                        blob
                          ? copyToClipboard(
                              blob.base64,
                              t("action", "base64Copied", {
                                key,
                                size: formatBytes(blob.bytes, 0),
                              })
                            )
                          : copyToClipboard(
                              value as string,
                              t("action", "valueCopied", { key })
                            )
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
