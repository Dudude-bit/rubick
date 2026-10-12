import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { usePeek } from "@/hooks/usePeek";

interface Rest {
  lines: number;
  height?: number;
  text: string;
}

/**
 * Text above a list that keeps, while the peek is in the other state from
 * the one the page opened in, the lines it had then: cut to them with the
 * rest on hover, or holding their room. The peek narrows the page, and a
 * sentence wrapping onto one more line moved every row down under the
 * pointer, so the second click of a double click opened the row above.
 */
export function HeldLines({ children }: { children: ReactNode }) {
  const open = usePeek().target !== null;
  const [home] = useState(open);
  const away = open !== home;
  const ref = useRef<HTMLSpanElement>(null);
  const [rest, setRest] = useState<Rest | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || away) return;
    const measure = () => {
      const lines = node.getClientRects().length;
      const text = node.textContent ?? "";
      const lineHeight = parseFloat(getComputedStyle(node).lineHeight);
      const height = Number.isFinite(lineHeight)
        ? lines * lineHeight
        : undefined;
      if (lines > 0)
        setRest((was) =>
          was?.lines === lines && was.height === height && was.text === text
            ? was
            : { lines, height, text }
        );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    // The box around it: an inline box reports no size of its own to observe.
    observer.observe(node.parentElement ?? node);
    return () => observer.disconnect();
  }, [away]);

  const held = away ? rest : null;
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
              // WebKitGTK draws a second line under a one-line clamp ending in an inline-flex link.
              height: held.height,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}
