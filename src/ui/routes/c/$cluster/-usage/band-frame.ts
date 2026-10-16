/**
 * The frame every usage and traffic band is drawn in, shared so a chart and
 * the Suspense placeholder that holds its place keep one height. Kept free
 * of recharts, which the bands load lazily.
 */

import * as React from "react";

/**
 * Tall enough to read a shape off. The 42px band this replaces turned every
 * series into a flat rule: at that height a doubling of load is four pixels.
 */
export const BAND_H = 56;

/**
 * Room above the plot for the limit label — it sits above its own rule, and
 * the rule sits at the top of the scale whenever a limit exists — one pixel
 * below so the baseline hairline is a line rather than the bottom row of the
 * fill, and three at the right so the newest reading is a whole dot rather
 * than the half of one the frame did not cut off.
 */
export const BAND_MARGIN = { top: 13, right: 3, bottom: 1, left: 0 };

/** Drawn at this width until the band has been measured — and in jsdom,
 *  where nothing is laid out, for the whole life of the test. */
const ASSUMED_W = 600;

/** The band's own width in pixels, which is what recharts needs and CSS
 *  will not tell it. */
export function useBandWidth(): [
  React.RefObject<HTMLDivElement | null>,
  number,
] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(ASSUMED_W);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.round(entries[0]?.contentRect.width ?? 0);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(node);
    const initial = Math.round(node.getBoundingClientRect().width);
    if (initial > 0) setWidth(initial);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
