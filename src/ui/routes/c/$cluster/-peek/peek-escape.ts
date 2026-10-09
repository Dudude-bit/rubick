import { useEffect, useLayoutEffect, useRef } from "react";

const PEEK = "[data-peek]";

const OPEN_LAYER = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
].join(",");

const OWNS_ESCAPE =
  '.xterm, .cm-panel, [role="combobox"][aria-expanded="true"]';

/**
 * Read off the document, not Radix's stack of layers: that stack also counts
 * a layer still mounted after it closed, which took Escape from the peek.
 */
export function escapeTakenElsewhere(target: EventTarget | null): boolean {
  const inFront = Array.from(document.querySelectorAll(OPEN_LAYER)).some(
    (layer) => !layer.closest(PEEK)
  );
  if (inFront) return true;
  return target instanceof Element && target.closest(OWNS_ESCAPE) !== null;
}

/** Escape closes the peek from anywhere, ahead of the row or filter under it, and hands the focus back. */
export function usePeekEscape(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing || escapeTakenElsewhere(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [open]);

  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (open) {
      opener.current = active === document.body ? null : active;
      return;
    }
    const back = opener.current;
    opener.current = null;
    const lost = !active || active === document.body;
    if (back?.isConnected && (lost || active.closest(PEEK)))
      back.focus({ preventScroll: true });
  }, [open]);
}
