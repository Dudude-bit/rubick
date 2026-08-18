import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

/**
 * A value whose only useful action is being copied — an IP, an address, an
 * identifier you are about to paste into a shell.
 *
 * No toast. A toast is the right weight for something that happened
 * elsewhere or might have failed; copying an address is neither, and one
 * that pops for every click turns a cheap action into an interruption. The
 * confirmation is the glyph swapping in place, next to the thing you copied.
 *
 * The value itself keeps its normal colour. Painting every IP in a table the
 * informational blue would say "these are links" about a whole column, so
 * the affordance is the mark: quiet at rest, underlined on hover, and a real
 * `<button>` so it is reachable and announced without a mouse.
 */

/** Long enough to read, short enough that a second copy is not blocked on it. */
const CONFIRM_MS = 1200;

export interface CopyableValueProps {
  value: string;
  /** What the button announces, e.g. "Pod IP 10.42.0.6". */
  label?: string;
  /**
   * A structured rendering of the same `value` — an image reference split
   * into registry, repository and tag. What is copied is still `value`.
   */
  children?: ReactNode;
  /**
   * For a value sitting inside a sentence, where the mark's reserved width is
   * a hole between two words. It is then drawn only while confirming — and
   * revealing it on hover instead would make the prose jitter under a pointer
   * moving down a feed. What marks it at rest is the underline on hover.
   */
  quietMark?: boolean;
  className?: string;
}

export function CopyableValue({
  value,
  label,
  children,
  quietMark,
  className,
}: CopyableValueProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    // The row underneath usually navigates. Copying an address is not that,
    // and a click that both copies and leaves the page is a click nobody
    // meant to make.
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
    } catch {
      // Clipboard access can be refused. Saying nothing would claim a
      // success that did not happen, so the mark stays in its resting state
      // and the title says what to do instead.
      setCopied(false);
    }
  };

  const Mark = copied ? Check : Copy;

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? t("action", "copied") : `${t("action", "copy")} ${value}`}
      aria-label={`Copy ${label ?? value}`}
      className={cn(
        "group -mx-1 inline-flex min-w-0 items-center gap-1 rounded-sm px-1 font-mono",
        "hover:underline hover:decoration-dotted hover:underline-offset-2",
        "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info",
        className
      )}
    >
      <span className="truncate">{children ?? value}</span>
      {!(quietMark && !copied) && (
        <Mark
          className={cn(
            "h-2.5 w-2.5 flex-none transition-opacity",
            // Reserved width either way, so confirming does not shift the text
            // of every neighbouring row.
            copied
              ? "text-ok opacity-100"
              : "text-fg-fnt opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
          )}
          aria-hidden="true"
          data-testid={copied ? "copyable-confirmed" : "copyable-mark"}
        />
      )}
      <span className="sr-only" role="status">
        {copied ? t("action", "copied") : ""}
      </span>
    </button>
  );
}

export interface CopyableAddressProps {
  value?: string | null;
  /** Field name, e.g. "Pod IP" — the address is appended for the reader. */
  label?: string;
  /** Printed plainly when there is no address. */
  fallback?: string;
  className?: string;
}

/**
 * An address the cluster may not have given out.
 *
 * A headless service reports `clusterIp: "None"`, and a pod that was never
 * scheduled reports nothing at all. Both arrive in this slot as words, and a
 * copy button on a word copies the word — so only a real address gets one.
 */
export function CopyableAddress({
  value,
  label,
  fallback = "—",
  className,
}: CopyableAddressProps) {
  if (!value || value === "None") {
    return <span className="text-fg-fnt">{value || fallback}</span>;
  }
  return (
    <CopyableValue
      value={value}
      label={label ? `${label} ${value}` : undefined}
      className={className}
    />
  );
}

export interface CopyableAddressesProps {
  values: string[];
  label?: string;
  /** Printed plainly when the list is empty. */
  empty?: string;
  className?: string;
}

/**
 * Several addresses on one row. Each is copied on its own: joining them into
 * a single button would put a string nobody can paste on the clipboard.
 */
export function CopyableAddresses({
  values,
  label,
  empty = "—",
  className,
}: CopyableAddressesProps) {
  if (values.length === 0) {
    return <span className="text-fg-fnt">{empty}</span>;
  }
  return (
    <span
      className={cn("inline-flex flex-wrap items-baseline gap-x-1", className)}
    >
      {values.map((value, index) => (
        <Fragment key={`${index}-${value}`}>
          {index > 0 && (
            <span className="text-fg-fnt" aria-hidden="true">
              ·
            </span>
          )}
          <CopyableAddress value={value} label={label} />
        </Fragment>
      ))}
    </span>
  );
}
