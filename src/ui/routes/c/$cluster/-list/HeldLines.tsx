import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { usePeek } from "@/hooks/usePeek";

interface Rest {
  lines: number;
  text: string;
}

/**
 * Text above a list that keeps, while a peek is open, the lines it had
 * without one; the rest ends in an ellipsis and is whole on hover. The peek
 * narrows the page, and a sentence wrapping onto one more line moved every
 * row down under the pointer, so the second click of a double click opened
 * the row above.
 */
export function HeldLines({ children }: { children: ReactNode }) {
  const open = usePeek().target !== null;
  const ref = useRef<HTMLSpanElement>(null);
  const [rest, setRest] = useState<Rest | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || open) return;
    const measure = () => {
      const lines = node.getClientRects().length;
      const text = node.textContent ?? "";
      if (lines > 0)
        setRest((was) =>
          was?.lines === lines && was.text === text ? was : { lines, text }
        );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    // The box around it: an inline box reports no size of its own to observe.
    observer.observe(node.parentElement ?? node);
    return () => observer.disconnect();
  }, [open]);

  const held = open ? rest : null;
  return (
    <span
      ref={ref}
      title={held?.text}
      data-held-lines={held?.lines}
      style={
        held
          ? {
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: held.lines,
              overflow: "hidden",
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}
