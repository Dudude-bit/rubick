import { useCallback, useState, useSyncExternalStore } from "react";

import {
  PEEK_WIDTH_MAX,
  PEEK_WIDTH_MIN,
  useDisplaySettingsStore,
} from "@/stores/displaySettingsStore";

/**
 * How much of the list behind the panel has to survive a resize.
 *
 * A non-modal peek exists so the list stays usable while it is open; a panel
 * dragged over the whole window turns it back into a dialog.
 */
const MIN_LIST_WIDTH = 240;

export function clampPeekWidth(width: number, viewport: number): number {
  const ceiling = Math.max(
    PEEK_WIDTH_MIN,
    Math.min(PEEK_WIDTH_MAX, viewport - MIN_LIST_WIDTH)
  );
  // The second `min` is the escape hatch for a window narrower than the
  // floor: a 300px viewport gets a 300px panel rather than one that hangs
  // off the edge.
  const bounded = Math.min(Math.max(width, PEEK_WIDTH_MIN), ceiling);
  return Math.round(Math.min(bounded, viewport));
}

const subscribeToViewport = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};

export function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeToViewport,
    () => window.innerWidth,
    () => PEEK_WIDTH_MAX
  );
}

export interface PeekWidth {
  width: number;
  min: number;
  max: number;
  /** Live width while a pointer is down — not written to disk. */
  preview: (width: number) => void;
  /** Final width, persisted. */
  commit: (width: number) => void;
}

/**
 * The panel's width, clamped to the window and persisted between launches.
 *
 * A drag emits a width per pointer move; `persist` writes synchronously to
 * localStorage, so only the released width is stored and the frames in
 * between stay in component state.
 */
export function usePeekWidth(): PeekWidth {
  const stored = useDisplaySettingsStore((state) => state.peekWidth);
  const setStored = useDisplaySettingsStore((state) => state.setPeekWidth);
  const viewport = useViewportWidth();
  const [draft, setDraft] = useState<number | null>(null);

  const commit = useCallback(
    (width: number) => {
      setDraft(null);
      setStored(clampPeekWidth(width, viewport));
    },
    [setStored, viewport]
  );

  const preview = useCallback(
    (width: number) => setDraft(clampPeekWidth(width, viewport)),
    [viewport]
  );

  return {
    width: clampPeekWidth(draft ?? stored, viewport),
    min: PEEK_WIDTH_MIN,
    max: clampPeekWidth(PEEK_WIDTH_MAX, viewport),
    preview,
    commit,
  };
}
